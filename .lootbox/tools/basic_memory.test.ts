/**
 * Smoke Tests for basic_memory.ts
 *
 * Tests that exported functions exist and have correct signatures.
 * Does not make actual CLI calls - those require basic-memory installed.
 */

import { describe, test, expect } from "bun:test";
import * as basicMemory from "./basic_memory.ts";

describe("Basic Memory Tool - Smoke Tests", () => {
  describe("Module exports", () => {
    test("exports write_memory function", () => {
      expect(typeof basicMemory.write_memory).toBe("function");
    });

    test("exports read_memory function", () => {
      expect(typeof basicMemory.read_memory).toBe("function");
    });

    test("exports search_memories function", () => {
      expect(typeof basicMemory.search_memories).toBe("function");
    });

    test("exports list_memories function", () => {
      expect(typeof basicMemory.list_memories).toBe("function");
    });

    test("exports build_context function", () => {
      expect(typeof basicMemory.build_context).toBe("function");
    });

    test("exports sync_memories function", () => {
      expect(typeof basicMemory.sync_memories).toBe("function");
    });

    test("exports memory_status function", () => {
      expect(typeof basicMemory.memory_status).toBe("function");
    });
  });

  describe("Return type structure", () => {
    // These tests verify the functions return proper result objects
    // They'll fail at the CLI level but should return structured errors

    test("write_memory returns result object", async () => {
      const result = await basicMemory.write_memory({
        title: "Test Note",
        content: "Test content",
      });

      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
      // Either has permalink (success) or error (failure)
      if (!result.success) {
        expect(result).toHaveProperty("error");
        expect(typeof result.error).toBe("string");
      }
    });

    test("read_memory returns result object", async () => {
      const result = await basicMemory.read_memory({
        permalink: "test-note",
      });

      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });

    test("search_memories returns result object", async () => {
      const result = await basicMemory.search_memories({
        query: "test query",
      });

      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });

    test("list_memories returns result object", async () => {
      const result = await basicMemory.list_memories({});

      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });

    test("build_context returns result object", async () => {
      const result = await basicMemory.build_context({
        topic: "test topic",
      });

      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });

    test("sync_memories returns result object", async () => {
      const result = await basicMemory.sync_memories();

      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });

    test("memory_status returns result object", async () => {
      const result = await basicMemory.memory_status();

      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });
  });

  describe("Parameter handling", () => {
    test("write_memory accepts optional folder", async () => {
      const result = await basicMemory.write_memory({
        title: "Test",
        content: "Content",
        folder: "custom-folder",
      });

      expect(result).toHaveProperty("success");
    });

    test("write_memory accepts optional tags", async () => {
      const result = await basicMemory.write_memory({
        title: "Test",
        content: "Content",
        tags: "tag1,tag2",
      });

      expect(result).toHaveProperty("success");
    });

    test("search_memories accepts optional page_size", async () => {
      const result = await basicMemory.search_memories({
        query: "test",
        page_size: 5,
      });

      expect(result).toHaveProperty("success");
    });
  });
});
