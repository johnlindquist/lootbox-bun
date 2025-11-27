# CPU Spike Investigation Expert Bundle

## Executive Summary
This bundle contains all relevant code for investigating 100% CPU spikes in the lootbox-bun RPC server. The server uses a multi-process architecture where the main server spawns worker processes (one per tool file) that communicate via WebSocket. Recent fixes addressed "worker explosion" caused by improper file watcher debouncing, but CPU spikes may still occur from other sources.

### Key Problems:
1. **Worker Process Management** - Each tool file spawns a separate Bun subprocess. If workers don't terminate properly, restart too frequently, or have infinite loops, CPU spikes occur.
2. **File Watcher Cascades** - File changes trigger worker restarts. Improper debouncing can cause mass restart cascades (historically caused 45+ restarts from 1 save).
3. **Event Loop Blocking** - Long-running synchronous operations, tight polling loops, or uncleared intervals/timeouts can spike CPU.

### Required Fixes (Investigation Areas):
1. `src/lib/rpc/worker_manager.ts`: Check worker spawning, restart backoff, and pending call timeouts
2. `src/lib/rpc/managers/file_watcher_manager.ts`: Verify debounce logic is working correctly
3. `src/lib/rpc/managers/health_monitor.ts`: Use this to diagnose - tracks CPU %, memory, event loop lag
4. `src/lib/rpc/websocket_server.ts`: Main orchestrator - check if multiple callbacks trigger redundant work

### Files Included:
- `src/lib/rpc/worker_manager.ts`: Worker lifecycle management, subprocess spawning, message handling
- `src/lib/rpc/managers/file_watcher_manager.ts`: File system watching with debounce
- `src/lib/rpc/managers/health_monitor.ts`: CPU/memory/event-loop monitoring
- `src/lib/rpc/websocket_server.ts`: Main server orchestrating all managers
- `src/lib/rpc/managers/connection_manager.ts`: WebSocket connection handling
- `src/lib/rpc/managers/message_router.ts`: Message routing to workers
- `src/lib/rpc/managers/rpc_cache_manager.ts`: RPC file discovery and caching
- `mcp-bridge.ts`: MCP bridge client (connects to server)
- `src/lib/execute_llm_script.ts`: Script execution subprocess spawning

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     WebSocketRpcServer                          │
│                   (Main Orchestrator)                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐ │
│  │  FileWatcher     │  │  RpcCacheManager │  │ HealthMonitor │ │
│  │  Manager         │  │                  │  │               │ │
│  │  - watch()       │  │  - refreshCache()│  │  - CPU check  │ │
│  │  - debounce      │  │  - callbacks     │  │  - Memory     │ │
│  └────────┬─────────┘  └────────┬─────────┘  │  - Event loop │ │
│           │                      │           └───────────────┘ │
│           │  file change         │ cache refresh                │
│           ▼                      ▼                              │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    WorkerManager                           │ │
│  │  - startWorker() → Bun.spawn() subprocess                  │ │
│  │  - restartWorker() → stopWorker() + startWorker()          │ │
│  │  - handleWorkerCrash() → exponential backoff restart       │ │
│  │  - callFunction() → send message, wait for response        │ │
│  └──────────────────────────┬─────────────────────────────────┘ │
│                             │                                   │
│                             │ WebSocket (ws://localhost:PORT)   │
│                             ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Worker Subprocess 1   Worker Subprocess 2   ...         │  │
│  │  (gemini.ts)           (basic_memory.ts)                 │  │
│  │  - import tool file                                      │  │
│  │  - connect WebSocket                                     │  │
│  │  - handle "call" messages                                │  │
│  │  - send "result"/"error"/"progress" back                 │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Files

### 1. src/lib/rpc/worker_manager.ts

```typescript
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
   * Stop a worker process
   */
  async stopWorker(workerId: string): Promise<void> {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    console.error(`[WorkerManager] Stopping worker ${workerId}`);

    if (worker.sendMessage) {
      try {
        worker.sendMessage(JSON.stringify({ type: "shutdown" }));
      } catch {
        // Best effort
      }

      // Wait a bit for graceful shutdown
      await new Promise((resolve) => setTimeout(resolve, 500));
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

    // Clean up
    worker.sendMessage = undefined;
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
```

---

### 2. src/lib/rpc/managers/file_watcher_manager.ts

```typescript
/**
 * FileWatcherManager
 *
 * Manages filesystem monitoring for RPC files.
 * Handles:
 * - Watching RPC directory for file changes
 * - Debouncing rapid changes (properly coalesces events)
 * - Tracking which specific files changed
 * - Triggering callbacks on TypeScript file modifications
 * - Lifecycle control (start/stop watching)
 */

import { watch, type FSWatcher } from "fs";
import { join } from "path";

export class FileWatcherManager {
  private watcher: FSWatcher | null = null;
  private watching = false;
  private pendingFiles = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Start watching a directory for changes
   * Calls onChange callback when TypeScript files are modified (with proper debouncing)
   * @param directory - Directory to watch
   * @param onChange - Callback receiving the set of changed file paths
   */
  startWatching(
    directory: string,
    onChange: (changedFiles: Set<string>) => Promise<void>
  ): void {
    if (this.watching) {
      console.error("File watcher already running");
      return;
    }

    try {
      this.watcher = watch(directory, { recursive: true }, (eventType, filename) => {
        if (!this.watching) return;

        // Only react to TypeScript file changes (exclude test files)
        if (filename?.endsWith(".ts") && !filename.endsWith(".test.ts")) {
          // Track absolute path for matching
          const fullPath = join(directory, filename);
          this.pendingFiles.add(fullPath);

          // True debounce: cancel pending timer and reset
          if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
          }

          this.debounceTimer = setTimeout(async () => {
            // Capture and clear pending files
            const files = new Set(this.pendingFiles);
            this.pendingFiles.clear();
            this.debounceTimer = null;

            // Trigger callback with changed files
            await onChange(files);
          }, 200); // 200ms debounce window
        }
      });

      this.watching = true;

      this.watcher.on("error", (err) => {
        if (this.watching) {
          // Only log if we didn't intentionally stop watching
          console.error("File watcher error:", err);
        }
      });
    } catch (err) {
      console.error("Failed to start file watcher:", err);
      this.watching = false;
    }
  }

  /**
   * Stop watching filesystem
   */
  stopWatching(): void {
    if (!this.watching) {
      return;
    }

    this.watching = false;

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingFiles.clear();
  }

  /**
   * Check if currently watching
   */
  isWatching(): boolean {
    return this.watching;
  }
}
```

---

### 3. src/lib/rpc/managers/health_monitor.ts

```typescript
/**
 * HealthMonitor
 *
 * Monitors server health and resource usage.
 * Detects runaway processes, high CPU, memory leaks.
 *
 * Logs warnings when thresholds are exceeded.
 */

import { cpus } from "os";

interface HealthMetrics {
  timestamp: number;
  cpuUsage: NodeJS.CpuUsage;
  memoryUsage: NodeJS.MemoryUsage;
  eventLoopLag: number;
  activeHandles: number;
  activeRequests: number;
}

interface HealthStatus {
  healthy: boolean;
  warnings: string[];
  metrics: HealthMetrics;
}

// Thresholds
const CPU_THRESHOLD_PERCENT = 80; // Warn if CPU > 80%
const MEMORY_THRESHOLD_MB = 500; // Warn if RSS > 500MB
const EVENT_LOOP_LAG_MS = 100; // Warn if event loop lag > 100ms
const CHECK_INTERVAL_MS = 5000; // Check every 5 seconds

export class HealthMonitor {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastCpuUsage: NodeJS.CpuUsage | null = null;
  private lastCheck: number = Date.now();
  private consecutiveHighCpu = 0;
  private enabled = false;

  // Event loop lag measurement
  private lagCheckStart = 0;
  private lastEventLoopLag = 0;

  /**
   * Start monitoring
   */
  start(): void {
    if (this.enabled) return;
    this.enabled = true;

    console.error("[HealthMonitor] Starting health monitoring...");
    this.lastCpuUsage = process.cpuUsage();
    this.lastCheck = Date.now();

    // Start periodic checks
    this.intervalId = setInterval(() => {
      this.checkHealth();
    }, CHECK_INTERVAL_MS);

    // Start event loop lag monitoring
    this.scheduleEventLoopCheck();
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (!this.enabled) return;
    this.enabled = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.error("[HealthMonitor] Stopped health monitoring");
  }

  /**
   * Schedule event loop lag check using setImmediate
   */
  private scheduleEventLoopCheck(): void {
    if (!this.enabled) return;

    this.lagCheckStart = performance.now();
    setImmediate(() => {
      const lag = performance.now() - this.lagCheckStart;
      this.lastEventLoopLag = lag;

      // Reschedule
      setTimeout(() => this.scheduleEventLoopCheck(), 1000);
    });
  }

  /**
   * Check health and log warnings
   */
  private checkHealth(): void {
    const status = this.getStatus();

    if (!status.healthy) {
      console.error(`[HealthMonitor] ⚠️  Health warnings detected:`);
      for (const warning of status.warnings) {
        console.error(`[HealthMonitor]   - ${warning}`);
      }

      // Log metrics for debugging
      const mem = status.metrics.memoryUsage;
      console.error(`[HealthMonitor] Metrics:`, {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
        eventLoopLagMs: Math.round(status.metrics.eventLoopLag),
        activeHandles: status.metrics.activeHandles,
        activeRequests: status.metrics.activeRequests,
      });
    }

    // Track consecutive high CPU
    const cpuPercent = this.calculateCpuPercent(status.metrics.cpuUsage);
    if (cpuPercent > CPU_THRESHOLD_PERCENT) {
      this.consecutiveHighCpu++;
      if (this.consecutiveHighCpu >= 3) {
        console.error(
          `[HealthMonitor] 🔥 CPU has been high (>${CPU_THRESHOLD_PERCENT}%) for ${this.consecutiveHighCpu * CHECK_INTERVAL_MS / 1000}s - possible runaway process!`
        );
        this.logStackTrace();
      }
    } else {
      this.consecutiveHighCpu = 0;
    }
  }

  /**
   * Calculate CPU percentage from usage
   */
  private calculateCpuPercent(cpuUsage: NodeJS.CpuUsage): number {
    if (!this.lastCpuUsage) {
      this.lastCpuUsage = cpuUsage;
      return 0;
    }

    const now = Date.now();
    const elapsed = now - this.lastCheck;

    // Calculate CPU time delta (user + system) in microseconds
    const userDelta = cpuUsage.user - this.lastCpuUsage.user;
    const systemDelta = cpuUsage.system - this.lastCpuUsage.system;
    const totalCpuTime = userDelta + systemDelta;

    // Convert elapsed to microseconds and calculate percentage
    const elapsedMicro = elapsed * 1000;
    const cpuPercent = (totalCpuTime / elapsedMicro) * 100;

    // Update for next check
    this.lastCpuUsage = cpuUsage;
    this.lastCheck = now;

    return cpuPercent;
  }

  /**
   * Log current stack traces for debugging
   */
  private logStackTrace(): void {
    console.error("[HealthMonitor] Current stack trace:");
    console.error(new Error("Stack trace").stack);

    // Log active handles info if available
    if (typeof (process as any)._getActiveHandles === "function") {
      const handles = (process as any)._getActiveHandles();
      console.error(`[HealthMonitor] Active handles (${handles.length}):`);
      const handleTypes = new Map<string, number>();
      for (const h of handles) {
        const type = h.constructor?.name || "Unknown";
        handleTypes.set(type, (handleTypes.get(type) || 0) + 1);
      }
      for (const [type, count] of handleTypes) {
        console.error(`[HealthMonitor]   ${type}: ${count}`);
      }
    }
  }

  /**
   * Get current health status
   */
  getStatus(): HealthStatus {
    const cpuUsage = process.cpuUsage();
    const memoryUsage = process.memoryUsage();
    const warnings: string[] = [];

    // Calculate CPU percentage
    const cpuPercent = this.calculateCpuPercent(cpuUsage);
    if (cpuPercent > CPU_THRESHOLD_PERCENT) {
      warnings.push(`High CPU usage: ${cpuPercent.toFixed(1)}%`);
    }

    // Check memory
    const rssMB = memoryUsage.rss / 1024 / 1024;
    if (rssMB > MEMORY_THRESHOLD_MB) {
      warnings.push(`High memory usage: ${rssMB.toFixed(1)}MB RSS`);
    }

    // Check event loop lag
    if (this.lastEventLoopLag > EVENT_LOOP_LAG_MS) {
      warnings.push(`Event loop lag: ${this.lastEventLoopLag.toFixed(1)}ms`);
    }

    // Get active handles/requests (Bun compatibility)
    let activeHandles = 0;
    let activeRequests = 0;
    if (typeof (process as any)._getActiveHandles === "function") {
      activeHandles = (process as any)._getActiveHandles().length;
    }
    if (typeof (process as any)._getActiveRequests === "function") {
      activeRequests = (process as any)._getActiveRequests().length;
    }

    return {
      healthy: warnings.length === 0,
      warnings,
      metrics: {
        timestamp: Date.now(),
        cpuUsage,
        memoryUsage,
        eventLoopLag: this.lastEventLoopLag,
        activeHandles,
        activeRequests,
      },
    };
  }

  /**
   * Get metrics for external use
   */
  getMetrics(): HealthMetrics {
    return this.getStatus().metrics;
  }
}

// Singleton instance
let healthMonitor: HealthMonitor | null = null;

export function getHealthMonitor(): HealthMonitor {
  if (!healthMonitor) {
    healthMonitor = new HealthMonitor();
  }
  return healthMonitor;
}
```

---

### 4. src/lib/rpc/websocket_server.ts

```typescript
/**
 * WebSocketRpcServer - Thin Orchestrator
 *
 * Composes and coordinates all manager classes to provide
 * a complete WebSocket RPC server.
 *
 * Responsibilities:
 * - Manager composition and initialization
 * - Lifecycle orchestration (start/stop)
 * - Wiring managers together with callbacks
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import type { Hono } from "hono";
import type { Ora } from "ora";
import { get_client, set_client } from "../client_cache.ts";
import type { McpConfigFile } from "../external-mcps/mcp_config.ts";
import { WorkerManager } from "./worker_manager.ts";
import { RpcCacheManager } from "./managers/rpc_cache_manager.ts";
import { FileWatcherManager } from "./managers/file_watcher_manager.ts";
import { TypeGeneratorManager } from "./managers/type_generator_manager.ts";
import { McpIntegrationManager } from "./managers/mcp_integration_manager.ts";
import { MessageRouter } from "./managers/message_router.ts";
import { ConnectionManager } from "./managers/connection_manager.ts";
import { OpenApiRouteHandler } from "./managers/openapi_route_handler.ts";
import { setupUIRoutes } from "../ui_server.ts";
import { showBootup } from "../lootbox-cli/bootup.ts";
import { getHealthMonitor } from "./managers/health_monitor.ts";

export class WebSocketRpcServer {
  private app = new OpenAPIHono();

  // Manager composition
  private rpcCacheManager: RpcCacheManager;
  private fileWatcherManager: FileWatcherManager;
  private typeGeneratorManager: TypeGeneratorManager;
  private mcpIntegrationManager: McpIntegrationManager;
  private connectionManager: ConnectionManager;
  private messageRouter!: MessageRouter; // Initialized in start()
  private workerManager: WorkerManager | null = null;

  private currentPort = 0;
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor() {
    // Initialize independent managers
    this.rpcCacheManager = new RpcCacheManager();
    this.fileWatcherManager = new FileWatcherManager();
    this.typeGeneratorManager = new TypeGeneratorManager(this.rpcCacheManager);
    this.mcpIntegrationManager = new McpIntegrationManager();
    this.connectionManager = new ConnectionManager();
  }

  /**
   * Wire managers together with event callbacks
   */
  private wireManagers(): void {
    // RPC cache refresh triggers:
    // 1. Type cache invalidation
    this.rpcCacheManager.onCacheRefreshed(() => {
      this.typeGeneratorManager.invalidateCache();
    });

    // 2. Client notifications
    this.rpcCacheManager.onCacheRefreshed((functions) => {
      this.connectionManager.broadcastToClients({
        type: "functions_updated",
        functions,
      });
    });

    // 3. Client code regeneration and caching
    this.rpcCacheManager.onCacheRefreshed(async () => {
      try {
        const schemas = this.mcpIntegrationManager.isEnabled()
          ? await this.mcpIntegrationManager.getSchemas()
          : undefined;
        const clientCode = await this.typeGeneratorManager.generateClientCode(
          this.currentPort,
          schemas
        );
        set_client(clientCode);
      } catch (err) {
        console.error("Failed to regenerate client code:", err);
      }
    });

    // 4. Worker restarts - REMOVED: Now handled by targeted restarts in file watcher
    // Old code restarted ALL workers on any change, causing CPU spikes
  }

  /**
   * Start the RPC server
   */
  async start(port: number, mcpConfig: McpConfigFile | null, spinner?: Ora): Promise<void> {
    this.currentPort = port;

    // Get config early
    const { get_config } = await import("../get_config.ts");
    const config = await get_config();

    // Phase 1 & 2: Load RPC cache and initialize MCP in parallel
    await Promise.all([
      this.rpcCacheManager.refreshCache(),
      mcpConfig ? this.mcpIntegrationManager.initialize(mcpConfig) : Promise.resolve(),
    ]);

    // Phase 2.5: Generate initial client code
    const schemas = this.mcpIntegrationManager.isEnabled()
      ? await this.mcpIntegrationManager.getSchemas()
      : undefined;
    const clientCode = await this.typeGeneratorManager.generateClientCode(
      port,
      schemas
    );
    set_client(clientCode);

    // Phase 3: Wire managers together
    this.wireManagers();

    // Phase 4: Setup message routing
    this.workerManager = new WorkerManager(port);
    this.messageRouter = new MessageRouter(
      this.workerManager,
      this.mcpIntegrationManager
    );

    // Set up progress callback to forward progress messages to clients
    // This enables long-running operations to send updates without timing out
    const connectionManager = this.connectionManager;
    this.workerManager.setProgressCallback((callId, message) => {
      // Broadcast progress to all clients - the client with the matching callId will handle it
      connectionManager.broadcastToClients({
        type: "progress",
        id: callId,
        message,
      });
    });

    // Phase 5: Setup HTTP routes with OpenAPI documentation
    this.setupRoutes();

    // Phase 7: Start file watcher with targeted worker restarts
    this.fileWatcherManager.startWatching(config.tools_dir, async (changedFiles) => {
      if (!this.workerManager) return;

      // 1. Capture state before refresh
      const previousFiles = this.rpcCacheManager.getUniqueFiles();

      // 2. Refresh cache (detects adds/removes)
      await this.rpcCacheManager.refreshCache();

      // 3. Get new state
      const currentFiles = this.rpcCacheManager.getUniqueFiles();

      // 4. Handle Removals (files in previous but not current)
      for (const [path, file] of previousFiles) {
        if (!currentFiles.has(path)) {
          console.error(`[Server] File removed: ${file.name}`);
          await this.workerManager.stopWorker(file.name);
        }
      }

      // 5. Handle Adds and Modifications
      for (const [path, file] of currentFiles) {
        const isNew = !previousFiles.has(path);
        const isModified = changedFiles.has(path);

        if (isNew) {
          console.error(`[Server] New file detected: ${file.name}`);
          await this.workerManager.startWorker(file);
        } else if (isModified) {
          console.error(`[Server] File modified: ${file.name}`);
          await this.workerManager.restartWorker(file.name, file);
        }
      }
    });

    // Phase 8: Start HTTP server using Bun
    const honoFetch = this.app.fetch.bind(this.app);
    const messageRouter = this.messageRouter;
    const rpcCacheManager = this.rpcCacheManager;
    const workerManager = this.workerManager!;

    this.server = Bun.serve({
      port,
      fetch(req, server) {
        // Check for WebSocket upgrade
        const url = new URL(req.url);
        if (url.pathname === "/ws" || url.pathname === "/worker-ws") {
          const upgraded = server.upgrade(req, {
            data: { path: url.pathname },
          });
          if (upgraded) {
            return undefined; // Return undefined for successful upgrade
          }
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        // Handle regular HTTP requests with Hono
        return honoFetch(req, server);
      },
      websocket: {
        open(ws) {
          connectionManager.handleWebSocketOpen(ws);
        },
        message(ws, message) {
          connectionManager.handleWebSocketMessage(
            ws,
            message,
            messageRouter,
            () => rpcCacheManager.getFunctionNames(),
            workerManager
          );
        },
        close(ws) {
          connectionManager.handleWebSocketClose(ws);
        },
      },
    });

    // Give server time to start
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Phase 9: Initialize workers
    const uniqueFiles = this.rpcCacheManager.getUniqueFiles();
    await Promise.all(
      Array.from(uniqueFiles.values()).map((file) =>
        this.workerManager!.startWorker(file)
      )
    );

    // Wait for workers to be ready
    await this.workerManager.waitForReady(5000);

    // Phase 10: Start health monitoring
    const healthMonitor = getHealthMonitor();
    healthMonitor.start();

    // Show bootup display
    showBootup({
      port,
      toolsDir: config.tools_dir,
      mcpServers: this.mcpIntegrationManager.getConnectedServers(),
      rpcFunctions: this.rpcCacheManager.getFunctionNames(),
      spinner,
    });
  }

  /**
   * Stop the RPC server
   */
  async stop(): Promise<void> {
    console.error("Stopping RPC server...");

    // Stop health monitoring
    getHealthMonitor().stop();

    // Stop workers
    if (this.workerManager) {
      await this.workerManager.stopAllWorkers();
      this.workerManager = null;
    }

    // Close all client connections
    await this.connectionManager.closeAllClients();

    // Shutdown MCP
    await this.mcpIntegrationManager.shutdown();

    // Stop file watcher
    this.fileWatcherManager.stopWatching();

    // Stop Bun server
    if (this.server) {
      this.server.stop();
      this.server = null;
    }

    console.error("RPC server stopped");
  }

  /**
   * Setup all HTTP and WebSocket routes
   */
  private setupRoutes(): void {
    // Setup OpenAPI-documented REST routes
    const openApiHandler = new OpenApiRouteHandler(
      this.app,
      this.rpcCacheManager,
      this.typeGeneratorManager,
      this.mcpIntegrationManager,
      get_client,
      this.currentPort
    );
    openApiHandler.setupRoutes();

    // Setup UI routes
    setupUIRoutes(this.app);

    // Setup WebSocket upgrade route
    this.app.get("/ws", (c) => {
      const upgradeHeader = c.req.header("Upgrade");
      if (upgradeHeader !== "websocket") {
        return c.text("Expected WebSocket upgrade", 426);
      }
      // Bun handles WebSocket upgrade via the websocket handler in Bun.serve
      return new Response(null, { status: 101 });
    });

    this.app.get("/worker-ws", (c) => {
      const upgradeHeader = c.req.header("Upgrade");
      if (upgradeHeader !== "websocket") {
        return c.text("Expected WebSocket upgrade", 426);
      }
      return new Response(null, { status: 101 });
    });
  }
}
```

---

### 5. src/lib/rpc/managers/connection_manager.ts

```typescript
/**
 * ConnectionManager
 *
 * Manages WebSocket connections.
 * Handles:
 * - Client WebSocket lifecycle (connect, disconnect)
 * - Worker WebSocket lifecycle
 * - Broadcasting messages to all connected clients
 * - Welcome messages with available functions
 * - WebSocket handler creation for Hono routes
 * - Bun-native WebSocket handlers
 */

import type { MessageRouter } from "./message_router.ts";
import type { WorkerManager } from "../worker_manager.ts";
import type { ServerWebSocket } from "bun";

// Type for Hono WebSocket context
interface WebSocketContext {
  send(message: string): void;
  close(): void;
}

export interface WebSocketHandler {
  onOpen: (event: Event, ws: WebSocketContext) => void;
  onMessage: (event: MessageEvent, ws: WebSocketContext) => Promise<void>;
  onClose: (event: CloseEvent, ws: WebSocketContext) => void;
  onError: (evt: Event, ws: WebSocketContext) => void;
}

export class ConnectionManager {
  private clients = new Set<WebSocketContext>();
  private bunClients = new Set<ServerWebSocket<unknown>>();
  private bunWorkers = new Map<string, ServerWebSocket<unknown>>();

  /**
   * Add a client WebSocket connection
   */
  addClient(ws: WebSocketContext): void {
    this.clients.add(ws);
  }

  /**
   * Remove a client WebSocket connection
   */
  removeClient(ws: WebSocketContext): void {
    this.clients.delete(ws);
  }

  /**
   * Broadcast a message to all connected clients
   */
  broadcastToClients(message: object): void {
    const messageStr = JSON.stringify(message);
    // Broadcast to Hono WebSocket clients
    for (const client of this.clients) {
      try {
        client.send(messageStr);
      } catch (err) {
        console.error("Failed to send message to client:", err);
        this.clients.delete(client);
      }
    }
    // Broadcast to Bun native WebSocket clients
    for (const client of this.bunClients) {
      try {
        client.send(messageStr);
      } catch (err) {
        console.error("Failed to send message to bun client:", err);
        this.bunClients.delete(client);
      }
    }
  }

  /**
   * Close all client connections
   */
  async closeAllClients(): Promise<void> {
    for (const client of this.clients) {
      try {
        client.close();
      } catch (err) {
        console.error("Error closing WebSocket connection:", err);
      }
    }
    this.clients.clear();
  }

  /**
   * Send welcome message to a newly connected client
   */
  sendWelcome(ws: WebSocketContext, functions: string[]): void {
    ws.send(
      JSON.stringify({
        type: "welcome",
        functions,
      })
    );
  }

  /**
   * Get number of connected clients
   */
  getClientCount(): number {
    return this.clients.size + this.bunClients.size;
  }

  /**
   * Handle Bun WebSocket open event
   */
  handleWebSocketOpen(ws: ServerWebSocket<unknown>): void {
    // Initially add to bunClients - will be moved to workers if it identifies as one
    this.bunClients.add(ws);
  }

  /**
   * Handle Bun WebSocket message event
   */
  async handleWebSocketMessage(
    ws: ServerWebSocket<unknown>,
    message: string | Buffer,
    messageRouter: MessageRouter,
    availableFunctions: () => string[],
    workerManager: WorkerManager
  ): Promise<void> {
    const data = typeof message === "string" ? message : message.toString();

    try {
      const parsed = JSON.parse(data);

      // Check if this is a worker identifying itself
      if (parsed.type === "identify" && parsed.workerId) {
        const workerId = parsed.workerId as string;
        // Move from clients to workers
        this.bunClients.delete(ws);
        this.bunWorkers.set(workerId, ws);
        // Register the send callback for this worker
        workerManager.registerWorkerSender(workerId, (msg: string) => {
          ws.send(msg);
        });
        // Forward to worker manager
        workerManager.handleMessage(data);
        return;
      }

      // Check if this is a worker message
      if (this.bunWorkers.has(parsed.workerId)) {
        workerManager.handleMessage(data);
        return;
      }

      // If it's from a worker (ready, result, error, crash, progress messages)
      if (parsed.type === "ready" || parsed.type === "result" || parsed.type === "error" || parsed.type === "crash" || parsed.type === "progress") {
        workerManager.handleMessage(data);
        return;
      }

      // Otherwise treat as client message
      if (this.bunClients.has(ws)) {
        // Send welcome if this is the first message (client just connected)
        if (!parsed.method) {
          ws.send(JSON.stringify({
            type: "welcome",
            functions: availableFunctions(),
          }));
          return;
        }

        // Route the message
        const response = await messageRouter.routeMessage(data, parsed.id);
        ws.send(JSON.stringify(response));
      }
    } catch (error) {
      console.error("Error handling WebSocket message:", error);
    }
  }

  /**
   * Handle Bun WebSocket close event
   */
  handleWebSocketClose(ws: ServerWebSocket<unknown>): void {
    // Remove from clients
    this.bunClients.delete(ws);

    // Check if it was a worker
    for (const [workerId, workerWs] of this.bunWorkers.entries()) {
      if (workerWs === ws) {
        this.bunWorkers.delete(workerId);
        break;
      }
    }
  }

  // ... additional methods for Hono WebSocket handlers omitted for brevity
}
```

---

### 6. src/lib/rpc/managers/message_router.ts

```typescript
/**
 * MessageRouter
 *
 * Routes incoming WebSocket messages to appropriate handlers.
 * Handles:
 * - Message type detection (script, MCP, RPC)
 * - Routing to appropriate handler
 * - Response construction
 * - Error handling
 */

import { execute_llm_script } from "../../execute_llm_script.ts";
import type { McpIntegrationManager } from "./mcp_integration_manager.ts";
import type { WorkerManager } from "../worker_manager.ts";

interface RpcMessage {
  method: string;
  args?: unknown;
  id?: string;
}

interface ScriptMessage {
  script: string;
  sessionId?: string;
  id?: string;
}

export interface RpcResponse {
  result?: unknown;
  error?: string;
  id?: string;
}

export class MessageRouter {
  constructor(
    private workerManager: WorkerManager,
    private mcpIntegrationManager: McpIntegrationManager
  ) {}

  /**
   * Route incoming message to appropriate handler
   */
  async routeMessage(data: string, messageId?: string): Promise<RpcResponse> {
    try {
      console.error("📨 WebSocket received message");
      const parsed = JSON.parse(data);
      console.error(
        `📋 Parsed message type: ${
          "script" in parsed ? "SCRIPT" : "RPC"
        }`,
        { id: parsed.id }
      );

      const response: RpcResponse = { id: messageId || parsed.id };

      // Check if this is a script execution request
      if ("script" in parsed) {
        return await this.handleScriptMessage(parsed, response);
      } else {
        // Handle as RPC or MCP call
        return await this.handleRpcOrMcpMessage(parsed, response);
      }
    } catch (error) {
      console.error("❌ Message routing error:", error);
      return {
        error: "Invalid message format",
        id: messageId,
      };
    }
  }

  /**
   * Handle script execution message
   */
  private async handleScriptMessage(
    parsed: ScriptMessage,
    response: RpcResponse
  ): Promise<RpcResponse> {
    console.error("🎬 Starting script execution...");
    console.error(`📄 Script length: ${parsed.script.length} chars`);

    const result = await execute_llm_script({
      script: parsed.script,
      sessionId: parsed.sessionId,
    });

    console.error("✅ Script execution completed", {
      success: result.success,
    });

    if (result.success) {
      response.result = result.output;
    } else {
      response.error = result.error;
    }

    return response;
  }

  /**
   * Handle RPC call via worker
   */
  private async handleRpcMessage(
    msg: RpcMessage,
    response: RpcResponse
  ): Promise<RpcResponse> {
    if (!msg.method.includes(".")) {
      response.error = `Invalid method format: ${msg.method}. Expected: namespace.functionName`;
    } else {
      const [namespace, functionName] = msg.method.split(".");

      try {
        // Pass the client's call ID for progress routing
        const result = await this.workerManager.callFunction(
          namespace,
          functionName,
          msg.args || {},
          msg.id // Original client call ID for progress routing
        );
        response.result = result;
      } catch (error) {
        response.error =
          error instanceof Error ? error.message : String(error);
      }
    }

    return response;
  }
}
```

---

### 7. src/lib/rpc/managers/rpc_cache_manager.ts

```typescript
/**
 * RpcCacheManager
 *
 * Manages RPC file discovery, caching, and change notifications.
 * Handles:
 * - Discovering RPC files from configured directory
 * - Extracting function signatures from files
 * - Caching namespace → file mappings
 * - Invalidating cache on changes
 * - Notifying subscribers of function updates
 */

import type { RpcFile } from "../load_rpc_files.ts";
import { discover_rpc_files } from "../load_rpc_files.ts";

export class RpcCacheManager {
  private rpcFiles = new Map<string, RpcFile>();
  private refreshCallbacks: Array<(functions: string[]) => void> = [];

  /**
   * Discover RPC files and refresh the cache with their function signatures
   * Returns array of namespaced function names (e.g., ["filedb.get", "filedb.set"])
   */
  async refreshCache(): Promise<string[]> {
    try {
      const { TypeExtractor } = await import(
        "../../type_system/type_extractor.ts"
      );

      const files = await discover_rpc_files();
      const extractor = new TypeExtractor();

      // Clear existing cache
      this.rpcFiles.clear();

      // Rebuild function cache with namespaced method names
      for (const file of files) {
        try {
          const result = extractor.extractFromFile(file.path);
          for (const func of result.functions) {
            const namespacedMethod = `${file.name}.${func.name}`;
            this.rpcFiles.set(namespacedMethod, file);
          }
        } catch {
          // Ignore individual file errors
          continue;
        }
      }

      const functionNames = Array.from(this.rpcFiles.keys());

      // Notify all subscribers
      for (const callback of this.refreshCallbacks) {
        try {
          callback(functionNames);
        } catch (err) {
          console.error("Error in cache refresh callback:", err);
        }
      }

      return functionNames;
    } catch (err) {
      console.error("Failed to refresh RPC cache:", err);
      return [];
    }
  }

  /**
   * Get unique RPC files (one per file path)
   * Returns Map keyed by file path
   */
  getUniqueFiles(): Map<string, RpcFile> {
    const uniqueFiles = new Map<string, RpcFile>();
    for (const file of this.rpcFiles.values()) {
      uniqueFiles.set(file.path, file);
    }
    return uniqueFiles;
  }

  /**
   * Get array of all namespaced function names
   */
  getFunctionNames(): string[] {
    return Array.from(this.rpcFiles.keys());
  }

  /**
   * Register a callback to be invoked when cache is refreshed
   * Callback receives array of function names
   */
  onCacheRefreshed(callback: (functions: string[]) => void): void {
    this.refreshCallbacks.push(callback);
  }
}
```

---

### 8. mcp-bridge.ts (Client connecting to server)

```typescript
#!/usr/bin/env bun
/**
 * MCP Bridge Server
 *
 * This MCP server bridges Claude Code to the lootbox RPC server.
 * It discovers tools from the lootbox server and exposes them as MCP tools.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const LOOTBOX_URL = process.env.LOOTBOX_URL || "ws://localhost:3456/ws";
const LOOTBOX_HTTP = LOOTBOX_URL.replace("ws://", "http://").replace("wss://", "https://").replace("/ws", "");

// Call a function via WebSocket with progress support
async function callFunction(
  namespace: string,
  funcName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;

    try {
      ws = new WebSocket(LOOTBOX_URL);
    } catch (error) {
      reject(new Error(`Failed to create WebSocket connection to ${LOOTBOX_URL}: ${error}`));
      return;
    }

    const callId = `call_${Date.now()}`;
    let timeout: ReturnType<typeof setTimeout>;
    let connectionTimeout: ReturnType<typeof setTimeout>;

    // Helper to reset the timeout - called when progress is received
    const resetTimeout = (timeoutMs: number = 60000) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`RPC call timeout for ${namespace}.${funcName} (no progress for ${timeoutMs / 1000}s)`));
      }, timeoutMs);
    };

    // Connection timeout - if we don't connect within 5 seconds, fail
    connectionTimeout = setTimeout(() => {
      ws.close();
      reject(new Error(`WebSocket connection timeout. Cannot connect to ${LOOTBOX_URL}. Is the lootbox server running on port 3456?`));
    }, 5000);

    ws.onopen = () => {
      clearTimeout(connectionTimeout);

      ws.send(
        JSON.stringify({
          method: `${namespace}.${funcName}`,
          args: args,
          id: callId,
        })
      );

      // Initial timeout of 30s, will be reset on progress
      resetTimeout(30000);
    };

    ws.onmessage = (event) => {
      try {
        const response = JSON.parse(event.data);
        if (response.type === "welcome") return;

        // Handle progress messages - reset timeout to allow more time
        if (response.type === "progress" && response.id === callId) {
          console.error(`[MCP Bridge] Progress for ${namespace}.${funcName}: ${response.message}`);
          resetTimeout(60000); // Reset to 60s on each progress update
          return;
        }

        if (response.id === callId) {
          clearTimeout(timeout);
          ws.close();

          if (response.error) {
            reject(new Error(`RPC error from ${namespace}.${funcName}: ${response.error}`));
          } else {
            resolve(response.result);
          }
        }
      } catch (error) {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(`Failed to parse response from ${namespace}.${funcName}: ${error}`));
      }
    };

    ws.onerror = (error) => {
      clearTimeout(connectionTimeout);
      clearTimeout(timeout);

      // Provide helpful error message
      const errorMsg = `WebSocket error connecting to ${LOOTBOX_URL}. ` +
        `Possible causes:\n` +
        `  1. Lootbox server is not running (start with: bun run src/lootbox-cli.ts server --port 3456)\n` +
        `  2. Server is running on a different port\n` +
        `  3. A stale server process is blocking the port (kill with: pkill -f "lootbox-cli.ts server")`;

      reject(new Error(errorMsg));
    };

    ws.onclose = (event) => {
      clearTimeout(connectionTimeout);
      clearTimeout(timeout);

      if (!event.wasClean && event.code !== 1000) {
        reject(new Error(`WebSocket closed unexpectedly (code: ${event.code}, reason: ${event.reason || "none"})`));
      }
    };
  });
}
```

---

### 9. src/lib/execute_llm_script.ts

```typescript
import { saveScriptRun } from "./script_history.ts";
import { get_client } from "./client_cache.ts";
import { unlink, mkdtemp, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

export const execute_llm_script = async (args: { script: string; sessionId?: string }) => {
  const { script, sessionId } = args;
  const startTime = Date.now();
  console.error("🔧 execute_llm_script: Starting execution");

  // Import client via HTTP URL with version for cache busting only when RPC files change
  const { get_config } = await import("./get_config.ts");
  const config = await get_config();
  const client = get_client();
  const clientUrl = `http://localhost:${config.port}/client.ts?v=${client.version}`;

  console.error(`📦 Using client from ${clientUrl} (version ${client.version})`);

  // Inject import statement at the top of the user script
  const injectedScript = `import { tools } from "${clientUrl}";\n\n// User script begins here\n${script}`;

  let tempFile: string | null = null;

  try {
    // Create temp file
    const tempDir = await mkdtemp(join(tmpdir(), "lootbox-script-"));
    tempFile = join(tempDir, "script.ts");
    console.error(`📁 Created temp file: ${tempFile}`);
    await writeFile(tempFile, injectedScript);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const proc = Bun.spawn(["bun", "run", tempFile], {
      stdout: "pipe",
      stderr: "pipe",
    });

    // Handle timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => {
        proc.kill();
        reject(new Error("AbortError"));
      });
    });

    const resultPromise = (async () => {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      return { exitCode, stdout, stderr };
    })();

    let result: { exitCode: number; stdout: string; stderr: string };
    try {
      result = await Promise.race([resultPromise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }

    const { exitCode, stdout: outStr, stderr: errStr } = result;

    // Clean up temp file
    if (tempFile) {
      await unlink(tempFile).catch(() => {});
    }

    // ... result handling omitted for brevity
  } catch (error) {
    // ... error handling omitted for brevity
  }
};
```

---

## Implementation Guide

### Step 1: Diagnose using HealthMonitor logs

When CPU spike occurs, check server logs for:
```
[HealthMonitor] 🔥 CPU has been high (>80%) for 15s - possible runaway process!
[HealthMonitor] Active handles (X):
[HealthMonitor]   Timer: Y
[HealthMonitor]   Socket: Z
```

High Timer count = runaway intervals/timeouts
High Socket count = WebSocket leak or worker explosion

### Step 2: Check for worker explosion

Run:
```bash
ps aux | grep "bun run" | grep lootbox_worker | wc -l
```

If count exceeds number of tool files, workers are being spawned without cleanup.

### Step 3: Verify debounce is working

Add logging to `FileWatcherManager.startWatching()`:
```typescript
// In the watch callback:
console.error(`[FileWatcher] Event: ${eventType} ${filename}`);

// In the debounce callback:
console.error(`[FileWatcher] Debounce fired with ${files.size} files`);
```

Multiple rapid saves should coalesce into single callback.

### Step 4: Check for infinite restart loops

In `WorkerManager.handleWorkerCrash()`, the backoff should prevent rapid restarts:
```typescript
const backoffMs = Math.min(1000 * Math.pow(2, worker.restartCount), 30000);
```

If a tool file has a syntax error, it should fail once and be marked `status: "failed"`, not keep retrying.

### Step 5: Monitor worker status

Add a debug endpoint or log:
```typescript
// In WorkerManager, add method:
getWorkerStatuses(): Record<string, string> {
  const statuses: Record<string, string> = {};
  for (const [id, worker] of this.workers) {
    statuses[id] = worker.status;
  }
  return statuses;
}
```

### Testing

1. **Verify debounce**: Save a file 5 times rapidly, should see only 1 worker restart
2. **Verify targeted restart**: Save `gemini.ts`, only gemini worker should restart
3. **Verify crash handling**: Add syntax error to tool, should fail once then stop retrying
4. **Monitor CPU**: Use `top -pid $(pgrep -f "lootbox-cli.ts server")` during file saves

---

## Instructions For The Next AI Agent

You are reading the "CPU Spike Investigation Expert Bundle". This file is self-contained and includes all the context you should assume you have.

Your job:

* Design and describe the minimal, safe changes needed to fully resolve the issues described in the Executive Summary and Key Problems.
* Operate **only** on the files and code snippets included in this bundle. If you need additional files or context, clearly say so.

When you propose changes, follow these rules strictly:

1. Always provide **precise code snippets** that can be copy-pasted directly into the repo.
2. Always include **exact file paths** (e.g. `src/lib/rpc/worker_manager.ts`) and, when possible, line numbers or a clear description of the location (e.g. "replace the existing `handleWorkerCrash` function").
3. Never describe code changes only in prose. Show the full function or block as it should look **after** the change, or show both "before" and "after" versions.
4. Keep instructions **unmistakable and unambiguous**. A human or tool following your instructions should not need to guess what to do.
5. Assume you cannot see any files outside this bundle. If you must rely on unknown code, explicitly note assumptions and risks.

**Known root causes to investigate:**

1. **RPC Cache Callbacks**: Multiple `onCacheRefreshed` callbacks are registered in `wireManagers()`. Each file change triggers ALL callbacks. Check if any callback is doing expensive work or triggering cascading refreshes.

2. **Worker Process Leaks**: In `startWorker()`, temp files are created but never explicitly cleaned up. Each worker restart creates a new temp file.

3. **Polling in waitForReady()**: The 100ms polling loop in `waitForReady()` runs until timeout. If workers never become ready, this burns CPU.

4. **Health Monitor Event Loop Check**: The recursive `scheduleEventLoopCheck()` uses `setImmediate` + `setTimeout`. Verify this doesn't create increasing callback pressure.

When you answer, you do not need to restate this bundle. Work directly with the code and instructions it contains and return a clear, step-by-step plan plus exact code edits.
