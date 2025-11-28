/**
 * Observability Module - Centralized exports
 *
 * Provides:
 * - Structured logging with correlation IDs
 * - Prometheus metrics
 * - Circuit breaker + retry resilience patterns
 */

// Logger exports
export {
  logger,
  createComponentLogger,
  generateTraceId,
  withTrace,
  withTraceAsync,
  getTraceContext,
  enrichTrace,
  requestContext,
  type RequestContext,
  type Logger,
} from "./logger.ts";

// Metrics exports
export {
  registry,
  getMetrics,
  getMetricsContentType,
  // RPC metrics
  rpcCallsTotal,
  rpcDuration,
  rpcInFlight,
  recordRpcCall,
  startRpcTimer,
  // Worker metrics
  workersTotal,
  workerRestarts,
  pendingCalls,
  updateWorkerMetrics,
  // Agent metrics
  agentCallsTotal,
  agentDuration,
  agentErrors,
  recordAgentCall,
  // Circuit breaker metrics
  circuitBreakerState,
  circuitBreakerTrips,
  updateCircuitBreakerState,
  // Cache metrics
  cacheHits,
  cacheMisses,
} from "./metrics.ts";

// Resilience exports
export {
  withRetry,
  withCircuitBreaker,
  withResilience,
  getCircuitBreaker,
  getCircuitBreakerStats,
  getAllCircuitBreakerStats,
  resetCircuitBreaker,
  clearAllCircuitBreakers,
  type RetryOptions,
  type CircuitBreakerOptions,
} from "./resilience.ts";
