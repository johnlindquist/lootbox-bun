/**
 * Smoke Tests for gemini.ts
 *
 * Tests that exported functions exist, have correct signatures,
 * and validate inputs properly. Does not make actual Gemini CLI calls.
 */

import { describe, test, expect } from "bun:test";
import * as gemini from "./gemini.ts";

describe("Gemini Tool - Smoke Tests", () => {
  describe("Module exports", () => {
    // Core functions
    test("exports research function", () => {
      expect(typeof gemini.research).toBe("function");
    });

    test("exports summarize function", () => {
      expect(typeof gemini.summarize).toBe("function");
    });

    test("exports analyze_code function", () => {
      expect(typeof gemini.analyze_code).toBe("function");
    });

    test("exports compare function", () => {
      expect(typeof gemini.compare).toBe("function");
    });

    test("exports think function", () => {
      expect(typeof gemini.think).toBe("function");
    });

    test("exports extract function", () => {
      expect(typeof gemini.extract).toBe("function");
    });

    test("exports ask function", () => {
      expect(typeof gemini.ask).toBe("function");
    });

    // Web search functions
    test("exports web_search function", () => {
      expect(typeof gemini.web_search).toBe("function");
    });

    test("exports get_news function", () => {
      expect(typeof gemini.get_news).toBe("function");
    });

    test("exports lookup function", () => {
      expect(typeof gemini.lookup).toBe("function");
    });

    // Project analysis functions
    test("exports analyze_project function", () => {
      expect(typeof gemini.analyze_project).toBe("function");
    });

    test("exports evaluate_options function", () => {
      expect(typeof gemini.evaluate_options).toBe("function");
    });

    test("exports plan_implementation function", () => {
      expect(typeof gemini.plan_implementation).toBe("function");
    });

    test("exports review_code function", () => {
      expect(typeof gemini.review_code).toBe("function");
    });

    test("exports reason_through function", () => {
      expect(typeof gemini.reason_through).toBe("function");
    });

    test("exports trace_flow function", () => {
      expect(typeof gemini.trace_flow).toBe("function");
    });

    // Utility exports
    test("exports setProgressCallback function", () => {
      expect(typeof gemini.setProgressCallback).toBe("function");
    });
  });

  describe("Input validation", () => {
    test("summarize requires file_path or content", async () => {
      const result = await gemini.summarize({});

      expect(result.success).toBe(false);
      expect(result.error).toContain("No content provided");
    });

    test("summarize rejects non-existent file", async () => {
      const result = await gemini.summarize({
        file_path: "/nonexistent/file/path.txt",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("File not found");
    });

    test("analyze_code requires file_path or code", async () => {
      const result = await gemini.analyze_code({
        question: "What does this do?",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("No code provided");
    });

    test("analyze_code rejects non-existent file", async () => {
      const result = await gemini.analyze_code({
        file_path: "/nonexistent/code.ts",
        question: "What does this do?",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("File not found");
    });

    test("compare requires at least 2 items", async () => {
      const result = await gemini.compare({
        items: [{ label: "one", content: "only one" }],
        comparison_prompt: "Compare these",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("At least 2 items required");
    });

    test("compare rejects empty items array", async () => {
      const result = await gemini.compare({
        items: [],
        comparison_prompt: "Compare these",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("At least 2 items required");
    });

    test("analyze_project requires file_paths", async () => {
      const result = await gemini.analyze_project({
        file_paths: [],
        question: "What is the architecture?",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("No file paths provided");
    });

    test("analyze_project handles non-existent files", async () => {
      const result = await gemini.analyze_project({
        file_paths: ["/nonexistent/file1.ts", "/nonexistent/file2.ts"],
        question: "What is the architecture?",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Could not read any files");
    });

    test("evaluate_options requires at least 2 options", async () => {
      const result = await gemini.evaluate_options({
        problem: "Which approach?",
        options: ["only one option"],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("At least 2 options required");
    });

    test("plan_implementation handles non-existent files", async () => {
      const result = await gemini.plan_implementation({
        goal: "Add feature X",
        file_paths: ["/nonexistent/file.ts"],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Could not read any files");
    });

    test("review_code handles non-existent files", async () => {
      const result = await gemini.review_code({
        file_paths: ["/nonexistent/file.ts"],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Could not read any files");
    });

    test("trace_flow handles non-existent files", async () => {
      const result = await gemini.trace_flow({
        starting_point: "myFunction",
        file_paths: ["/nonexistent/file.ts"],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Could not read any files");
    });
  });

  describe("Progress callback", () => {
    test("setProgressCallback accepts function", () => {
      const callback = (msg: string) => console.log(msg);
      // Should not throw
      gemini.setProgressCallback(callback);
    });

    test("setProgressCallback accepts null", () => {
      // Should not throw
      gemini.setProgressCallback(null);
    });
  });

  // Skip tests that would call actual Gemini CLI (requires gemini installed)
  describe.skip("Return type structure - requires Gemini CLI", () => {
    test("research returns structured result", async () => {
      const result = await gemini.research({ prompt: "test" });

      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });

    test("think returns structured result", async () => {
      const result = await gemini.think({ problem: "test problem" });

      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });

    test("ask returns structured result", async () => {
      const result = await gemini.ask({ question: "test question" });

      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });
  });
});
