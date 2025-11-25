// File system abstraction layer for testability

import type { RpcFileInfo } from "./types.ts";
import { stat, readdir, realpath, watch } from "fs/promises";
import { join } from "path";

export interface FileSystemAdapter {
  discoverRpcFiles(directory: string): Promise<RpcFileInfo[]>;
  readFile(path: string): Promise<string>;
  watchFiles?(directory: string, callback: (files: RpcFileInfo[]) => void): void;
}

export class BunFileSystemAdapter implements FileSystemAdapter {
  async discoverRpcFiles(directory: string): Promise<RpcFileInfo[]> {
    const files: RpcFileInfo[] = [];

    try {
      const dirStat = await stat(directory).catch(() => null);
      if (!dirStat?.isDirectory()) {
        console.error(`RPC directory not found: ${directory}`);
        return [];
      }

      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".ts")) {
          const filePath = join(directory, entry.name);
          const absolutePath = await realpath(filePath);
          const name = entry.name.replace(".ts", "");
          const stats = await stat(absolutePath);

          files.push({
            name,
            path: absolutePath,
            lastModified: stats.mtime || new Date(),
          });
        }
      }

      console.error(`Found ${files.length} RPC files`);
      return files;
    } catch (err) {
      console.error(`Failed to discover RPC files:`, err);
      return [];
    }
  }

  async readFile(path: string): Promise<string> {
    try {
      return await Bun.file(path).text();
    } catch (error) {
      throw new Error(`Failed to read file ${path}: ${error}`);
    }
  }

  async watchFiles(directory: string, callback: (files: RpcFileInfo[]) => void): Promise<void> {
    try {
      const watcher = watch(directory, { recursive: true });
      for await (const event of watcher) {
        if (event.filename?.endsWith(".ts")) {
          const files = await this.discoverRpcFiles(directory);
          callback(files);
        }
      }
    } catch (error) {
      console.error(`Failed to watch directory ${directory}:`, error);
    }
  }
}

// Keep the old name as alias for backwards compatibility
export const DenoFileSystemAdapter = BunFileSystemAdapter;

export class MockFileSystemAdapter implements FileSystemAdapter {
  private files = new Map<string, string>();
  private directories = new Set<string>();

  addFile(path: string, content: string): void {
    this.files.set(path, content);
    // Add parent directory
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir) {
      this.directories.add(dir);
    }
  }

  addDirectory(path: string): void {
    this.directories.add(path);
  }

  discoverRpcFiles(directory: string): Promise<RpcFileInfo[]> {
    if (!this.directories.has(directory)) {
      return Promise.reject(new Error(`Directory not found: ${directory}`));
    }

    const files = Array.from(this.files.keys())
      .filter((path) => path.startsWith(directory) && path.endsWith(".ts"))
      .map((path) => ({
        name: path.split("/").pop()!.replace(".ts", ""),
        path,
        lastModified: new Date(),
      }));

    return Promise.resolve(files);
  }

  readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      return Promise.reject(new Error(`File not found: ${path}`));
    }
    return Promise.resolve(content);
  }

  // Mock implementation doesn't support watching
  watchFiles?(_directory: string, _callback: (files: RpcFileInfo[]) => void): void {
    // No-op for mock
  }

  clear(): void {
    this.files.clear();
    this.directories.clear();
  }

  listFiles(): string[] {
    return Array.from(this.files.keys());
  }
}
