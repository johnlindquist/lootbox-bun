/**
 * Resilience Patterns: Circuit Breaker + Retry with Exponential Backoff
 *
 * Protects against cascading failures when external services (Claude, Codex, Gemini)
 * are unavailable or slow.
 */

// @ts-expect-error - opossum types don't match ES module default export
import CircuitBreaker from "opossum";
import {
  logger,
  createComponentLogger,
} from "./logger.ts";
import {
  updateCircuitBreakerState,
  recordAgentCall,
} from "./metrics.ts";

const log = createComponentLogger("resilience");

// ============== Retry Configuration ==============

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in ms (default: 30000) */
  maxDelayMs?: number;
  /** Jitter factor 0-1 to randomize delays (default: 0.1) */
  jitter?: number;
  /** Function to determine if error is retryable */
  isRetryable?: (error: Error) => boolean;
  /** Called on each failed attempt */
  onRetry?: (error: Error, attempt: number) => void;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitter: 0.1,
  isRetryable: defaultIsRetryable,
  onRetry: () => {},
};

/**
 * Default retry logic - retry on network/timeout errors, not on validation errors
 */
function defaultIsRetryable(error: Error): boolean {
  const message = error.message.toLowerCase();

  // Retryable errors
  if (
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("rate limit") ||
    message.includes("429") ||
    message.includes("503") ||
    message.includes("502")
  ) {
    return true;
  }

  // Non-retryable errors
  if (
    message.includes("401") ||
    message.includes("403") ||
    message.includes("validation") ||
    message.includes("invalid") ||
    message.includes("not found")
  ) {
    return false;
  }

  // Default: retry unknown errors
  return true;
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: number
): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const clampedDelay = Math.min(exponentialDelay, maxDelayMs);
  const jitterAmount = clampedDelay * jitter * (Math.random() * 2 - 1);
  return Math.max(0, clampedDelay + jitterAmount);
}

/**
 * Execute a function with retry and exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry if not retryable or last attempt
      if (attempt === opts.maxRetries || !opts.isRetryable(lastError)) {
        throw lastError;
      }

      // Calculate delay and wait
      const delay = calculateDelay(
        attempt,
        opts.baseDelayMs,
        opts.maxDelayMs,
        opts.jitter
      );

      log.warn(
        {
          attempt: attempt + 1,
          maxRetries: opts.maxRetries,
          delayMs: Math.round(delay),
          error: lastError.message,
        },
        "Retrying after error"
      );

      opts.onRetry(lastError, attempt + 1);
      await sleep(delay);
    }
  }

  throw lastError || new Error("Retry failed with no error");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============== Circuit Breaker Configuration ==============

export interface CircuitBreakerOptions {
  /** Timeout for each request in ms (default: 30000) */
  timeout?: number;
  /** Error percentage threshold to open circuit (default: 50) */
  errorThresholdPercentage?: number;
  /** Time in ms to wait before testing circuit (default: 30000) */
  resetTimeout?: number;
  /** Minimum requests before error threshold applies (default: 5) */
  volumeThreshold?: number;
}

const DEFAULT_BREAKER_OPTIONS: Required<CircuitBreakerOptions> = {
  timeout: 30000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  volumeThreshold: 5,
};

// Store circuit breakers per service
const breakers = new Map<string, CircuitBreaker>();

/**
 * Get or create a circuit breaker for a service
 */
export function getCircuitBreaker(
  serviceName: string,
  options: CircuitBreakerOptions = {}
): CircuitBreaker {
  if (!breakers.has(serviceName)) {
    const opts = { ...DEFAULT_BREAKER_OPTIONS, ...options };

    const breaker = new CircuitBreaker(
      async <T>(fn: () => Promise<T>) => fn(),
      {
        timeout: opts.timeout,
        errorThresholdPercentage: opts.errorThresholdPercentage,
        resetTimeout: opts.resetTimeout,
        volumeThreshold: opts.volumeThreshold,
        name: serviceName,
      }
    );

    // Set up event handlers for observability
    breaker.on("open", () => {
      log.error({ service: serviceName }, "Circuit breaker OPENED");
      updateCircuitBreakerState(serviceName, 1);
    });

    breaker.on("halfOpen", () => {
      log.info({ service: serviceName }, "Circuit breaker half-open (testing)");
      updateCircuitBreakerState(serviceName, 2);
    });

    breaker.on("close", () => {
      log.info({ service: serviceName }, "Circuit breaker CLOSED (healthy)");
      updateCircuitBreakerState(serviceName, 0);
    });

    breaker.on("fallback", () => {
      log.warn({ service: serviceName }, "Circuit breaker fallback triggered");
    });

    // Initialize metric state
    updateCircuitBreakerState(serviceName, 0);

    breakers.set(serviceName, breaker);
  }

  return breakers.get(serviceName)!;
}

/**
 * Execute a function with circuit breaker protection
 */
export async function withCircuitBreaker<T>(
  serviceName: string,
  fn: () => Promise<T>,
  options: CircuitBreakerOptions = {}
): Promise<T> {
  const breaker = getCircuitBreaker(serviceName, options);
  return breaker.fire(fn) as Promise<T>;
}

/**
 * Execute with both circuit breaker and retry
 * Retry happens INSIDE the circuit breaker (each retry counts toward breaker stats)
 */
export async function withResilience<T>(
  serviceName: string,
  fn: () => Promise<T>,
  options: {
    retry?: RetryOptions;
    circuitBreaker?: CircuitBreakerOptions;
  } = {}
): Promise<T> {
  const startTime = Date.now();

  try {
    const result = await withCircuitBreaker(
      serviceName,
      () => withRetry(fn, options.retry),
      options.circuitBreaker
    );

    recordAgentCall(serviceName, "success", Date.now() - startTime);
    return result;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    const errorType = categorizeError(errorMessage);

    recordAgentCall(
      serviceName,
      "error",
      Date.now() - startTime,
      errorType
    );
    throw error;
  }
}

/**
 * Categorize error for metrics
 */
function categorizeError(message: string): string {
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes("timeout")) return "timeout";
  if (lowerMessage.includes("circuit") && lowerMessage.includes("open"))
    return "circuit_open";
  if (lowerMessage.includes("rate limit") || lowerMessage.includes("429"))
    return "rate_limit";
  if (lowerMessage.includes("network") || lowerMessage.includes("econn"))
    return "network";
  if (lowerMessage.includes("auth") || lowerMessage.includes("401"))
    return "auth";

  return "unknown";
}

/**
 * Get circuit breaker stats for a service
 */
export function getCircuitBreakerStats(serviceName: string): {
  state: "closed" | "open" | "half-open";
  failures: number;
  successes: number;
  fallbacks: number;
} | null {
  const breaker = breakers.get(serviceName);
  if (!breaker) return null;

  const stats = breaker.stats;
  return {
    state: breaker.opened ? "open" : breaker.halfOpen ? "half-open" : "closed",
    failures: stats.failures,
    successes: stats.successes,
    fallbacks: stats.fallbacks,
  };
}

/**
 * Get all circuit breaker stats
 */
export function getAllCircuitBreakerStats(): Record<
  string,
  ReturnType<typeof getCircuitBreakerStats>
> {
  const result: Record<string, ReturnType<typeof getCircuitBreakerStats>> = {};
  for (const [name] of breakers) {
    result[name] = getCircuitBreakerStats(name);
  }
  return result;
}

/**
 * Reset a circuit breaker (useful for testing)
 */
export function resetCircuitBreaker(serviceName: string): void {
  const breaker = breakers.get(serviceName);
  if (breaker) {
    breaker.close();
  }
}

/**
 * Clear all circuit breakers (useful for testing)
 */
export function clearAllCircuitBreakers(): void {
  for (const breaker of breakers.values()) {
    breaker.shutdown();
  }
  breakers.clear();
}
