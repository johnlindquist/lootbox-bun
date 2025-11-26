/**
 * Shared Types for Lootbox Tools
 *
 * Provides consistent response types and common interfaces across all tools.
 */

/**
 * Standard result type for all tool operations
 * Use this as the base return type for tool functions
 */
export type ToolResult<T = unknown> = {
  success: boolean;
  error?: string;
} & (
  | { success: true; data: T }
  | { success: false; data?: never }
);

/**
 * Helper to create a successful result
 */
export function ok<T>(data: T): ToolResult<T> {
  return { success: true, data };
}

/**
 * Helper to create an error result
 */
export function err<T = unknown>(error: string): ToolResult<T> {
  return { success: false, error };
}

/**
 * Progress callback type for streaming updates
 * Used by tools that support progress reporting during long operations
 */
export type ProgressCallback = (message: string) => void;

/**
 * Common options for tools that support timeouts
 */
export interface TimeoutOptions {
  /** Timeout in milliseconds */
  timeout?: number;
}

/**
 * Common options for tools that support pagination
 */
export interface PaginationOptions {
  /** Number of results per page */
  pageSize?: number;
  /** Page number or offset */
  page?: number;
}

/**
 * MCP session information
 */
export interface McpSession {
  id: string;
  expiresAt: number;
}

/**
 * Standard error extraction from various error types
 */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    const err = error as { stderr?: { toString(): string }; message?: string };
    return err.stderr?.toString() || err.message || JSON.stringify(error);
  }
  return String(error);
}
