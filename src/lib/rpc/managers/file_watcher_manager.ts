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
 * - Backoff for files that fail repeatedly (prevents infinite restart loops)
 */

import { watch, type FSWatcher } from "fs";
import { join } from "path";

interface FailedFileInfo {
  failCount: number;
  lastAttempt: number;
  nextAllowed: number; // Timestamp when next attempt is allowed
}

// Configuration
const MAX_FAIL_COUNT = 5; // After this many failures, file is blocked until manually changed
const INITIAL_BACKOFF_MS = 1000; // 1 second
const MAX_BACKOFF_MS = 60000; // 60 seconds

export class FileWatcherManager {
  private watcher: FSWatcher | null = null;
  private watching = false;
  private pendingFiles = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private failedFiles = new Map<string, FailedFileInfo>();

  /**
   * Check if a file is in backoff (should not be reloaded yet)
   */
  isFileInBackoff(filePath: string): boolean {
    const info = this.failedFiles.get(filePath);
    if (!info) return false;

    const now = Date.now();

    // If we're past the next allowed time, reset on next change
    if (now >= info.nextAllowed) {
      return false;
    }

    return true;
  }

  /**
   * Record a file failure (worker failed to start)
   * Returns true if the file is now blocked
   */
  recordFailure(filePath: string): boolean {
    const now = Date.now();
    const info = this.failedFiles.get(filePath) || {
      failCount: 0,
      lastAttempt: 0,
      nextAllowed: 0,
    };

    info.failCount++;
    info.lastAttempt = now;

    // Calculate backoff with exponential growth
    const backoffMs = Math.min(
      INITIAL_BACKOFF_MS * Math.pow(2, info.failCount - 1),
      MAX_BACKOFF_MS
    );
    info.nextAllowed = now + backoffMs;

    this.failedFiles.set(filePath, info);

    const isBlocked = info.failCount >= MAX_FAIL_COUNT;
    if (isBlocked) {
      console.error(
        `[FileWatcher] File ${filePath} has failed ${info.failCount} times, blocking until manual change`
      );
    } else {
      console.error(
        `[FileWatcher] File ${filePath} failed (attempt ${info.failCount}), next retry in ${backoffMs}ms`
      );
    }

    return isBlocked;
  }

  /**
   * Record a file success (worker started successfully)
   * Clears any failure tracking
   */
  recordSuccess(filePath: string): void {
    this.failedFiles.delete(filePath);
  }

  /**
   * Reset failure tracking for a file (called when file is manually changed)
   */
  resetFileBackoff(filePath: string): void {
    this.failedFiles.delete(filePath);
  }

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

          // Reset backoff when file is manually changed
          // (user is trying to fix it)
          this.resetFileBackoff(fullPath);

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

            // Filter out files that are still in backoff
            const allowedFiles = new Set<string>();
            for (const file of files) {
              if (!this.isFileInBackoff(file)) {
                allowedFiles.add(file);
              } else {
                console.error(`[FileWatcher] Skipping ${file} - in backoff`);
              }
            }

            // Only trigger callback if there are files to process
            if (allowedFiles.size > 0) {
              await onChange(allowedFiles);
            }
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
