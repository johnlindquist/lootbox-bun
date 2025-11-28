/**
 * Structured Logging with Correlation IDs
 *
 * Uses pino for high-performance JSON logging with AsyncLocalStorage
 * for automatic trace ID propagation across async boundaries.
 */

// @ts-expect-error - pino types don't match ES module default export
import pino from "pino";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "crypto";

// Request context for correlation IDs
export interface RequestContext {
  traceId: string;
  tool?: string;
  method?: string;
  startTime?: number;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

// Create the main logger instance
export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport:
    process.env.MODE === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
  base: {
    pid: process.pid,
    env: process.env.NODE_ENV || "development",
  },
  // Automatically inject traceId from context into every log
  mixin() {
    const ctx = requestContext.getStore();
    if (ctx) {
      return {
        traceId: ctx.traceId,
        ...(ctx.tool && { tool: ctx.tool }),
        ...(ctx.method && { method: ctx.method }),
      };
    }
    return {};
  },
  // Format timestamps as ISO strings
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Generate a new trace ID
 */
export function generateTraceId(): string {
  return randomUUID().slice(0, 8); // Short ID for readability
}

/**
 * Run a function within a traced context
 * All logs within the function will automatically include the traceId
 */
export function withTrace<T>(traceId: string, fn: () => T): T {
  return requestContext.run({ traceId, startTime: Date.now() }, fn);
}

/**
 * Run an async function within a traced context
 */
export async function withTraceAsync<T>(
  traceId: string,
  fn: () => Promise<T>
): Promise<T> {
  return requestContext.run({ traceId, startTime: Date.now() }, fn);
}

/**
 * Get the current trace context
 */
export function getTraceContext(): RequestContext | undefined {
  return requestContext.getStore();
}

/**
 * Update the current trace context with additional info
 */
export function enrichTrace(updates: Partial<RequestContext>): void {
  const ctx = requestContext.getStore();
  if (ctx) {
    Object.assign(ctx, updates);
  }
}

/**
 * Create a child logger for a specific component
 */
export function createComponentLogger(component: string) {
  return logger.child({ component });
}

// Export typed logger for convenience
export type Logger = typeof logger;
