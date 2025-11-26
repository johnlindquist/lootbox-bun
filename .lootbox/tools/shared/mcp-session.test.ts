/**
 * Tests for shared/mcp-session.ts
 *
 * Unit tests for SSE parsing, content extraction, session management,
 * timeout wrapper, and request manager.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  parseSSEResponse,
  extractMcpTextContent,
  createMcpSessionManager,
  createTimeoutWrapper,
  createRequestManager,
} from "./mcp-session.ts";
import {
  createMockLogger,
  createSSEResponse,
  createMcpResultResponse,
  createMcpErrorResponse,
  createMcpTextContent,
  saveFetch,
  restoreFetch,
} from "./test-utils.ts";

describe("parseSSEResponse", () => {
  test("parses valid result response", () => {
    const sse = 'data: {"result": {"value": 42}}\n\n';
    const parsed = parseSSEResponse(sse);
    expect(parsed.result).toEqual({ value: 42 });
    expect(parsed.error).toBeUndefined();
  });

  test("parses error response", () => {
    const sse = 'data: {"error": {"message": "Something failed"}}\n\n';
    const parsed = parseSSEResponse(sse);
    expect(parsed.error?.message).toBe("Something failed");
    expect(parsed.result).toBeUndefined();
  });

  test("skips ping messages", () => {
    const sse = 'data: ping\ndata: {"result": "actual"}\n\n';
    const parsed = parseSSEResponse(sse);
    expect(parsed.result).toBe("actual");
  });

  test("handles multiple data lines", () => {
    const sse = 'data: {"ignored": true}\ndata: {"result": "second"}\n\n';
    const parsed = parseSSEResponse(sse);
    // Should return first valid result
    expect(parsed.result).toBe("second");
  });

  test("handles malformed JSON gracefully", () => {
    const sse = "data: {not valid json}\n\n";
    const parsed = parseSSEResponse(sse);
    expect(parsed.error?.message).toBe("No valid response found in SSE stream");
  });

  test("handles empty response", () => {
    const parsed = parseSSEResponse("");
    expect(parsed.error?.message).toBe("No valid response found in SSE stream");
  });

  test("handles response with only ping", () => {
    const sse = "data: ping\n\n";
    const parsed = parseSSEResponse(sse);
    expect(parsed.error?.message).toBe("No valid response found in SSE stream");
  });

  test("extracts error without message property", () => {
    const sse = 'data: {"error": {"code": 500}}\n\n';
    const parsed = parseSSEResponse(sse);
    expect(parsed.error?.message).toContain("500");
  });
});

describe("extractMcpTextContent", () => {
  test("extracts text from MCP content array", () => {
    const result = {
      content: [
        { type: "text", text: "Hello" },
        { type: "text", text: " World" },
      ],
    };
    expect(extractMcpTextContent(result)).toBe("Hello\n World");
  });

  test("filters out non-text content", () => {
    const result = {
      content: [
        { type: "image", data: "base64..." },
        { type: "text", text: "Just text" },
      ],
    };
    expect(extractMcpTextContent(result)).toBe("Just text");
  });

  test("returns JSON string for non-standard results", () => {
    const result = { data: "raw data" };
    expect(extractMcpTextContent(result)).toBe('{"data":"raw data"}');
  });

  test("handles empty content array", () => {
    const result = { content: [] };
    expect(extractMcpTextContent(result)).toBe("");
  });

  test("handles null/undefined", () => {
    expect(extractMcpTextContent(null)).toBe("null");
    expect(extractMcpTextContent(undefined)).toBe(undefined);
  });
});

describe("createMcpSessionManager", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("initializes session and caches it", async () => {
    const log = createMockLogger();
    let fetchCount = 0;

    globalThis.fetch = mock(async () => {
      fetchCount++;
      return createMcpResultResponse({ initialized: true }, "session-abc");
    }) as typeof fetch;

    const session = createMcpSessionManager("https://mcp.test", log);

    // First call initializes
    const result1 = await session.getSession();
    expect(result1.success).toBe(true);
    expect(result1.sessionId).toBe("session-abc");
    expect(fetchCount).toBe(1);

    // Second call uses cache
    const result2 = await session.getSession();
    expect(result2.success).toBe(true);
    expect(result2.sessionId).toBe("session-abc");
    expect(fetchCount).toBe(1); // Still 1, used cache
  });

  test("clears session on demand", async () => {
    const log = createMockLogger();
    let fetchCount = 0;

    globalThis.fetch = mock(async () => {
      fetchCount++;
      return createMcpResultResponse({ ok: true }, `session-${fetchCount}`);
    }) as typeof fetch;

    const session = createMcpSessionManager("https://mcp.test", log);

    await session.getSession();
    expect(fetchCount).toBe(1);

    session.clearSession();

    const result = await session.getSession();
    expect(fetchCount).toBe(2);
    expect(result.sessionId).toBe("session-2");
  });

  test("handles initialization failure", async () => {
    const log = createMockLogger();

    globalThis.fetch = mock(async () => {
      return new Response(null, { status: 500, statusText: "Internal Error" });
    }) as typeof fetch;

    const session = createMcpSessionManager("https://mcp.test", log);
    const result = await session.getSession();

    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });

  test("handles missing session ID", async () => {
    const log = createMockLogger();

    globalThis.fetch = mock(async () => {
      // Response without mcp-session-id header
      return new Response('data: {"result": true}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const session = createMcpSessionManager("https://mcp.test", log);
    const result = await session.getSession();

    expect(result.success).toBe(false);
    expect(result.error).toContain("No session ID");
  });

  test("callTool retries on 401", async () => {
    const log = createMockLogger();
    let callCount = 0;

    globalThis.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        // First: successful init
        return createMcpResultResponse({ init: true }, "session-1");
      } else if (callCount === 2) {
        // Second: tool call fails with 401
        return new Response(null, { status: 401, statusText: "Unauthorized" });
      } else if (callCount === 3) {
        // Third: re-init
        return createMcpResultResponse({ init: true }, "session-2");
      } else {
        // Fourth: successful tool call
        return createMcpResultResponse(
          createMcpTextContent("Success!"),
          "session-2"
        );
      }
    }) as typeof fetch;

    const session = createMcpSessionManager("https://mcp.test", log);
    const result = await session.callTool("test_tool", { arg: "value" });

    expect(result.success).toBe(true);
    expect(result.result).toContain("Success!");
    expect(callCount).toBe(4); // init, fail, re-init, success
  });

  test("callTool returns error from MCP response", async () => {
    const log = createMockLogger();
    let callCount = 0;

    globalThis.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return createMcpResultResponse({ init: true }, "session-1");
      }
      return createMcpErrorResponse("Tool execution failed", "session-1");
    }) as typeof fetch;

    const session = createMcpSessionManager("https://mcp.test", log);
    const result = await session.callTool("failing_tool", {});

    expect(result.success).toBe(false);
    expect(result.error).toBe("Tool execution failed");
  });
});

describe("createTimeoutWrapper", () => {
  test("returns result for fast operations", async () => {
    const log = createMockLogger();
    const withTimeout = createTimeoutWrapper(log);

    const result = await withTimeout(
      async () => "fast result",
      1000,
      "fastOp"
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toBe("fast result");
    }
  });

  test("times out slow operations", async () => {
    const log = createMockLogger();
    const withTimeout = createTimeoutWrapper(log);

    const result = await withTimeout(
      async () => {
        await new Promise((r) => setTimeout(r, 200));
        return "too slow";
      },
      50, // 50ms timeout
      "slowOp"
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("timed out");
      expect(result.error).toContain("slowOp");
    }
  });

  test("calls progress callback", async () => {
    const log = createMockLogger();
    const progressMessages: string[] = [];
    const sendProgress = (msg: string) => progressMessages.push(msg);

    const withTimeout = createTimeoutWrapper(log, sendProgress, 50);

    await withTimeout(
      async () => {
        await new Promise((r) => setTimeout(r, 120));
        return "done";
      },
      500,
      "progressOp"
    );

    expect(progressMessages.length).toBeGreaterThanOrEqual(2);
    expect(progressMessages[0]).toContain("Starting progressOp");
    expect(progressMessages.some((m) => m.includes("processing"))).toBe(true);
  });

  test("handles operation errors", async () => {
    const log = createMockLogger();
    const withTimeout = createTimeoutWrapper(log);

    const result = await withTimeout(
      async () => {
        throw new Error("Operation failed");
      },
      1000,
      "failingOp"
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Operation failed");
    }
  });
});

describe("createRequestManager", () => {
  test("generates incrementing IDs", () => {
    const manager = createRequestManager();

    expect(manager.nextId()).toBe(1);
    expect(manager.nextId()).toBe(2);
    expect(manager.nextId()).toBe(3);
  });

  test("registers and resolves requests", async () => {
    const manager = createRequestManager();
    const id = manager.nextId();

    const promise = new Promise((resolve, reject) => {
      manager.register(id, resolve, reject);
    });

    expect(manager.hasPending(id)).toBe(true);

    manager.resolve(id, "success!");

    expect(manager.hasPending(id)).toBe(false);
    await expect(promise).resolves.toBe("success!");
  });

  test("registers and rejects requests", async () => {
    const manager = createRequestManager();
    const id = manager.nextId();

    const promise = new Promise((resolve, reject) => {
      manager.register(id, resolve, reject);
    });

    manager.reject(id, new Error("Failed!"));

    expect(manager.hasPending(id)).toBe(false);
    await expect(promise).rejects.toThrow("Failed!");
  });

  test("times out unresolved requests", async () => {
    const manager = createRequestManager(50); // 50ms timeout
    const id = manager.nextId();

    const promise = new Promise((resolve, reject) => {
      manager.register(id, resolve, reject);
    });

    // Wait for timeout
    await expect(promise).rejects.toThrow("Request timed out");
    expect(manager.hasPending(id)).toBe(false);
  });

  test("resolve returns false for unknown ID", () => {
    const manager = createRequestManager();
    expect(manager.resolve(999, "value")).toBe(false);
  });

  test("reject returns false for unknown ID", () => {
    const manager = createRequestManager();
    expect(manager.reject(999, new Error("err"))).toBe(false);
  });

  test("clear rejects all pending requests", async () => {
    const manager = createRequestManager(10000); // Long timeout

    const promises = [1, 2, 3].map((i) => {
      const id = manager.nextId();
      return new Promise((resolve, reject) => {
        manager.register(id, resolve, reject);
      });
    });

    manager.clear();

    for (const promise of promises) {
      await expect(promise).rejects.toThrow("Request manager cleared");
    }
  });
});
