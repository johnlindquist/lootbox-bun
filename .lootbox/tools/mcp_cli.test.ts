/**
 * Smoke Tests for mcp_cli.ts
 *
 * Tests that exported functions exist and have correct signatures.
 * Does not make actual MCP CLI calls.
 */

import { describe, test, expect } from "bun:test";
import * as mcpCli from "./mcp_cli.ts";

describe("MCP CLI Tool - Smoke Tests", () => {
  describe("Module exports", () => {
    test("exports call_tool_sse function", () => {
      expect(typeof mcpCli.call_tool_sse).toBe("function");
    });

    test("exports call_tool_http function", () => {
      expect(typeof mcpCli.call_tool_http).toBe("function");
    });

    test("exports read_resource_sse function", () => {
      expect(typeof mcpCli.read_resource_sse).toBe("function");
    });

    test("exports get_prompt_sse function", () => {
      expect(typeof mcpCli.get_prompt_sse).toBe("function");
    });
  });

  describe("Return type structure", () => {
    // These will fail at CLI level but should return proper error structure

    test("call_tool_sse returns structured result", async () => {
      const result = await mcpCli.call_tool_sse({
        endpoint: "https://mcp.example.com/sse",
        tool_name: "test_tool",
      });

      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
      if (!result.success) {
        expect(result).toHaveProperty("error");
        expect(typeof result.error).toBe("string");
      }
    });

    test("call_tool_http returns structured result", async () => {
      const result = await mcpCli.call_tool_http({
        endpoint: "https://mcp.example.com/mcp",
        tool_name: "test_tool",
      });

      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });

    test("read_resource_sse returns structured result", async () => {
      const result = await mcpCli.read_resource_sse({
        endpoint: "https://mcp.example.com/sse",
        resource_uri: "resource://test",
      });

      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });

    test("get_prompt_sse returns structured result", async () => {
      const result = await mcpCli.get_prompt_sse({
        endpoint: "https://mcp.example.com/sse",
        prompt_name: "test_prompt",
      });

      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });
  });

  describe("Parameter handling", () => {
    test("call_tool_sse accepts optional tool_args", async () => {
      const result = await mcpCli.call_tool_sse({
        endpoint: "https://mcp.example.com/sse",
        tool_name: "test_tool",
        tool_args: { key: "value" },
      });

      expect(result).toHaveProperty("success");
    });

    test("call_tool_http accepts optional tool_args", async () => {
      const result = await mcpCli.call_tool_http({
        endpoint: "https://mcp.example.com/mcp",
        tool_name: "test_tool",
        tool_args: { key: "value" },
      });

      expect(result).toHaveProperty("success");
    });

    test("get_prompt_sse accepts optional prompt_args", async () => {
      const result = await mcpCli.get_prompt_sse({
        endpoint: "https://mcp.example.com/sse",
        prompt_name: "test_prompt",
        prompt_args: { arg1: "value1" },
      });

      expect(result).toHaveProperty("success");
    });
  });

  describe("Function count", () => {
    test("exports exactly 4 functions", () => {
      const exports = Object.keys(mcpCli).filter(
        (key) => typeof (mcpCli as Record<string, unknown>)[key] === "function"
      );

      expect(exports.length).toBe(4);
      expect(exports).toContain("call_tool_sse");
      expect(exports).toContain("call_tool_http");
      expect(exports).toContain("read_resource_sse");
      expect(exports).toContain("get_prompt_sse");
    });
  });
});
