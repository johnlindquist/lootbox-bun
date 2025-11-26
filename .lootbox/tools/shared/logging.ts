/**
 * Shared Logging Utilities for Lootbox Tools
 *
 * Provides consistent file-based logging across all tools.
 * Logs are written to ~/.lootbox-logs/<tool>.log
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Default log directory */
export const DEFAULT_LOG_DIR = join(process.env.HOME || "/tmp", ".lootbox-logs");

/**
 * Create a logger instance for a specific tool
 * @param toolName - Name of the tool (used for log filename)
 * @param logDir - Optional custom log directory (for testing)
 */
export function createLogger(toolName: string, logDir: string = DEFAULT_LOG_DIR) {
  const logFile = join(logDir, `${toolName}.log`);

  const writeLog = (level: string, message: string) => {
    try {
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
      const timestamp = new Date().toISOString();
      const line = `[${timestamp}] [${level}] ${message}\n`;
      appendFileSync(logFile, line);
    } catch {
      // Silent fail if logging fails
    }
  };

  return {
    /**
     * Log a function call with its arguments
     */
    call: (fn: string, args: Record<string, unknown>) => {
      writeLog("CALL", `📞 ${fn}(${JSON.stringify(args)})`);
    },

    /**
     * Log a successful result
     */
    success: (fn: string, result: unknown) => {
      const preview =
        typeof result === "string"
          ? result.substring(0, 200) + (result.length > 200 ? "..." : "")
          : JSON.stringify(result).substring(0, 200);
      writeLog("SUCCESS", `✅ ${fn} → ${preview}`);
    },

    /**
     * Log an error
     */
    error: (fn: string, error: string) => {
      writeLog("ERROR", `❌ ${fn} → ${error}`);
    },

    /**
     * Log an informational message
     */
    info: (message: string) => {
      writeLog("INFO", `ℹ️ ${message}`);
    },

    /**
     * Log a warning
     */
    warn: (message: string) => {
      writeLog("WARN", `⚠️ ${message}`);
    },

    /**
     * Log a debug message
     */
    debug: (message: string) => {
      writeLog("DEBUG", `🔍 ${message}`);
    },
  };
}

/**
 * Logger type for use in tool files
 */
export type Logger = ReturnType<typeof createLogger>;
