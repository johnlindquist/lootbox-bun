/**
 * Basic Memory Tool - Wraps the basic-memory CLI for persistent memory storage
 *
 * This tool provides functions to interact with basic-memory, a local-first
 * knowledge management system that stores memories as markdown files.
 */

import { $ } from "bun";

// Default project for basic-memory
const DEFAULT_PROJECT = "memory";

// Helper to run basic-memory tool commands
async function runBasicMemoryTool(args: string[], project: string = DEFAULT_PROJECT): Promise<{ success: boolean; output: string; error?: string }> {
  try {
    // basic-memory tool <command> <positional_args> --project <project> <other_options>
    const result = await $`basic-memory tool ${args} --project ${project}`.quiet();
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

// Helper to run basic-memory commands (non-tool commands like status, sync)
async function runBasicMemory(args: string[], project: string = DEFAULT_PROJECT): Promise<{ success: boolean; output: string; error?: string }> {
  try {
    // For commands like status, sync - --project goes after the command
    const [subcommand, ...rest] = args;
    const result = await $`basic-memory ${subcommand} --project ${project} ${rest}`.quiet();
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
 * Write a note to basic-memory storage
 * @param args.title - The title of the note
 * @param args.content - The markdown content of the note
 * @param args.folder - Folder to store the note in (default: "memories")
 * @param args.tags - Optional comma-separated tags
 */
export async function write_memory(args: {
  title: string;
  content: string;
  folder?: string;
  tags?: string;
}): Promise<{ success: boolean; permalink?: string; error?: string }> {
  const { title, content, folder = "memories", tags } = args;

  const cmdArgs = ["write-note", "--title", title, "--folder", folder, "--content", content];
  if (tags) {
    cmdArgs.push("--tags", tags);
  }

  const result = await runBasicMemoryTool(cmdArgs);

  if (result.success) {
    return { success: true, permalink: title.toLowerCase().replace(/\s+/g, "-") };
  }
  return { success: false, error: result.error };
}

/**
 * Read a note by its permalink/identifier
 * @param args.permalink - The permalink/path of the note to read (e.g., "memories/my-note" or just "my-note")
 */
export async function read_memory(args: {
  permalink: string;
}): Promise<{ success: boolean; content?: string; error?: string }> {
  const { permalink } = args;

  // read-note takes IDENTIFIER as positional argument
  const result = await runBasicMemoryTool(["read-note", permalink]);

  if (result.success) {
    return { success: true, content: result.output };
  }
  return { success: false, error: result.error };
}

/**
 * Search memories using semantic search
 * @param args.query - The search query
 * @param args.page_size - Maximum number of results (default: 10)
 */
export async function search_memories(args: {
  query: string;
  page_size?: number;
}): Promise<{ success: boolean; results?: string; error?: string }> {
  const { query, page_size = 10 } = args;

  // search-notes takes QUERY as positional argument
  const cmdArgs = ["search-notes", query, "--page-size", String(page_size)];
  const result = await runBasicMemoryTool(cmdArgs);

  if (result.success) {
    return { success: true, results: result.output };
  }
  return { success: false, error: result.error };
}

/**
 * Get recent activity across the knowledge base
 * @param args.page_size - Not used (kept for API compatibility). recent-activity uses --depth and --timeframe
 */
export async function list_memories(args: {
  page_size?: number;
}): Promise<{ success: boolean; memories?: string; error?: string }> {
  // recent-activity doesn't have --page-size or --project flags
  // It uses --depth (default: 1) and --timeframe (default: 7d)
  try {
    const result = await $`basic-memory tool recent-activity --depth 3 --timeframe 30d`.quiet();
    return { success: true, memories: result.text() };
  } catch (error) {
    const err = error as { stderr?: { toString(): string }; message?: string };
    return {
      success: false,
      error: err.stderr?.toString() || err.message || String(error)
    };
  }
}

/**
 * Build context for a topic or discussion
 * @param args.topic - The topic to build context for
 */
export async function build_context(args: {
  topic: string;
}): Promise<{ success: boolean; context?: string; error?: string }> {
  const { topic } = args;

  // build-context takes TOPIC as positional argument
  const result = await runBasicMemoryTool(["build-context", topic]);

  if (result.success) {
    return { success: true, context: result.output };
  }
  return { success: false, error: result.error };
}

/**
 * Sync the memory database
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
