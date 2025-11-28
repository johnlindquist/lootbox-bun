#!/usr/bin/env bun

/**
 * Lootbox Server Monitor & Auto-Restart Manager
 *
 * Features:
 * - Auto-restart on crash with exponential backoff
 * - Port conflict detection and resolution
 * - Graceful shutdown handling
 * - Persistent logging with rotation
 * - Health check monitoring
 * - Process lifecycle tracking
 */

import { spawn, type Subprocess } from "bun";
import { existsSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Configuration
const CONFIG = {
  PORT: 3456,
  HEALTH_CHECK_INTERVAL: 30000, // 30 seconds
  RESTART_DELAY_MS: 2000,
  MAX_RESTART_DELAY_MS: 60000,
  MAX_CONSECUTIVE_FAILURES: 5,
  LOG_DIR: join(homedir(), ".lootbox-server-logs"),
  LOOTBOX_ROOT: join(homedir(), "dev/lootbox-bun"),
};

// State
let serverProcess: Subprocess | null = null;
let isShuttingDown = false;
let consecutiveFailures = 0;
let currentRestartDelay = CONFIG.RESTART_DELAY_MS;
let lastHealthCheck = Date.now();

// Ensure log directory exists
if (!existsSync(CONFIG.LOG_DIR)) {
  mkdirSync(CONFIG.LOG_DIR, { recursive: true });
}

/**
 * Log to file with timestamp
 */
function log(level: "INFO" | "WARN" | "ERROR", message: string) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}\n`;

  // Log to console
  console.error(logMessage.trim());

  // Log to file
  const logFile = join(CONFIG.LOG_DIR, `server-${new Date().toISOString().split('T')[0]}.log`);
  appendFileSync(logFile, logMessage);
}

/**
 * Check if a port is in use
 */
async function isPortInUse(port: number): Promise<boolean> {
  try {
    const proc = spawn({
      cmd: ["lsof", "-i", `:${port}`],
      stdout: "pipe",
      stderr: "pipe",
    });

    const text = await new Response(proc.stdout).text();
    await proc.exited;

    return text.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Kill processes using a specific port
 */
async function killProcessOnPort(port: number): Promise<boolean> {
  try {
    log("INFO", `Attempting to free port ${port}...`);

    // Get PIDs using the port
    const lsofProc = spawn({
      cmd: ["lsof", "-ti", `:${port}`],
      stdout: "pipe",
      stderr: "pipe",
    });

    const pidsText = await new Response(lsofProc.stdout).text();
    const pids = pidsText.trim().split('\n').filter(Boolean);

    if (pids.length === 0) {
      log("INFO", `Port ${port} is already free`);
      return true;
    }

    // Kill each process
    for (const pid of pids) {
      log("WARN", `Killing process ${pid} using port ${port}`);
      const killProc = spawn({
        cmd: ["kill", "-9", pid],
        stdout: "pipe",
        stderr: "pipe",
      });
      await killProc.exited;
    }

    // Wait a bit for processes to die
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Verify port is free
    const stillInUse = await isPortInUse(port);
    if (!stillInUse) {
      log("INFO", `Successfully freed port ${port}`);
      return true;
    } else {
      log("ERROR", `Failed to free port ${port}`);
      return false;
    }
  } catch (error) {
    log("ERROR", `Error killing processes on port ${port}: ${error}`);
    return false;
  }
}

/**
 * Health check for the server
 */
async function checkHealth(): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${CONFIG.PORT}/health`, {
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      const data = await response.json();
      return data.status === "ok";
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Start the lootbox server
 */
async function startServer(): Promise<boolean> {
  try {
    log("INFO", "Starting lootbox server...");

    // Check for port conflicts
    if (await isPortInUse(CONFIG.PORT)) {
      log("WARN", `Port ${CONFIG.PORT} is in use, attempting to free it...`);
      const freed = await killProcessOnPort(CONFIG.PORT);
      if (!freed) {
        log("ERROR", `Cannot start server - port ${CONFIG.PORT} is still in use`);
        return false;
      }
    }

    // Start the server
    serverProcess = spawn({
      cmd: ["bun", "run", "src/lootbox-cli.ts", "server", "--port", CONFIG.PORT.toString()],
      cwd: CONFIG.LOOTBOX_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        NODE_ENV: "production",
      },
    });

    // Pipe output to logs
    (async () => {
      if (!serverProcess?.stdout) return;
      const reader = serverProcess.stdout.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          text.split('\n').filter(Boolean).forEach(line => {
            log("INFO", `[SERVER] ${line}`);
          });
        }
      } catch (err) {
        // Stream closed
      }
    })();

    (async () => {
      if (!serverProcess?.stderr) return;
      const reader = serverProcess.stderr.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          text.split('\n').filter(Boolean).forEach(line => {
            log("INFO", `[SERVER] ${line}`);
          });
        }
      } catch (err) {
        // Stream closed
      }
    })();

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Verify it's running
    const healthy = await checkHealth();
    if (healthy) {
      log("INFO", `Server started successfully on port ${CONFIG.PORT}`);
      consecutiveFailures = 0;
      currentRestartDelay = CONFIG.RESTART_DELAY_MS;
      lastHealthCheck = Date.now();
      return true;
    } else {
      log("ERROR", "Server started but health check failed");
      return false;
    }
  } catch (error) {
    log("ERROR", `Failed to start server: ${error}`);
    return false;
  }
}

/**
 * Stop the server gracefully
 */
async function stopServer(): Promise<void> {
  if (!serverProcess) return;

  log("INFO", "Stopping server gracefully...");

  try {
    // Send SIGTERM for graceful shutdown
    serverProcess.kill("SIGTERM");

    // Wait up to 10 seconds for graceful shutdown
    const timeout = setTimeout(() => {
      if (serverProcess) {
        log("WARN", "Server didn't stop gracefully, forcing shutdown...");
        serverProcess.kill("SIGKILL");
      }
    }, 10000);

    await serverProcess.exited;
    clearTimeout(timeout);

    log("INFO", "Server stopped");
  } catch (error) {
    log("ERROR", `Error stopping server: ${error}`);
    if (serverProcess) {
      serverProcess.kill("SIGKILL");
    }
  } finally {
    serverProcess = null;
  }
}

/**
 * Monitor server process and restart if needed
 */
async function monitorServer(): Promise<void> {
  while (!isShuttingDown) {
    // Check if process is still running
    if (serverProcess) {
      const exited = serverProcess.exitCode !== null;

      if (exited) {
        const exitCode = serverProcess.exitCode;
        log("ERROR", `Server process exited with code ${exitCode}`);
        serverProcess = null;

        // Handle restart with backoff
        consecutiveFailures++;
        if (consecutiveFailures >= CONFIG.MAX_CONSECUTIVE_FAILURES) {
          log("ERROR", `Server failed ${consecutiveFailures} times consecutively. Stopping monitor.`);
          process.exit(1);
        }

        log("INFO", `Waiting ${currentRestartDelay}ms before restart (attempt ${consecutiveFailures})...`);
        await new Promise(resolve => setTimeout(resolve, currentRestartDelay));

        // Exponential backoff
        currentRestartDelay = Math.min(currentRestartDelay * 2, CONFIG.MAX_RESTART_DELAY_MS);

        // Try to restart
        const started = await startServer();
        if (!started) {
          log("ERROR", "Failed to restart server");
        }
      } else {
        // Periodic health check
        const now = Date.now();
        if (now - lastHealthCheck > CONFIG.HEALTH_CHECK_INTERVAL) {
          const healthy = await checkHealth();
          if (!healthy) {
            log("WARN", "Health check failed, restarting server...");
            await stopServer();
            await startServer();
          } else {
            consecutiveFailures = 0; // Reset on successful health check
          }
          lastHealthCheck = now;
        }
      }
    } else if (!isShuttingDown) {
      // No server process, try to start
      const started = await startServer();
      if (!started) {
        consecutiveFailures++;
        if (consecutiveFailures >= CONFIG.MAX_CONSECUTIVE_FAILURES) {
          log("ERROR", `Failed to start server after ${consecutiveFailures} attempts. Exiting.`);
          process.exit(1);
        }

        log("INFO", `Waiting ${currentRestartDelay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, currentRestartDelay));
        currentRestartDelay = Math.min(currentRestartDelay * 2, CONFIG.MAX_RESTART_DELAY_MS);
      }
    }

    // Small delay between checks
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
  log("INFO", `Received ${signal}, initiating graceful shutdown...`);
  isShuttingDown = true;

  await stopServer();

  log("INFO", "Monitor shutdown complete");
  process.exit(0);
}

// Register signal handlers
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

// Handle uncaught errors
process.on("uncaughtException", (error) => {
  log("ERROR", `Uncaught exception: ${error.stack || error}`);
});

process.on("unhandledRejection", (reason) => {
  log("ERROR", `Unhandled rejection: ${reason}`);
});

// Start monitoring
log("INFO", "Starting lootbox server monitor...");
log("INFO", `Configuration: PORT=${CONFIG.PORT}, HEALTH_CHECK_INTERVAL=${CONFIG.HEALTH_CHECK_INTERVAL}ms`);
log("INFO", `Log directory: ${CONFIG.LOG_DIR}`);

monitorServer().catch(error => {
  log("ERROR", `Monitor failed: ${error}`);
  process.exit(1);
});