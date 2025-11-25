/**
 * FileWatcherManager
 *
 * Manages filesystem monitoring for RPC files.
 * Handles:
 * - Watching RPC directory for file changes
 * - Debouncing rapid changes
 * - Triggering callbacks on TypeScript file modifications
 * - Lifecycle control (start/stop watching)
 */

import { watch, type FSWatcher } from "fs";

export class FileWatcherManager {
  private watcher: FSWatcher | null = null;
  private watching = false;

  /**
   * Start watching a directory for changes
   * Calls onChange callback when TypeScript files are modified (with debouncing)
   */
  startWatching(
    directory: string,
    onChange: () => Promise<void>
  ): void {
    if (this.watching) {
      console.error("File watcher already running");
      return;
    }

    try {
      this.watcher = watch(directory, { recursive: true }, async (eventType, filename) => {
        if (!this.watching) return;

        // Only react to TypeScript file changes
        if (filename?.endsWith(".ts")) {
          // Debounce rapid file changes
          await new Promise((resolve) => setTimeout(resolve, 100));
          await onChange();
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
  }

  /**
   * Check if currently watching
   */
  isWatching(): boolean {
    return this.watching;
  }
}
