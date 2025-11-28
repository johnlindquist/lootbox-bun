/**
 * Subprocess Utilities with Timeout Handling
 *
 * Provides utilities for spawning subprocesses that properly clean up on timeout.
 * Prevents zombie processes when tool calls timeout.
 */

import type { Subprocess } from "bun";
import { createLogger } from "./logging.ts";

const log = createLogger("subprocess");

export interface SpawnWithTimeoutOptions {
  command: string;
  args: string[];
  timeoutMs: number;
  env?: Record<string, string>;
  onProgress?: (chars: number, elapsedMs: number) => void;
  progressIntervalMs?: number;
}

export interface SpawnResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

/**
 * Spawn a subprocess with proper timeout handling.
 * Kills the process if timeout is exceeded.
 *
 * @param options - Spawn options including timeout
 * @returns Result object with stdout, stderr, and success status
 */
export async function spawnWithTimeout(
  options: SpawnWithTimeoutOptions
): Promise<SpawnResult> {
  const {
    command,
    args,
    timeoutMs,
    env,
    onProgress,
    progressIntervalMs = 5000,
  } = options;

  const startTime = Date.now();
  let proc: Subprocess | null = null;
  let timedOut = false;
  let progressInterval: ReturnType<typeof setInterval> | null = null;

  try {
    proc = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: env ? { ...process.env, ...env } : process.env,
    });

    // Set up timeout to kill process
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), timeoutMs);
    });

    // Set up progress reporting
    let charCount = 0;
    if (onProgress) {
      progressInterval = setInterval(() => {
        onProgress(charCount, Date.now() - startTime);
      }, progressIntervalMs);
    }

    // Read stdout with progress tracking
    const stdoutPromise = (async () => {
      const reader = proc!.stdout.getReader();
      const decoder = new TextDecoder();
      let result = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        result += chunk;
        charCount += chunk.length;
      }

      return result;
    })();

    // Read stderr
    const stderrPromise = new Response(proc.stderr).text();

    // Race between completion and timeout
    const result = await Promise.race([
      Promise.all([stdoutPromise, stderrPromise, proc.exited]).then(
        ([stdout, stderr, exitCode]) => ({
          type: "complete" as const,
          stdout,
          stderr,
          exitCode,
        })
      ),
      timeoutPromise,
    ]);

    if (result === "timeout") {
      timedOut = true;
      log.warn(`Process timed out after ${timeoutMs}ms, killing...`);

      // Kill the process forcefully
      try {
        proc.kill(9); // SIGKILL - can't be ignored
      } catch {
        // Process may have already exited
      }

      // Wait a bit for cleanup
      await new Promise((resolve) => setTimeout(resolve, 100));

      return {
        success: false,
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: true,
        durationMs: Date.now() - startTime,
        error: `Process timed out after ${timeoutMs}ms`,
      };
    }

    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: false,
      durationMs: Date.now() - startTime,
      error: result.exitCode !== 0 ? result.stderr || `Exit code ${result.exitCode}` : undefined,
    };
  } catch (error) {
    // Make sure to kill process on any error
    if (proc) {
      try {
        proc.kill(9);
      } catch {
        // Already dead
      }
    }

    return {
      success: false,
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut,
      durationMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Clean up progress interval
    if (progressInterval) {
      clearInterval(progressInterval);
    }
  }
}

/**
 * Spawn a subprocess and stream output with progress updates.
 * Useful for long-running CLI tools like claude, codex, gemini.
 *
 * @param options - Spawn options
 * @param onChunk - Callback for each chunk of output
 * @returns Result with full output
 */
export async function spawnAndStream(
  options: Omit<SpawnWithTimeoutOptions, "onProgress">,
  onChunk?: (chunk: string, isStderr: boolean) => void
): Promise<SpawnResult> {
  const { command, args, timeoutMs, env } = options;
  const startTime = Date.now();
  let proc: Subprocess | null = null;
  let timedOut = false;

  try {
    proc = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: env ? { ...process.env, ...env } : process.env,
    });

    // Set up timeout
    let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timedOut = true;
      if (proc) {
        try {
          proc.kill(9);
        } catch {
          // Already dead
        }
      }
    }, timeoutMs);

    // Stream stdout
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const decoder = new TextDecoder();

    const readStream = async (
      stream: ReadableStream<Uint8Array>,
      chunks: string[],
      isStderr: boolean
    ) => {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        chunks.push(chunk);
        if (onChunk) {
          onChunk(chunk, isStderr);
        }
      }
    };

    await Promise.all([
      readStream(proc.stdout, stdoutChunks, false),
      readStream(proc.stderr, stderrChunks, true),
    ]);

    // Clear timeout if we completed normally
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }

    const exitCode = await proc.exited;

    if (timedOut) {
      return {
        success: false,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        exitCode: null,
        timedOut: true,
        durationMs: Date.now() - startTime,
        error: `Process timed out after ${timeoutMs}ms`,
      };
    }

    return {
      success: exitCode === 0,
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
      exitCode,
      timedOut: false,
      durationMs: Date.now() - startTime,
      error: exitCode !== 0 ? stderrChunks.join("") || `Exit code ${exitCode}` : undefined,
    };
  } catch (error) {
    if (proc) {
      try {
        proc.kill(9);
      } catch {
        // Already dead
      }
    }

    return {
      success: false,
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut,
      durationMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
