// Worker Manager - Manages lifecycle of RPC worker processes

import type { RpcFile } from "./load_rpc_files.ts";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import type { Subprocess } from "bun";

// Inline worker code to avoid path resolution issues in compiled binaries
const RPC_WORKER_CODE = `
// RPC Worker - Long-running process that executes RPC functions
// One worker per RPC file, communicates with main server via WebSocket

interface CallMessage {
  type: "call";
  id: string;
  functionName: string;
  args: unknown;
}

interface ShutdownMessage {
  type: "shutdown";
}

type WorkerMessage = CallMessage | ShutdownMessage;

async function main() {
  // Parse CLI arguments (Bun uses process.argv)
  const rpcFilePath = process.argv[2];
  const workerWsUrl = process.argv[3];
  const namespace = process.argv[4];

  if (!rpcFilePath || !workerWsUrl || !namespace) {
    console.error("Usage: rpc_worker.ts <rpcFilePath> <workerWsUrl> <namespace>");
    process.exit(1);
  }

  // Import all functions from RPC file
  const functions = await import(rpcFilePath);

  // Connect to main server
  const ws = new WebSocket(workerWsUrl);

  ws.onopen = () => {
    // Identify ourselves
    ws.send(JSON.stringify({
      type: "identify",
      workerId: namespace,
    }));

    // Signal ready
    ws.send(JSON.stringify({
      type: "ready",
      workerId: namespace,
    }));
  };

  ws.onmessage = async (event) => {
    try {
      const msg: WorkerMessage = JSON.parse(
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(new Uint8Array(event.data as ArrayBuffer))
      );

      if (msg.type === "call") {
        const { id, functionName, args } = msg;

        try {
          // Get the function
          const fn = functions[functionName];

          if (typeof fn !== "function") {
            throw new Error(\`Function '\${functionName}' not found or not exported\`);
          }

          // Set up progress callback if the module supports it
          // This allows long-running functions to send progress updates
          if (typeof functions.setProgressCallback === "function") {
            functions.setProgressCallback((message: string) => {
              ws.send(JSON.stringify({
                type: "progress",
                id,
                message,
              }));
            });
          }

          // Execute with extended timeout (5 minutes for streaming operations)
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Function execution timeout (5m)")), 300000);
          });

          const result = await Promise.race([
            fn(args),
            timeoutPromise,
          ]);

          // Clear progress callback
          if (typeof functions.setProgressCallback === "function") {
            functions.setProgressCallback(null);
          }

          // Send result back
          ws.send(JSON.stringify({
            type: "result",
            id,
            data: result,
          }));
        } catch (error) {
          // Clear progress callback on error
          if (typeof functions.setProgressCallback === "function") {
            functions.setProgressCallback(null);
          }

          // Send error back
          ws.send(JSON.stringify({
            type: "error",
            id,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      } else if (msg.type === "shutdown") {
        console.error(\`[Worker \${namespace}] Received shutdown signal\`);
        ws.close();
        process.exit(0);
      }
    } catch (error) {
      console.error(\`[Worker \${namespace}] Error handling message:\`, error);
    }
  };

  ws.onerror = (error) => {
    // Suppress "Unexpected EOF" errors on shutdown
    const errorEvent = error as ErrorEvent;
    if (!errorEvent.message?.includes("Unexpected EOF")) {
      console.error(\`[Worker \${namespace}] WebSocket error:\`, error);
    }
  };

  ws.onclose = () => {
    // Silent exit on close
    process.exit(0);
  };

  // Handle uncaught errors
  process.on("uncaughtException", (error) => {
    console.error(\`[Worker \${namespace}] Uncaught error:\`, error);

    try {
      ws.send(JSON.stringify({
        type: "crash",
        error: error?.message || String(error),
      }));
    } catch {
      // Best effort
    }

    ws.close();
    process.exit(1);
  });

  // Handle unhandled promise rejections
  process.on("unhandledRejection", (reason) => {
    console.error(\`[Worker \${namespace}] Unhandled rejection:\`, reason);

    try {
      ws.send(JSON.stringify({
        type: "crash",
        error: (reason as Error)?.message || String(reason),
      }));
    } catch {
      // Best effort
    }

    ws.close();
    process.exit(1);
  });
}

main();
`;

// Progress callback type
type ProgressCallback = (callId: string, message: string) => void;

interface WorkerState {
  process: Subprocess;
  sendMessage?: (message: string) => void; // Callback to send messages to worker
  workerId: string;
  filePath: string;
  status: "starting" | "ready" | "crashed" | "failed";
  pendingCalls: Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeoutId: ReturnType<typeof setTimeout>;
      clientCallId?: string; // Original call ID from client for progress routing
    }
  >;
  restartCount: number;
  lastRestart: number;
  everReady: boolean; // Track if worker ever successfully started
}

interface IdentifyMessage {
  type: "identify";
  workerId: string;
}

interface ReadyMessage {
  type: "ready";
  workerId: string;
}

interface ResultMessage {
  type: "result";
  id: string;
  data: unknown;
}

interface ErrorMessage {
  type: "error";
  id: string;
  error: string;
}

interface CrashMessage {
  type: "crash";
  error: string;
}

interface ProgressMessage {
  type: "progress";
  id: string;
  message: string;
}

type WorkerIncomingMessage =
  | IdentifyMessage
  | ReadyMessage
  | ResultMessage
  | ErrorMessage
  | CrashMessage
  | ProgressMessage;

export class WorkerManager {
  private workers = new Map<string, WorkerState>();
  private port: number;
  private progressCallback?: ProgressCallback;

  constructor(port: number) {
    this.port = port;
  }

  /**
   * Set a callback to receive progress updates from workers
   * Progress updates include the original client call ID for routing
   */
  setProgressCallback(callback: ProgressCallback | undefined): void {
    this.progressCallback = callback;
  }

  /**
   * Start a worker process for an RPC file
   */
  async startWorker(file: RpcFile): Promise<void> {
    const workerId = file.name;

    // Write worker code to temp file
    const tempFile = join(tmpdir(), `lootbox_worker_${randomUUID()}.ts`);
    await Bun.write(tempFile, RPC_WORKER_CODE);

    // Spawn worker process using Bun
    const workerWsUrl = `ws://localhost:${this.port}/worker-ws`;
    const proc = Bun.spawn(["bun", "run", tempFile, file.path, workerWsUrl, workerId], {
      stdout: "pipe",
      stderr: "inherit", // Show worker logs in main process
    });

    // Create worker state
    const worker: WorkerState = {
      process: proc,
      workerId,
      filePath: file.path,
      status: "starting",
      pendingCalls: new Map(),
      restartCount: 0,
      lastRestart: Date.now(),
      everReady: false,
    };

    this.workers.set(workerId, worker);

    // Monitor process exit
    proc.exited.then((exitCode) => {
      if (exitCode !== 0) {
        console.error(
          `[WorkerManager] Worker ${workerId} exited with code ${exitCode}`
        );
        this.handleWorkerCrash(workerId);
      }
    });
  }

  /**
   * Register a send callback for a worker
   */
  registerWorkerSender(
    workerId: string,
    sendMessage: (message: string) => void
  ): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.sendMessage = sendMessage;
    }
  }

  /**
   * Handle incoming message from worker
   */
  handleMessage(data: string): void {
    try {
      const msg: WorkerIncomingMessage = JSON.parse(data);

      if (msg.type === "identify") {
        const workerId = msg.workerId;
        const worker = this.workers.get(workerId);

        if (!worker) {
          console.error(
            `[WorkerManager] Unknown worker identified: ${workerId}`
          );
          return;
        }

      } else if (msg.type === "ready") {
        const workerId = msg.workerId;
        const worker = this.workers.get(workerId);

        if (worker) {
          worker.status = "ready";
          worker.everReady = true;
        }
      } else if (msg.type === "result") {
        // Find worker by searching for the pending call
        for (const worker of this.workers.values()) {
          const pending = worker.pendingCalls.get(msg.id);
          if (pending) {
            clearTimeout(pending.timeoutId);
            pending.resolve(msg.data);
            worker.pendingCalls.delete(msg.id);
            return;
          }
        }
      } else if (msg.type === "error") {
        // Find worker by searching for the pending call
        for (const worker of this.workers.values()) {
          const pending = worker.pendingCalls.get(msg.id);
          if (pending) {
            clearTimeout(pending.timeoutId);
            pending.reject(new Error(msg.error));
            worker.pendingCalls.delete(msg.id);
            return;
          }
        }
      } else if (msg.type === "progress") {
        // Progress message - reset the timeout for the pending call
        // This allows long-running operations to continue without timing out
        for (const worker of this.workers.values()) {
          const pending = worker.pendingCalls.get(msg.id);
          if (pending) {
            // Clear the old timeout and set a new one
            clearTimeout(pending.timeoutId);
            pending.timeoutId = setTimeout(() => {
              worker.pendingCalls.delete(msg.id);
              pending.reject(
                new Error(`RPC call timeout after progress (no update for 60s)`)
              );
            }, 60000); // 60 second timeout after each progress update

            // Forward progress to client using the original client call ID
            if (this.progressCallback && pending.clientCallId) {
              this.progressCallback(pending.clientCallId, msg.message);
            }
            return;
          }
        }
      } else if (msg.type === "crash") {
        // Find worker - we need to track which worker sent this
        // For now, log and let process monitoring handle it
        console.error(`[WorkerManager] Worker crashed: ${msg.error}`);
      }
    } catch (error) {
      console.error(`[WorkerManager] Error handling message:`, error);
    }
  }

  /**
   * Handle worker disconnection
   */
  handleDisconnect(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.sendMessage = undefined;
    }
  }

  /**
   * Call a function on a worker
   * @param namespace - The worker namespace (tool name)
   * @param functionName - The function to call
   * @param args - Arguments to pass to the function
   * @param clientCallId - Optional original call ID from client for progress routing
   */
  async callFunction(
    namespace: string,
    functionName: string,
    args: unknown,
    clientCallId?: string
  ): Promise<unknown> {
    const worker = this.workers.get(namespace);

    if (!worker) {
      throw new Error(`Worker for namespace '${namespace}' not found`);
    }

    if (worker.status === "failed") {
      throw new Error(
        `Worker for namespace '${namespace}' failed to start. Check the tool file for errors.`
      );
    }

    if (worker.status !== "ready") {
      throw new Error(
        `Worker for namespace '${namespace}' is not ready (status: ${worker.status})`
      );
    }

    if (!worker.sendMessage) {
      throw new Error(
        `Worker for namespace '${namespace}' has no send callback`
      );
    }

    // Generate unique call ID
    const callId = `call_${Date.now()}_${Math.random()
      .toString(36)
      .substring(2)}`;

    // Create promise for response
    const resultPromise = new Promise<unknown>((resolve, reject) => {
      // Timeout after 30 seconds (will be extended on progress updates)
      const timeoutId = setTimeout(() => {
        worker.pendingCalls.delete(callId);
        reject(
          new Error(
            `RPC call timeout: ${namespace}.${functionName} (30 seconds)`
          )
        );
      }, 30000);

      worker.pendingCalls.set(callId, { resolve, reject, timeoutId, clientCallId });
    });

    // Send call message
    worker.sendMessage(
      JSON.stringify({
        type: "call",
        id: callId,
        functionName,
        args,
      })
    );

    return resultPromise;
  }

  /**
   * Handle worker crash
   */
  private handleWorkerCrash(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    // Reject all pending calls
    for (const [callId, pending] of worker.pendingCalls) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(`Worker ${workerId} crashed`));
    }
    worker.pendingCalls.clear();

    // If worker never successfully started, mark as permanently failed
    if (!worker.everReady) {
      worker.status = "failed";
      console.error(
        `[WorkerManager] Worker ${workerId} failed to start - not retrying. Check the tool file for errors.`
      );
      return;
    }

    // Worker was previously healthy, attempt restart with backoff
    worker.status = "crashed";
    const backoffMs = Math.min(1000 * Math.pow(2, worker.restartCount), 30000);
    worker.restartCount++;

    console.error(
      `[WorkerManager] Will restart worker ${workerId} in ${backoffMs}ms (attempt ${worker.restartCount})`
    );

    // Schedule restart
    setTimeout(() => {
      const file: RpcFile = {
        name: workerId,
        path: worker.filePath,
      };
      this.startWorker(file);
    }, backoffMs);
  }

  /**
   * Restart a worker (for hot reload)
   */
  async restartWorker(workerId: string, file: RpcFile): Promise<void> {
    const worker = this.workers.get(workerId);

    if (worker?.sendMessage) {
      console.error(
        `[WorkerManager] Shutting down worker ${workerId} for reload`
      );

      // Send shutdown signal
      try {
        worker.sendMessage(JSON.stringify({ type: "shutdown" }));
      } catch {
        // Best effort
      }

      // Wait a bit for graceful shutdown
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Force kill if still alive
      try {
        worker.process.kill(9); // SIGKILL
      } catch {
        // Already dead
      }

      // Clean up
      worker.sendMessage = undefined;
      this.workers.delete(workerId);
    }

    // Start new worker
    await this.startWorker(file);
  }

  /**
   * Wait for all workers to be ready
   */
  async waitForReady(timeoutMs: number): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const allSettled = Array.from(this.workers.values()).every(
        (w) => w.status === "ready" || w.status === "failed"
      );

      if (allSettled) {
        const ready = Array.from(this.workers.values()).filter(
          (w) => w.status === "ready"
        );
        const failed = Array.from(this.workers.values()).filter(
          (w) => w.status === "failed"
        );

        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const notReady = Array.from(this.workers.values()).filter(
      (w) => w.status !== "ready" && w.status !== "failed"
    );

    console.error(
      `[WorkerManager] Timeout waiting for workers. Not ready: ${notReady
        .map((w) => w.workerId)
        .join(", ")}`
    );
  }

  /**
   * Stop all workers
   */
  async stopAllWorkers(): Promise<void> {
    for (const worker of this.workers.values()) {
      if (worker.sendMessage) {
        try {
          worker.sendMessage(JSON.stringify({ type: "shutdown" }));
        } catch {
          // Best effort
        }
      }

      try {
        worker.process.kill(15); // SIGTERM
      } catch {
        // Already dead
      }
    }

    this.workers.clear();
  }
}
