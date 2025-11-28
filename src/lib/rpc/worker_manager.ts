// Worker Manager - Manages lifecycle of RPC worker processes
// Reliability improvements:
// - Temp file cleanup on worker exit
// - IPC health checks (ping/pong) to detect zombie workers
// - Periodic stale pendingCalls cleanup
// - Graceful shutdown with pending call drain
// - Prometheus metrics integration
// - Structured logging with correlation IDs

import type { RpcFile } from "./load_rpc_files.ts";
import { tmpdir } from "os";
import { join } from "path";
import { unlink } from "fs/promises";
import { randomUUID } from "crypto";
import type { Subprocess } from "bun";
import {
  createComponentLogger,
  startRpcTimer,
  updateWorkerMetrics,
  workerRestarts,
} from "../observability/index.ts";

const log = createComponentLogger("worker-manager");

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

interface PingMessage {
  type: "ping";
  id: string;
}

type WorkerMessage = CallMessage | ShutdownMessage | PingMessage;

async function main() {
  const rpcFilePath = process.argv[2];
  const namespace = process.argv[3];

  if (!rpcFilePath || !namespace) {
    console.error("Usage: worker <rpcFilePath> <namespace>");
    process.exit(1);
  }

  // Import all functions from RPC file
  const functions = await import(rpcFilePath);

  // Import client context utilities for setting client cwd
  // Uses path.dirname/join for cross-platform compatibility (Windows uses \\ not /)
  let setClientCwd: ((cwd: string | null) => void) | null = null;
  let clearClientContext: (() => void) | null = null;
  try {
    const path = await import("path");
    const sharedPath = path.join(path.dirname(rpcFilePath), "shared", "client-context.ts");
    const clientContext = await import(sharedPath);
    setClientCwd = clientContext.setClientCwd;
    clearClientContext = clientContext.clearClientContext;
  } catch (err) {
    // Client context module not available, continue without it
    // Tools will fall back to process.cwd() (server's directory)
    console.error(\`[Worker \${namespace}] Client context not available: \${err}\`);
    console.error(\`[Worker \${namespace}] Falling back to server cwd: \${process.cwd()}\`);
  }

  // Import session memory utilities
  let setSessionMemory: ((toolName: string, memory: any) => void) | null = null;
  let clearSessionMemory: (() => void) | null = null;
  let getMemorySnapshot: (() => any) | null = null;
  try {
    const path = await import("path");
    const sessionMemoryPath = path.join(path.dirname(rpcFilePath), "shared", "session-memory.ts");
    const sessionMemory = await import(sessionMemoryPath);
    setSessionMemory = sessionMemory.setSessionMemory;
    clearSessionMemory = sessionMemory.clearSessionMemory;
    getMemorySnapshot = sessionMemory.getMemorySnapshot;
  } catch (err) {
    // Session memory module not available, continue without it
    console.error(\`[Worker \${namespace}] Session memory not available: \${err}\`);
  }

  // Signal ready via IPC
  process.send?.({
    type: "ready",
    workerId: namespace,
  });

  // Handle IPC messages from parent
  process.on("message", async (msg: WorkerMessage) => {
    if (msg.type === "call") {
      const { id, functionName, args } = msg;

      // Extract and set client cwd from args (injected by mcp-bridge)
      const typedArgs = args as Record<string, unknown>;
      if (setClientCwd && typedArgs._client_cwd) {
        setClientCwd(typedArgs._client_cwd as string);
      }

      // Initialize session memory from args (injected by WorkerManager)
      if (setSessionMemory && typedArgs._session_memory) {
        const memData = typedArgs._session_memory as { kv: Record<string, any>; history: any[] };
        const memory = {
          kv: new Map(Object.entries(memData.kv || {})),
          history: memData.history || [],
        };
        setSessionMemory(namespace, memory);
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

      try {
        const fn = functions[functionName];

        if (typeof fn !== "function") {
          throw new Error(\`Function '\${functionName}' not found or not exported\`);
        }

        // Execute with extended timeout (5 minutes)
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Function execution timeout (5m)")), 300000);
        });

        const result = await Promise.race([
          fn(args),
          timeoutPromise,
        ]);

        // Send result back via IPC
        process.send?.({
          type: "result",
          id,
          data: result,
        });
      } catch (error) {
        process.send?.({
          type: "error",
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        // Get memory snapshot before cleanup to send back to server
        let memorySnapshot = null;
        if (getMemorySnapshot) {
          memorySnapshot = getMemorySnapshot();
        }

        // ALWAYS clean up context and callbacks, even on error
        // This prevents context leaks between calls
        if (typeof functions.setProgressCallback === "function") {
          functions.setProgressCallback(null);
        }
        if (clearClientContext) {
          clearClientContext();
        }
        if (clearSessionMemory) {
          clearSessionMemory();
        }

        // Send memory snapshot back to server for persistence
        if (memorySnapshot) {
          process.send?.({
            type: "memory_update",
            id,
            memory: {
              kv: Object.fromEntries(memorySnapshot.kv?.entries?.() || []),
              history: memorySnapshot.history || [],
            },
          });
        }
      }
    } else if (msg.type === "ping") {
      // Respond to health check ping
      process.send?.({ type: "pong", id: msg.id });
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

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  clientCallId?: string; // Original call ID from client for progress routing
  createdAt: number; // Timestamp for stale call detection
}

interface WorkerState {
  process: Subprocess;
  workerId: string;
  filePath: string;
  tempFilePath: string; // Track temp file for cleanup
  status: "starting" | "ready" | "crashed" | "failed";
  pendingCalls: Map<string, PendingCall>;
  restartCount: number;
  lastRestart: number;
  everReady: boolean; // Track if worker ever successfully started
  lastPong: number; // Last time we received a pong (for health checks)
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

interface PongMessage {
  type: "pong";
  id: string;
}

interface MemoryUpdateMessage {
  type: "memory_update";
  id: string;
  memory: unknown;
}

type WorkerIncomingMessage =
  | ReadyMessage
  | ResultMessage
  | ErrorMessage
  | CrashMessage
  | ProgressMessage
  | PongMessage
  | MemoryUpdateMessage;

// ============== Session Memory Types ==============

interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

interface MemoryEntry {
  value: unknown;
  timestamp: number;
  expiresAt?: number;
  accessCount: number;
}

interface ToolMemory {
  kv: Map<string, MemoryEntry>;
  history: ConversationMessage[];
}

export class WorkerManager {
  private workers = new Map<string, WorkerState>();
  private port: number;
  private progressCallback?: ProgressCallback;
  private healthCheckInterval?: ReturnType<typeof setInterval>;
  private staleCallCleanupInterval?: ReturnType<typeof setInterval>;
  private pendingPings = new Map<string, { workerId: string; timeoutId: ReturnType<typeof setTimeout> }>();

  // Session memory - cleared on server restart
  private sessionMemory = new Map<string, ToolMemory>();

  // Configuration
  private static readonly HEALTH_CHECK_INTERVAL_MS = 30000; // 30 seconds
  private static readonly PING_TIMEOUT_MS = 10000; // 10 seconds to respond to ping
  private static readonly STALE_CALL_THRESHOLD_MS = 300000; // 5 minutes
  private static readonly STALE_CALL_CLEANUP_INTERVAL_MS = 60000; // Check every minute

  constructor(port: number) {
    this.port = port;
    this.startHealthChecks();
    this.startStaleCallCleanup();
  }

  // ============== Session Memory Management ==============

  /**
   * Get or create session memory for a tool
   */
  private getToolMemory(namespace: string): ToolMemory {
    if (!this.sessionMemory.has(namespace)) {
      this.sessionMemory.set(namespace, {
        kv: new Map(),
        history: [],
      });
    }
    return this.sessionMemory.get(namespace)!;
  }

  /**
   * Serialize tool memory for IPC (convert Map to Object)
   */
  private serializeToolMemory(memory: ToolMemory): unknown {
    return {
      kv: Object.fromEntries(memory.kv.entries()),
      history: memory.history,
    };
  }

  /**
   * Deserialize tool memory from IPC response
   */
  private deserializeToolMemory(data: unknown): ToolMemory {
    const snapshot = data as { kv: Record<string, MemoryEntry>; history: ConversationMessage[] };
    return {
      kv: new Map(Object.entries(snapshot.kv || {})),
      history: snapshot.history || [],
    };
  }

  /**
   * Start periodic health checks to detect zombie workers
   */
  private startHealthChecks(): void {
    this.healthCheckInterval = setInterval(() => {
      for (const [workerId, worker] of this.workers) {
        if (worker.status !== "ready") continue;

        const pingId = `ping_${Date.now()}_${Math.random().toString(36).substring(2)}`;

        // Set up timeout for this ping
        const timeoutId = setTimeout(() => {
          this.pendingPings.delete(pingId);
          console.error(`[WorkerManager] Worker ${workerId} failed health check (no pong in ${WorkerManager.PING_TIMEOUT_MS}ms)`);
          // Restart the worker
          this.handleWorkerCrash(workerId);
        }, WorkerManager.PING_TIMEOUT_MS);

        this.pendingPings.set(pingId, { workerId, timeoutId });

        try {
          worker.process.send({ type: "ping", id: pingId });
        } catch {
          // IPC failed - worker is dead
          clearTimeout(timeoutId);
          this.pendingPings.delete(pingId);
          console.error(`[WorkerManager] Worker ${workerId} IPC send failed - treating as crash`);
          this.handleWorkerCrash(workerId);
        }
      }
    }, WorkerManager.HEALTH_CHECK_INTERVAL_MS);
  }

  /**
   * Start periodic cleanup of stale pending calls
   */
  private startStaleCallCleanup(): void {
    this.staleCallCleanupInterval = setInterval(() => {
      const now = Date.now();
      let cleanedCount = 0;

      for (const worker of this.workers.values()) {
        for (const [callId, pending] of worker.pendingCalls) {
          if (now - pending.createdAt > WorkerManager.STALE_CALL_THRESHOLD_MS) {
            clearTimeout(pending.timeoutId);
            pending.reject(new Error(`Stale call cleanup: ${callId} exceeded ${WorkerManager.STALE_CALL_THRESHOLD_MS}ms`));
            worker.pendingCalls.delete(callId);
            cleanedCount++;
          }
        }
      }

      if (cleanedCount > 0) {
        console.error(`[WorkerManager] Cleaned up ${cleanedCount} stale pending calls`);
      }
    }, WorkerManager.STALE_CALL_CLEANUP_INTERVAL_MS);
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
      log.info({ worker: workerId }, "Worker ready");
      this.emitWorkerMetrics();
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
    } else if (msg.type === "pong") {
      // Health check response
      worker.lastPong = Date.now();
      const pending = this.pendingPings.get(msg.id);
      if (pending) {
        clearTimeout(pending.timeoutId);
        this.pendingPings.delete(msg.id);
      }
    } else if (msg.type === "crash") {
      console.error(`[WorkerManager] Worker ${workerId} crashed: ${msg.error}`);
      this.handleWorkerCrash(workerId);
    } else if (msg.type === "memory_update") {
      // Update session memory from worker response
      const memory = this.deserializeToolMemory(msg.memory);
      this.sessionMemory.set(workerId, memory);
      log.debug({ worker: workerId, kvSize: memory.kv.size, historySize: memory.history.length }, "Session memory updated");
    }
  }

  /**
   * Start a worker process for an RPC file
   */
  async startWorker(file: RpcFile): Promise<void> {
    const workerId = file.name;

    // Write worker code to temp file
    const tempFilePath = join(tmpdir(), `lootbox_worker_${randomUUID()}.ts`);
    await Bun.write(tempFilePath, RPC_WORKER_CODE);

    // Spawn worker process using Bun IPC (not WebSocket to avoid CPU spinning bug)
    const proc = Bun.spawn(["bun", "run", tempFilePath, file.path, workerId], {
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
      tempFilePath, // Track temp file for cleanup
      status: "starting",
      pendingCalls: new Map(),
      restartCount: 0,
      lastRestart: Date.now(),
      everReady: false,
      lastPong: Date.now(), // Initialize to now
    };

    this.workers.set(workerId, worker);

    // Monitor process exit for crash handling AND temp file cleanup
    proc.exited.then(async (exitCode) => {
      // Always clean up temp file when worker exits
      try {
        await unlink(tempFilePath);
      } catch {
        // Ignore - file may already be deleted
      }

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

    // Start metrics timer
    const endTimer = startRpcTimer(namespace, functionName);

    // Generate unique call ID
    const callId = `call_${Date.now()}_${Math.random()
      .toString(36)
      .substring(2)}`;

    log.debug({ namespace, functionName, callId }, "Starting RPC call");

    // Get session memory for this tool
    const toolMemory = this.getToolMemory(namespace);

    // Create promise for response
    const resultPromise = new Promise<unknown>((resolve, reject) => {
      // Timeout after 30 seconds (will be extended on progress updates)
      const timeoutId = setTimeout(() => {
        worker.pendingCalls.delete(callId);
        endTimer("timeout");
        log.warn({ namespace, functionName, callId }, "RPC call timeout");
        reject(
          new Error(
            `RPC call timeout: ${namespace}.${functionName} (30 seconds)`
          )
        );
      }, 30000);

      worker.pendingCalls.set(callId, {
        resolve,
        reject,
        timeoutId,
        clientCallId,
        createdAt: Date.now(), // Track for stale call cleanup
      });
    });

    // Inject session memory into args
    const argsWithMemory = {
      ...((args || {}) as object),
      _session_memory: this.serializeToolMemory(toolMemory),
    };

    // Send call message via IPC
    worker.process.send({
      type: "call",
      id: callId,
      functionName,
      args: argsWithMemory,
    });

    try {
      const result = await resultPromise;
      endTimer("success");
      log.debug({ namespace, functionName, callId }, "RPC call completed");
      return result;
    } catch (error) {
      endTimer("error");
      throw error;
    }
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
      log.error(
        { worker: workerId },
        "Worker failed to start - not retrying. Check the tool file for errors."
      );
      workerRestarts.inc({ worker: workerId, reason: "startup_failure" });
      this.emitWorkerMetrics();
      return;
    }

    // Worker was previously healthy, attempt restart with backoff
    worker.status = "crashed";
    const backoffMs = Math.min(1000 * Math.pow(2, worker.restartCount), 30000);
    worker.restartCount++;

    log.warn(
      { worker: workerId, backoffMs, attempt: worker.restartCount },
      "Scheduling worker restart after crash"
    );
    workerRestarts.inc({ worker: workerId, reason: "crash" });

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
   * Emit current worker metrics
   */
  private emitWorkerMetrics(): void {
    updateWorkerMetrics(this.getStats());
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
   * Stop all workers with graceful shutdown
   * Waits for pending calls to complete (up to gracePeriodMs)
   */
  async stopAllWorkers(gracePeriodMs = 5000): Promise<void> {
    // Stop health checks and cleanup intervals first
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
    if (this.staleCallCleanupInterval) {
      clearInterval(this.staleCallCleanupInterval);
      this.staleCallCleanupInterval = undefined;
    }

    // Clear pending pings
    for (const [, pending] of this.pendingPings) {
      clearTimeout(pending.timeoutId);
    }
    this.pendingPings.clear();

    // Check if there are pending calls
    const hasPendingCalls = () => {
      for (const worker of this.workers.values()) {
        if (worker.pendingCalls.size > 0) return true;
      }
      return false;
    };

    // Wait for pending calls to complete (graceful shutdown)
    if (hasPendingCalls()) {
      console.error(`[WorkerManager] Waiting up to ${gracePeriodMs}ms for pending calls to complete...`);
      const startTime = Date.now();
      while (hasPendingCalls() && Date.now() - startTime < gracePeriodMs) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (hasPendingCalls()) {
        console.error(`[WorkerManager] Grace period expired, ${this.countPendingCalls()} calls will be rejected`);
      }
    }

    // Now stop all workers
    const cleanupPromises: Promise<void>[] = [];

    for (const worker of this.workers.values()) {
      // Reject any remaining pending calls
      for (const [, pending] of worker.pendingCalls) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error("Worker manager shutting down"));
      }
      worker.pendingCalls.clear();

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

      // Clean up temp file
      cleanupPromises.push(
        unlink(worker.tempFilePath).catch(() => {
          // Ignore - file may already be deleted
        })
      );
    }

    // Wait for all temp file cleanups
    await Promise.all(cleanupPromises);

    this.workers.clear();
    console.error("[WorkerManager] All workers stopped");
  }

  /**
   * Count total pending calls across all workers
   */
  private countPendingCalls(): number {
    let count = 0;
    for (const worker of this.workers.values()) {
      count += worker.pendingCalls.size;
    }
    return count;
  }

  /**
   * Check if there are any pending calls
   */
  hasPendingCalls(): boolean {
    return this.countPendingCalls() > 0;
  }

  /**
   * Get worker statistics for health monitoring
   */
  getStats(): {
    totalWorkers: number;
    readyWorkers: number;
    failedWorkers: number;
    pendingCalls: number;
  } {
    let ready = 0;
    let failed = 0;
    let pendingCalls = 0;

    for (const worker of this.workers.values()) {
      if (worker.status === "ready") ready++;
      if (worker.status === "failed") failed++;
      pendingCalls += worker.pendingCalls.size;
    }

    return {
      totalWorkers: this.workers.size,
      readyWorkers: ready,
      failedWorkers: failed,
      pendingCalls,
    };
  }
}
