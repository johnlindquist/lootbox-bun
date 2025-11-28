/**
 * Client Context - Thread-local storage for client working directory
 *
 * The lootbox server runs in a different directory than the client (Claude Code).
 * Tools need to know the client's working directory for operations like:
 * - Code map generation (which repo to analyze)
 * - File operations (relative paths)
 * - Git operations (which repo)
 *
 * The mcp-bridge injects `_client_cwd` into all RPC calls.
 * This module provides a way to access it from anywhere in the tool code.
 *
 * Usage in tools:
 * ```ts
 * import { getClientCwd, withClientContext } from "./shared/client-context.ts";
 *
 * // Option 1: Extract from args directly
 * export async function myTool(args: { path?: string; _client_cwd?: string }) {
 *   const basePath = args.path || getClientCwd(args);
 *   // ...
 * }
 *
 * // Option 2: For internal functions that don't have args
 * const cwd = getClientCwd(); // Returns stored cwd or process.cwd()
 * ```
 */

import { createLogger } from "./logging.ts";

const log = createLogger("client_context");

// ============================================================================
// THREAD SAFETY NOTE
// ============================================================================
// This global variable is SAFE because:
// 1. Bun workers are single-threaded (like Node.js)
// 2. Each worker handles one RPC call at a time via IPC
// 3. The set → execute → clear pattern is synchronous per-call
// 4. No concurrent access is possible within a single worker
//
// The flow is:
//   1. Worker receives IPC message with _client_cwd
//   2. setClientCwd() is called BEFORE the tool function executes
//   3. Tool function runs (may call getClientCwd() multiple times)
//   4. clearClientContext() is called in finally block AFTER function completes
//   5. Worker is ready for next call
// ============================================================================

let _currentClientCwd: string | null = null;

/**
 * Set the client working directory for the current call
 * Called by the worker before executing a tool function
 */
export function setClientCwd(cwd: string | null): void {
  _currentClientCwd = cwd;
  if (cwd) {
    log.debug(`Client CWD set to: ${cwd}`);
  }
}

/**
 * Get the client working directory
 *
 * @param args - Optional args object that may contain _client_cwd
 * @returns The client's working directory, falling back to process.cwd()
 */
export function getClientCwd(args?: { _client_cwd?: string }): string {
  // Priority:
  // 1. Explicit _client_cwd in args
  // 2. Stored client cwd from context
  // 3. Fallback to process.cwd() (for local testing)

  if (args?._client_cwd) {
    return args._client_cwd;
  }

  if (_currentClientCwd) {
    return _currentClientCwd;
  }

  // Fallback for local testing or when bridge doesn't inject cwd
  return process.cwd();
}

/**
 * Clear the client context after a call completes
 */
export function clearClientContext(): void {
  _currentClientCwd = null;
}

/**
 * Execute a function with client context set
 * Ensures context is cleaned up after execution
 */
export async function withClientContext<T>(
  clientCwd: string | null | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const previousCwd = _currentClientCwd;
  try {
    if (clientCwd) {
      setClientCwd(clientCwd);
    }
    return await fn();
  } finally {
    _currentClientCwd = previousCwd;
  }
}

/**
 * Extract _client_cwd from args and remove it
 * Returns clean args without the internal field
 */
export function extractClientCwd<T extends Record<string, unknown>>(
  args: T
): { clientCwd: string | null; cleanArgs: Omit<T, "_client_cwd"> } {
  const { _client_cwd, ...cleanArgs } = args as T & { _client_cwd?: string };
  return {
    clientCwd: _client_cwd || null,
    cleanArgs: cleanArgs as Omit<T, "_client_cwd">,
  };
}
