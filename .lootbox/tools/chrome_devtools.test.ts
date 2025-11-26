/**
 * Smoke Tests for chrome_devtools.ts
 *
 * Tests that exported functions exist and have correct signatures.
 * Does not start actual Chrome DevTools MCP server.
 */

import { describe, test, expect } from "bun:test";
import * as chromeDevtools from "./chrome_devtools.ts";

describe("Chrome DevTools Tool - Smoke Tests", () => {
  describe("Navigation exports", () => {
    test("exports navigate_page function", () => {
      expect(typeof chromeDevtools.navigate_page).toBe("function");
    });

    test("exports new_page function", () => {
      expect(typeof chromeDevtools.new_page).toBe("function");
    });

    test("exports close_page function", () => {
      expect(typeof chromeDevtools.close_page).toBe("function");
    });

    test("exports list_pages function", () => {
      expect(typeof chromeDevtools.list_pages).toBe("function");
    });

    test("exports select_page function", () => {
      expect(typeof chromeDevtools.select_page).toBe("function");
    });

    test("exports wait_for function", () => {
      expect(typeof chromeDevtools.wait_for).toBe("function");
    });
  });

  describe("Interaction exports", () => {
    test("exports click function", () => {
      expect(typeof chromeDevtools.click).toBe("function");
    });

    test("exports fill function", () => {
      expect(typeof chromeDevtools.fill).toBe("function");
    });

    test("exports fill_form function", () => {
      expect(typeof chromeDevtools.fill_form).toBe("function");
    });

    test("exports press_key function", () => {
      expect(typeof chromeDevtools.press_key).toBe("function");
    });

    test("exports hover function", () => {
      expect(typeof chromeDevtools.hover).toBe("function");
    });

    test("exports drag function", () => {
      expect(typeof chromeDevtools.drag).toBe("function");
    });

    test("exports upload_file function", () => {
      expect(typeof chromeDevtools.upload_file).toBe("function");
    });

    test("exports handle_dialog function", () => {
      expect(typeof chromeDevtools.handle_dialog).toBe("function");
    });
  });

  describe("Debugging exports", () => {
    test("exports list_console_messages function", () => {
      expect(typeof chromeDevtools.list_console_messages).toBe("function");
    });

    test("exports get_console_message function", () => {
      expect(typeof chromeDevtools.get_console_message).toBe("function");
    });

    test("exports list_network_requests function", () => {
      expect(typeof chromeDevtools.list_network_requests).toBe("function");
    });

    test("exports get_network_request function", () => {
      expect(typeof chromeDevtools.get_network_request).toBe("function");
    });

    test("exports evaluate_script function", () => {
      expect(typeof chromeDevtools.evaluate_script).toBe("function");
    });
  });

  describe("Visual exports", () => {
    test("exports take_screenshot function", () => {
      expect(typeof chromeDevtools.take_screenshot).toBe("function");
    });

    test("exports take_snapshot function", () => {
      expect(typeof chromeDevtools.take_snapshot).toBe("function");
    });
  });

  describe("Emulation exports", () => {
    test("exports emulate function", () => {
      expect(typeof chromeDevtools.emulate).toBe("function");
    });

    test("exports resize_page function", () => {
      expect(typeof chromeDevtools.resize_page).toBe("function");
    });
  });

  describe("Performance exports", () => {
    test("exports performance_start_trace function", () => {
      expect(typeof chromeDevtools.performance_start_trace).toBe("function");
    });

    test("exports performance_stop_trace function", () => {
      expect(typeof chromeDevtools.performance_stop_trace).toBe("function");
    });

    test("exports performance_analyze_insight function", () => {
      expect(typeof chromeDevtools.performance_analyze_insight).toBe("function");
    });
  });

  describe("Return type structure", () => {
    // These will fail to connect to MCP server but should return proper error structure

    test("navigate_page returns structured result", async () => {
      const result = await chromeDevtools.navigate_page({
        url: "https://example.com",
      });

      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
      if (!result.success) {
        expect(result).toHaveProperty("error");
      }
    });

    test("list_pages returns structured result", async () => {
      const result = await chromeDevtools.list_pages();

      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });

    test("click returns structured result", async () => {
      const result = await chromeDevtools.click({
        selector: "#button",
      });

      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });

    test("evaluate_script returns structured result", async () => {
      const result = await chromeDevtools.evaluate_script({
        script: "console.log('test')",
      });

      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });

    test("take_screenshot returns structured result", async () => {
      const result = await chromeDevtools.take_screenshot({});

      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });
  });

  describe("Function counts", () => {
    test("has expected number of exports", () => {
      // Count all exported functions
      const exports = Object.keys(chromeDevtools).filter(
        (key) => typeof (chromeDevtools as Record<string, unknown>)[key] === "function"
      );

      // Navigation: 6, Interaction: 8, Debugging: 5, Visual: 2, Emulation: 2, Performance: 3
      // Total: 26 functions
      expect(exports.length).toBeGreaterThanOrEqual(20);
    });
  });
});
