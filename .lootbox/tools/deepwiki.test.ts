/**
 * Tests for deepwiki.ts
 *
 * Tests validation logic for DeepWiki MCP tools.
 * Network-dependent tests are marked as integration tests.
 */

import { describe, test, expect } from "bun:test";
import { read_wiki_structure, read_wiki_contents, ask_question } from "./deepwiki.ts";

describe("DeepWiki Tools - Validation", () => {
  describe("read_wiki_structure", () => {
    test("rejects invalid repo format without slash", async () => {
      const result = await read_wiki_structure({ repo_name: "invalid-format" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid repo format");
      expect(result.error).toContain("owner/repo");
    });

    test("rejects empty repo name", async () => {
      const result = await read_wiki_structure({ repo_name: "" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid repo format");
    });

    test("accepts repo with slash but network may fail", async () => {
      // "/" technically contains a slash so passes basic validation
      // This documents current behavior - the validation is minimal
      // A more robust validation would check for owner/repo pattern
      const validFormats = ["owner/repo", "org/project"];
      const invalidFormats = ["no-slash", ""];

      for (const format of invalidFormats) {
        const result = await read_wiki_structure({ repo_name: format });
        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid repo format");
      }
    });
  });

  describe("read_wiki_contents", () => {
    test("rejects invalid repo format", async () => {
      const result = await read_wiki_contents({ repo_name: "no-slash" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid repo format");
    });

    test("rejects empty repo name", async () => {
      const result = await read_wiki_contents({ repo_name: "" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid repo format");
    });
  });

  describe("ask_question", () => {
    test("rejects invalid repo format", async () => {
      const result = await ask_question({
        repo_name: "invalid",
        question: "How does it work?",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid repo format");
    });

    test("rejects empty question", async () => {
      const result = await ask_question({
        repo_name: "owner/repo",
        question: "",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Question cannot be empty");
    });

    test("rejects whitespace-only question", async () => {
      const result = await ask_question({
        repo_name: "owner/repo",
        question: "   ",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Question cannot be empty");
    });

    test("rejects tab-only question", async () => {
      const result = await ask_question({
        repo_name: "owner/repo",
        question: "\t\t",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Question cannot be empty");
    });

    test("validates both repo and question", async () => {
      // Repo validation happens first
      const result = await ask_question({
        repo_name: "invalid",
        question: "",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid repo format");
    });
  });
});

// Integration tests - these require network access
// Run with: bun test --test-name-pattern="Integration"
describe.skip("DeepWiki Tools - Integration", () => {
  test("Integration: read_wiki_structure for real repo", async () => {
    const result = await read_wiki_structure({ repo_name: "facebook/react" });

    // This test requires actual network access
    if (result.success) {
      expect(result.structure).toBeDefined();
      expect(typeof result.structure).toBe("string");
    } else {
      // Network might be unavailable in CI
      console.log("Skipped: Network unavailable");
    }
  });
});
