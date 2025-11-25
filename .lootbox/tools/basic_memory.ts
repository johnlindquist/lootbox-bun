/**
 * Basic Memory Tool - Wraps the basic-memory CLI for persistent memory storage
 *
 * This tool provides functions to interact with basic-memory, a local-first
 * knowledge management system that stores memories as markdown files.
 */

import { $ } from "bun";

// Helper to run basic-memory commands
async function runBasicMemory(args: string[]): Promise<{ success: boolean; output: string; error?: string }> {
  try {
    const result = await $`basic-memory ${args}`.quiet();
    return { success: true, output: result.text() };
  } catch (error) {
    const err = error as { stderr?: { toString(): string }; message?: string };
    return {
      success: false,
      output: "",
      error: err.stderr?.toString() || err.message || String(error)
    };
  }
}

/**
 * Write a memory to basic-memory storage
 * @param args.title - The title/permalink for the memory
 * @param args.content - The markdown content of the memory
 * @param args.folder - Optional folder to store the memory in (default: "memories")
 */
export async function write_memory(args: {
  title: string;
  content: string;
  folder?: string;
}): Promise<{ success: boolean; permalink?: string; error?: string }> {
  const { title, content, folder = "memories" } = args;

  // Create the memory content with frontmatter
  const memoryContent = `---
title: ${title}
---

${content}`;

  // Write to a temp file first, then import
  const tempFile = `/tmp/memory_${Date.now()}.md`;
  await Bun.write(tempFile, memoryContent);

  try {
    // Use basic-memory import command
    const result = await runBasicMemory(["import", tempFile, "--folder", folder]);

    // Clean up temp file
    await Bun.file(tempFile).exists() && await $`rm ${tempFile}`.quiet();

    if (result.success) {
      return { success: true, permalink: title.toLowerCase().replace(/\s+/g, "-") };
    }
    return { success: false, error: result.error };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * Read a memory by its permalink
 * @param args.permalink - The permalink of the memory to read
 */
export async function read_memory(args: {
  permalink: string;
}): Promise<{ success: boolean; content?: string; error?: string }> {
  const { permalink } = args;

  const result = await runBasicMemory(["read", permalink]);

  if (result.success) {
    return { success: true, content: result.output };
  }
  return { success: false, error: result.error };
}

/**
 * Search memories using semantic search
 * @param args.query - The search query
 * @param args.limit - Maximum number of results (default: 10)
 */
export async function search_memories(args: {
  query: string;
  limit?: number;
}): Promise<{ success: boolean; results?: string[]; error?: string }> {
  const { query, limit = 10 } = args;

  const result = await runBasicMemory(["search", query, "--limit", String(limit)]);

  if (result.success) {
    const lines = result.output.trim().split("\n").filter(line => line.trim());
    return { success: true, results: lines };
  }
  return { success: false, error: result.error };
}

/**
 * List all memories, optionally filtered by folder
 * @param args.folder - Optional folder to filter by
 */
export async function list_memories(args: {
  folder?: string;
}): Promise<{ success: boolean; memories?: string[]; error?: string }> {
  const { folder } = args;

  const cmdArgs = ["list"];
  if (folder) {
    cmdArgs.push("--folder", folder);
  }

  const result = await runBasicMemory(cmdArgs);

  if (result.success) {
    const lines = result.output.trim().split("\n").filter(line => line.trim());
    return { success: true, memories: lines };
  }
  return { success: false, error: result.error };
}

/**
 * Delete a memory by its permalink
 * @param args.permalink - The permalink of the memory to delete
 */
export async function delete_memory(args: {
  permalink: string;
}): Promise<{ success: boolean; error?: string }> {
  const { permalink } = args;

  const result = await runBasicMemory(["delete", permalink]);

  return { success: result.success, error: result.error };
}

/**
 * Sync the memory database (rebuild index)
 */
export async function sync_memories(args: Record<string, never> = {}): Promise<{ success: boolean; output?: string; error?: string }> {
  const result = await runBasicMemory(["sync"]);

  if (result.success) {
    return { success: true, output: result.output };
  }
  return { success: false, error: result.error };
}

/**
 * Get memory database status
 */
export async function memory_status(args: Record<string, never> = {}): Promise<{ success: boolean; status?: string; error?: string }> {
  const result = await runBasicMemory(["status"]);

  if (result.success) {
    return { success: true, status: result.output };
  }
  return { success: false, error: result.error };
}
