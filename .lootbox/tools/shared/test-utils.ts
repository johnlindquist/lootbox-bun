/**
 * Test Utilities for Lootbox Tools
 *
 * Provides mocking helpers and test fixtures for MCP tool testing.
 */

import { mock } from "bun:test";

/**
 * Create a mock logger that captures calls without writing to disk
 */
export function createMockLogger() {
  return {
    call: mock(() => {}),
    success: mock(() => {}),
    error: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    debug: mock(() => {}),
  };
}

/**
 * Create a mock SSE Response for MCP testing
 */
export function createSSEResponse(
  data: unknown,
  sessionId = "test-session-123"
): Response {
  const sseString = `data: ${JSON.stringify(data)}\n\n`;
  return new Response(sseString, {
    status: 200,
    headers: {
      "mcp-session-id": sessionId,
      "content-type": "text/event-stream",
    },
  });
}

/**
 * Create a mock MCP result response
 */
export function createMcpResultResponse(result: unknown, sessionId?: string): Response {
  return createSSEResponse({ result }, sessionId);
}

/**
 * Create a mock MCP error response
 */
export function createMcpErrorResponse(message: string, sessionId?: string): Response {
  return createSSEResponse({ error: { message } }, sessionId);
}

/**
 * Create a mock HTTP error response
 */
export function createHttpErrorResponse(
  status: number,
  statusText: string
): Response {
  return new Response(null, { status, statusText });
}

/**
 * Create a mock MCP text content result
 */
export function createMcpTextContent(text: string): unknown {
  return {
    content: [{ type: "text", text }],
  };
}

/**
 * Helper to create a temporary directory for testing file operations
 */
export function createTempDir(): string {
  const tempDir = `/tmp/lootbox-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return tempDir;
}

/**
 * Mock fetch with a sequence of responses
 */
export function mockFetchSequence(responses: Response[]): void {
  let callIndex = 0;
  (globalThis.fetch as unknown) = mock(() => {
    const response = responses[callIndex];
    callIndex++;
    return Promise.resolve(response);
  });
}

/**
 * Restore original fetch
 */
let originalFetch: typeof fetch | null = null;

export function saveFetch(): void {
  originalFetch = globalThis.fetch;
}

export function restoreFetch(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
}
