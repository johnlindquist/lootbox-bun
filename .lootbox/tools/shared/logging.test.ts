/**
 * Tests for shared/logging.ts
 *
 * Integration tests for the logger factory using temp directories.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logging.ts";

let tempDir: string;

describe("createLogger", () => {
  beforeEach(() => {
    // Create a unique temp directory for each test
    tempDir = `/tmp/lootbox-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test("creates log directory if it doesn't exist", () => {
    const log = createLogger("test-tool", tempDir);
    log.info("test message");

    expect(existsSync(tempDir)).toBe(true);
  });

  test("creates log file with correct name", () => {
    const log = createLogger("my-tool", tempDir);
    log.info("hello");

    const logFile = join(tempDir, "my-tool.log");
    expect(existsSync(logFile)).toBe(true);
  });

  test("logs info messages with correct format", () => {
    const log = createLogger("format-test", tempDir);
    log.info("Test info message");

    const logFile = join(tempDir, "format-test.log");
    const content = readFileSync(logFile, "utf-8");

    // Check format: [timestamp] [INFO] ℹ️ message
    expect(content).toContain("[INFO]");
    expect(content).toContain("ℹ️ Test info message");
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T/); // ISO timestamp
  });

  test("logs call with function name and args", () => {
    const log = createLogger("call-test", tempDir);
    log.call("myFunction", { arg1: "value1", arg2: 42 });

    const logFile = join(tempDir, "call-test.log");
    const content = readFileSync(logFile, "utf-8");

    expect(content).toContain("[CALL]");
    expect(content).toContain("📞 myFunction");
    expect(content).toContain('"arg1":"value1"');
    expect(content).toContain('"arg2":42');
  });

  test("logs success with result preview", () => {
    const log = createLogger("success-test", tempDir);
    log.success("getData", { users: [1, 2, 3] });

    const logFile = join(tempDir, "success-test.log");
    const content = readFileSync(logFile, "utf-8");

    expect(content).toContain("[SUCCESS]");
    expect(content).toContain("✅ getData");
    expect(content).toContain("users");
  });

  test("truncates long string results", () => {
    const log = createLogger("truncate-string-test", tempDir);

    const longString = "x".repeat(500);
    log.success("longResult", longString);

    const logFile = join(tempDir, "truncate-string-test.log");
    const content = readFileSync(logFile, "utf-8");

    expect(content).toContain("...");
    // String should be truncated to 200 chars + "..."
    expect(content).not.toContain("x".repeat(300));
  });

  test("truncates long JSON results", () => {
    const log = createLogger("truncate-json-test", tempDir);

    const largeObject = { data: "x".repeat(500) };
    log.success("bigObject", largeObject);

    const logFile = join(tempDir, "truncate-json-test.log");
    const content = readFileSync(logFile, "utf-8");

    // JSON should be truncated at 200 chars
    expect(content.length).toBeLessThan(500);
  });

  test("logs error with function name and message", () => {
    const log = createLogger("error-test", tempDir);
    log.error("fetchData", "Network connection failed");

    const logFile = join(tempDir, "error-test.log");
    const content = readFileSync(logFile, "utf-8");

    expect(content).toContain("[ERROR]");
    expect(content).toContain("❌ fetchData");
    expect(content).toContain("Network connection failed");
  });

  test("logs warn messages", () => {
    const log = createLogger("warn-test", tempDir);
    log.warn("Session expiring soon");

    const logFile = join(tempDir, "warn-test.log");
    const content = readFileSync(logFile, "utf-8");

    expect(content).toContain("[WARN]");
    expect(content).toContain("⚠️ Session expiring soon");
  });

  test("logs debug messages", () => {
    const log = createLogger("debug-test", tempDir);
    log.debug("Variable x = 42");

    const logFile = join(tempDir, "debug-test.log");
    const content = readFileSync(logFile, "utf-8");

    expect(content).toContain("[DEBUG]");
    expect(content).toContain("🔍 Variable x = 42");
  });

  test("appends multiple log entries", () => {
    const log = createLogger("multi-test", tempDir);

    log.info("First message");
    log.info("Second message");
    log.info("Third message");

    const logFile = join(tempDir, "multi-test.log");
    const content = readFileSync(logFile, "utf-8");
    const lines = content.trim().split("\n");

    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("First message");
    expect(lines[1]).toContain("Second message");
    expect(lines[2]).toContain("Third message");
  });

  test("different tools write to different files", () => {
    const log1 = createLogger("tool-a", tempDir);
    const log2 = createLogger("tool-b", tempDir);

    log1.info("Message from A");
    log2.info("Message from B");

    const fileA = join(tempDir, "tool-a.log");
    const fileB = join(tempDir, "tool-b.log");

    expect(existsSync(fileA)).toBe(true);
    expect(existsSync(fileB)).toBe(true);
    expect(readFileSync(fileA, "utf-8")).toContain("Message from A");
    expect(readFileSync(fileB, "utf-8")).toContain("Message from B");
  });

  test("handles special characters in messages", () => {
    const log = createLogger("special-chars", tempDir);
    log.info('Message with "quotes" and \\ backslashes');

    const logFile = join(tempDir, "special-chars.log");
    const content = readFileSync(logFile, "utf-8");

    expect(content).toContain("quotes");
    expect(content).toContain("backslashes");
  });

  test("handles unicode in messages", () => {
    const log = createLogger("unicode-test", tempDir);
    log.info("Hello 你好 🎉 مرحبا");

    const logFile = join(tempDir, "unicode-test.log");
    const content = readFileSync(logFile, "utf-8");

    expect(content).toContain("你好");
    expect(content).toContain("🎉");
  });
});
