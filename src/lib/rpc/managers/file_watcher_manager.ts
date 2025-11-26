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
