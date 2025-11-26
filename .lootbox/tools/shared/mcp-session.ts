/**
 * MCP Session Management Utilities
 *
 * Common patterns for managing MCP (Model Context Protocol) sessions,
 * including session caching, timeout handling, and request management.
 */

import { extractErrorMessage } from "./types.ts";
import type { Logger } from "./logging.ts";

/**
 * MCP session information with expiration
 */
export interface McpSession {
  id: string;
  expiresAt: number;
}

/**
 * Configuration for MCP session management
 */
export interface McpSessionConfig {
  /** Session timeout in milliseconds (default: 5 minutes) */
  sessionTtl?: number;
  /** Request timeout in milliseconds (default: 30 seconds) */
  requestTimeout?: number;
  /** Client info for initialization */
  clientInfo?: { name: string; version: string };
  /** Protocol version (default: "2024-11-05") */
  protocolVersion?: string;
}

const DEFAULT_CONFIG: Required<McpSessionConfig> = {
  sessionTtl: 5 * 60 * 1000, // 5 minutes
  requestTimeout: 30 * 1000, // 30 seconds
  clientInfo: { name: "lootbox", version: "1.0" },
  protocolVersion: "2024-11-05",
};

/**
 * Parse SSE (Server-Sent Events) response to extract JSON-RPC result
 * Common pattern for MCP-over-HTTP communication
 */
export function parseSSEResponse(text: string): { result?: unknown; error?: { message: string } } {
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const data = line.slice(6);
      if (data === "ping") continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.result) {
          return { result: parsed.result };
        }
        if (parsed.error) {
          return { error: { message: parsed.error.message || JSON.stringify(parsed.error) } };
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }
  return { error: { message: "No valid response found in SSE stream" } };
}

/**
 * Extract text content from MCP tool result
 */
export function extractMcpTextContent(result: unknown): string {
  const typed = result as { content?: Array<{ type: string; text: string }> };
  if (typed?.content && Array.isArray(typed.content)) {
    return typed.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return JSON.stringify(result);
}

/**
 * Create an MCP session manager for HTTP-based MCP servers
 *
 * Usage:
 * ```ts
 * const session = createMcpSessionManager("https://mcp.example.com", log);
 * const result = await session.callTool("my_tool", { arg: "value" });
 * ```
 */
export function createMcpSessionManager(
  baseUrl: string,
  log: Logger,
  config: McpSessionConfig = {}
) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let cachedSession: McpSession | null = null;

  /**
   * Initialize a new MCP session
   */
  async function initializeSession(): Promise<{ success: boolean; sessionId?: string; error?: string }> {
    try {
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: cfg.protocolVersion,
            capabilities: {},
            clientInfo: cfg.clientInfo,
          },
        }),
      });

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
      }

      const sessionId = response.headers.get("mcp-session-id");
      if (!sessionId) {
        return { success: false, error: "No session ID in response" };
      }

      const text = await response.text();
      const parsed = parseSSEResponse(text);

      if (parsed.error) {
        return { success: false, error: parsed.error.message };
      }

      return { success: true, sessionId };
    } catch (error) {
      return { success: false, error: extractErrorMessage(error) };
    }
  }

  /**
   * Get or create a valid session
   */
  async function getSession(): Promise<{ success: boolean; sessionId?: string; error?: string }> {
    const now = Date.now();
    if (cachedSession && cachedSession.expiresAt > now) {
      return { success: true, sessionId: cachedSession.id };
    }

    const result = await initializeSession();
    if (result.success && result.sessionId) {
      cachedSession = {
        id: result.sessionId,
        expiresAt: now + cfg.sessionTtl,
      };
    }
    return result;
  }

  /**
   * Clear the cached session (useful for retry logic)
   */
  function clearSession(): void {
    cachedSession = null;
  }

  /**
   * Call an MCP tool with automatic session management
   */
  async function callTool(
    toolName: string,
    args: Record<string, unknown>,
    retryOnSessionError = true
  ): Promise<{ success: boolean; result?: string; error?: string }> {
    log.info(`Calling MCP tool: ${toolName}`);

    const session = await getSession();
    if (!session.success || !session.sessionId) {
      log.error(toolName, session.error || "Failed to get session");
      return { success: false, error: session.error || "Failed to get session" };
    }
    log.info(`Session acquired: ${session.sessionId.substring(0, 20)}...`);

    try {
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": session.sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args,
          },
        }),
      });

      if (!response.ok) {
        // Session might have expired, clear cache and retry once
        if (retryOnSessionError && (response.status === 400 || response.status === 401)) {
          clearSession();
          return callTool(toolName, args, false);
        }
        return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
      }

      const text = await response.text();
      const parsed = parseSSEResponse(text);

      if (parsed.error) {
        return { success: false, error: parsed.error.message };
      }

      return { success: true, result: extractMcpTextContent(parsed.result) };
    } catch (error) {
      return { success: false, error: extractErrorMessage(error) };
    }
  }

  return {
    getSession,
    clearSession,
    callTool,
  };
}

/**
 * Create a timeout wrapper for async operations
 * Provides progress updates during long-running operations to prevent timeouts
 *
 * Usage:
 * ```ts
 * const withTimeout = createTimeoutWrapper(log, sendProgress);
 * const result = await withTimeout(async () => {
 *   // long-running operation
 * }, 60000);
 * ```
 */
export function createTimeoutWrapper(
  log: Logger,
  sendProgress?: (message: string) => void,
  progressInterval = 5000
) {
  return async function withTimeout<T>(
    operation: () => Promise<T>,
    timeout: number,
    operationName = "operation"
  ): Promise<{ success: true; result: T } | { success: false; error: string }> {
    const startTime = Date.now();

    // Progress reporter
    let progressTimer: ReturnType<typeof setInterval> | null = null;
    if (sendProgress) {
      sendProgress(`Starting ${operationName}...`);
      progressTimer = setInterval(() => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        sendProgress(`${operationName} processing... (${elapsed}s elapsed)`);
      }, progressInterval);
    }

    // Timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${operationName} timed out after ${timeout}ms`));
      }, timeout);
    });

    try {
      const result = await Promise.race([operation(), timeoutPromise]);

      if (sendProgress) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        sendProgress(`${operationName} completed in ${elapsed}s`);
      }

      return { success: true, result };
    } catch (error) {
      log.error(operationName, extractErrorMessage(error));
      return { success: false, error: extractErrorMessage(error) };
    } finally {
      if (progressTimer) {
        clearInterval(progressTimer);
      }
    }
  };
}

/**
 * Request manager for stdio-based MCP servers
 * Manages pending requests with timeout handling
 */
export function createRequestManager(timeout: number = 30000) {
  let requestId = 0;
  const pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  return {
    /**
     * Get next request ID
     */
    nextId(): number {
      return ++requestId;
    },

    /**
     * Register a pending request with timeout
     */
    register(
      id: number,
      resolve: (value: unknown) => void,
      reject: (error: Error) => void
    ): void {
      const timeoutHandle = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error("Request timed out"));
      }, timeout);

      pendingRequests.set(id, { resolve, reject, timeout: timeoutHandle });
    },

    /**
     * Resolve a pending request
     */
    resolve(id: number, result: unknown): boolean {
      const pending = pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingRequests.delete(id);
        pending.resolve(result);
        return true;
      }
      return false;
    },

    /**
     * Reject a pending request
     */
    reject(id: number, error: Error): boolean {
      const pending = pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingRequests.delete(id);
        pending.reject(error);
        return true;
      }
      return false;
    },

    /**
     * Check if a request is pending
     */
    hasPending(id: number): boolean {
      return pendingRequests.has(id);
    },

    /**
     * Clear all pending requests
     */
    clear(): void {
      for (const [id, pending] of pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Request manager cleared"));
      }
      pendingRequests.clear();
    },
  };
}
