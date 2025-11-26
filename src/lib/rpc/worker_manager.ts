// Worker Manager - Manages lifecycle of RPC worker processes

import type { RpcFile } from "./load_rpc_files.ts";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import type { Subprocess } from "bun";

// Inline worker code using IPC (not WebSocket) to avoid CPU spinning bug
const RPC_WORKER_CODE = `
// RPC Worker - Long-running process that executes RPC functions
// Communicates with main server via Bun IPC (process.send/process.on)

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
  const rpcFilePath = process.argv[2];
  const namespace = process.argv[3];

  if (!rpcFilePath || !namespace) {
    console.error("Usage: worker <rpcFilePath> <namespace>");
    process.exit(1);
  }

  // Import all functions from RPC file
  const functions = await import(rpcFilePath);

  // Signal ready via IPC
  process.send?.({
    type: "ready",
    workerId: namespace,
  });

  // Handle IPC messages from parent
  process.on("message", async (msg: WorkerMessage) => {
    if (msg.type === "call") {
      const { id, functionName, args } = msg;

      try {
        const fn = functions[functionName];

        if (typeof fn !== "function") {
          throw new Error(\`Function '\${functionName}' not found or not exported\`);
        }

        // Set up progress callback if the module supports it
        if (typeof functions.setProgressCallback === "function") {
          functions.setProgressCallback((message: string) => {
            process.send?.({
              type: "progress",
              id,
              message,
            });
          });
        }

        // Execute with extended timeout (5 minutes)
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

        // Send result back via IPC
        process.send?.({
          type: "result",
          id,
          data: result,
        });
      } catch (error) {
        if (typeof functions.setProgressCallback === "function") {
          functions.setProgressCallback(null);
        }

        process.send?.({
          type: "error",
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (msg.type === "shutdown") {
      console.error(\`[Worker \${namespace}] Received shutdown signal\`);
      process.exit(0);
    }
  });

  // Handle uncaught errors
  process.on("uncaughtException", (error) => {
    console.error(\`[Worker \${namespace}] Uncaught error:\`, error);
    process.send?.({
      type: "crash",
      error: error?.message || String(error),
    });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    console.error(\`[Worker \${namespace}] Unhandled rejection:\`, reason);
    process.send?.({
      type: "crash",
      error: (reason as Error)?.message || String(reason),
    });
    process.exit(1);
  });
}

main();
`;

// Progress callback type
type ProgressCallback = (callId: string, message: string) => void;

interface WorkerState {
  process: Subprocess;
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
   * Handle IPC message from worker
   */
  private handleIPCMessage(workerId: string, message: unknown): void {
    const msg = message as WorkerIncomingMessage;
    const worker = this.workers.get(workerId);

    if (!worker) {
      console.error(`[WorkerManager] Unknown worker: ${workerId}`);
      return;
    }

    if (msg.type === "ready") {
      worker.status = "ready";
      worker.everReady = true;
    } else if (msg.type === "result") {
      const pending = worker.pendingCalls.get(msg.id);
      if (pending) {
        clearTimeout(pending.timeoutId);
        pending.resolve(msg.data);
        worker.pendingCalls.delete(msg.id);
      }
    } else if (msg.type === "error") {
      const pending = worker.pendingCalls.get(msg.id);
      if (pending) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error(msg.error));
        worker.pendingCalls.delete(msg.id);
      }
    } else if (msg.type === "progress") {
      const pending = worker.pendingCalls.get(msg.id);
      if (pending) {
        // Reset timeout on progress
        clearTimeout(pending.timeoutId);
        pending.timeoutId = setTimeout(() => {
          worker.pendingCalls.delete(msg.id);
          pending.reject(new Error(`RPC call timeout after progress (no update for 60s)`));
        }, 60000);

        // Forward progress to client
        if (this.progressCallback && pending.clientCallId) {
          this.progressCallback(pending.clientCallId, msg.message);
        }
      }
    } else if (msg.type === "crash") {
      console.error(`[WorkerManager] Worker ${workerId} crashed: ${msg.error}`);
      this.handleWorkerCrash(workerId);
    }
  }

  /**
   * Start a worker process for an RPC file
   */
  async startWorker(file: RpcFile): Promise<void> {
    const workerId = file.name;

    // Write worker code to temp file
    const tempFile = join(tmpdir(), `lootbox_worker_${randomUUID()}.ts`);
    await Bun.write(tempFile, RPC_WORKER_CODE);

    // Spawn worker process using Bun IPC (not WebSocket to avoid CPU spinning bug)
    const proc = Bun.spawn(["bun", "run", tempFile, file.path, workerId], {
      stdout: "ignore",
      stderr: "inherit",
      ipc: (message) => {
        // Handle IPC messages from worker
        this.handleIPCMessage(workerId, message);
      },
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

    // Monitor process exit for crash handling
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

    // Send call message via IPC
    worker.process.send({
      type: "call",
      id: callId,
      functionName,
      args,
    });

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
   * Stop a worker process
   */
  async stopWorker(workerId: string): Promise<void> {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    console.error(`[WorkerManager] Stopping worker ${workerId}`);

    // Send shutdown via IPC
    try {
      worker.process.send({ type: "shutdown" });
      // Wait a bit for graceful shutdown
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch {
      // Best effort
    }

    // Force kill if still alive
    try {
      worker.process.kill(9); // SIGKILL
    } catch {
      // Already dead
    }

    // Reject any pending calls
    for (const [callId, pending] of worker.pendingCalls) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(`Worker ${workerId} stopped`));
    }
    worker.pendingCalls.clear();

    this.workers.delete(workerId);
  }

  /**
   * Restart a worker (for hot reload)
   */
  async restartWorker(workerId: string, file: RpcFile): Promise<void> {
    await this.stopWorker(workerId);
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
      // Send shutdown via IPC
      try {
        worker.process.send({ type: "shutdown" });
      } catch {
        // Best effort
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
