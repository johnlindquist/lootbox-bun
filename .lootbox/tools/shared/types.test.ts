/**
 * Tests for shared/types.ts
 *
 * Tests the pure utility functions: ok, err, extractErrorMessage
 */

import { describe, test, expect } from "bun:test";
import { ok, err, extractErrorMessage, type ToolResult } from "./types.ts";

describe("ok()", () => {
  test("creates successful result with data", () => {
    const result = ok({ foo: "bar" });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ foo: "bar" });
    expect(result.error).toBeUndefined();
  });

  test("works with primitive values", () => {
    expect(ok(42).data).toBe(42);
    expect(ok("hello").data).toBe("hello");
    expect(ok(true).data).toBe(true);
    expect(ok(null).data).toBeNull();
  });

  test("works with arrays", () => {
    const result = ok([1, 2, 3]);
    expect(result.data).toEqual([1, 2, 3]);
  });

  test("type inference works correctly", () => {
    const result: ToolResult<string> = ok("test");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("test");
    }
  });
});

describe("err()", () => {
  test("creates error result with message", () => {
    const result = err("Something went wrong");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Something went wrong");
  });

  test("does not include data field", () => {
    const result = err("error");
    expect("data" in result).toBe(false);
  });

  test("works with generic type parameter", () => {
    const result: ToolResult<{ foo: string }> = err("failed");
    expect(result.success).toBe(false);
    expect(result.error).toBe("failed");
  });
});

describe("extractErrorMessage()", () => {
  test("extracts message from Error objects", () => {
    const error = new Error("Something failed");
    expect(extractErrorMessage(error)).toBe("Something failed");
  });

  test("extracts message from TypeError", () => {
    const error = new TypeError("Invalid type");
    expect(extractErrorMessage(error)).toBe("Invalid type");
  });

  test("returns string as-is", () => {
    expect(extractErrorMessage("Just a string")).toBe("Just a string");
  });

  test("extracts message property from plain objects", () => {
    const error = { message: "Object error" };
    expect(extractErrorMessage(error)).toBe("Object error");
  });

  test("extracts stderr from objects with stderr buffer", () => {
    const error = {
      stderr: {
        toString: () => "stderr output",
      },
    };
    expect(extractErrorMessage(error)).toBe("stderr output");
  });

  test("prefers stderr over message when both present", () => {
    const error = {
      stderr: { toString: () => "stderr output" },
      message: "message output",
    };
    expect(extractErrorMessage(error)).toBe("stderr output");
  });

  test("stringifies objects without message or stderr", () => {
    const error = { code: 500, reason: "internal" };
    const result = extractErrorMessage(error);
    expect(result).toContain("code");
    expect(result).toContain("500");
  });

  test("handles null", () => {
    expect(extractErrorMessage(null)).toBe("null");
  });

  test("handles undefined", () => {
    expect(extractErrorMessage(undefined)).toBe("undefined");
  });

  test("handles numbers", () => {
    expect(extractErrorMessage(42)).toBe("42");
    expect(extractErrorMessage(0)).toBe("0");
  });

  test("handles boolean values", () => {
    expect(extractErrorMessage(true)).toBe("true");
    expect(extractErrorMessage(false)).toBe("false");
  });

  test("handles empty object", () => {
    const result = extractErrorMessage({});
    expect(result).toBe("{}");
  });

  test("handles nested error objects", () => {
    const error = {
      message: "Outer error",
      cause: { message: "Inner error" },
    };
    expect(extractErrorMessage(error)).toBe("Outer error");
  });
});
