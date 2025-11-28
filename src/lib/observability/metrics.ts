/**
 * Prometheus Metrics for Lootbox
 *
 * Exposes metrics for:
 * - RPC call counts and durations
 * - Worker health and status
 * - External agent (Claude, Codex, Gemini) call stats
 * - Circuit breaker states
 */

import * as client from "prom-client";

// Collect default Node.js metrics (CPU, memory, event loop)
client.collectDefaultMetrics({ prefix: "lootbox_" });

// Custom metrics registry
export const registry = client.register;

// ============== RPC Metrics ==============

export const rpcCallsTotal = new client.Counter({
  name: "lootbox_rpc_calls_total",
  help: "Total number of RPC calls",
  labelNames: ["tool", "method", "status"] as const,
});

export const rpcDuration = new client.Histogram({
  name: "lootbox_rpc_duration_seconds",
  help: "Duration of RPC calls in seconds",
  labelNames: ["tool", "method", "status"] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
});

export const rpcInFlight = new client.Gauge({
  name: "lootbox_rpc_in_flight",
  help: "Number of RPC calls currently in progress",
  labelNames: ["tool"] as const,
});

// ============== Worker Metrics ==============

export const workersTotal = new client.Gauge({
  name: "lootbox_workers_total",
  help: "Total number of workers by status",
  labelNames: ["status"] as const,
});

export const workerRestarts = new client.Counter({
  name: "lootbox_worker_restarts_total",
  help: "Total number of worker restarts",
  labelNames: ["worker", "reason"] as const,
});

export const pendingCalls = new client.Gauge({
  name: "lootbox_pending_calls",
  help: "Number of pending RPC calls across all workers",
});

// ============== External Agent Metrics ==============

export const agentCallsTotal = new client.Counter({
  name: "lootbox_agent_calls_total",
  help: "Total calls to external AI agents",
  labelNames: ["agent", "status"] as const,
});

export const agentDuration = new client.Histogram({
  name: "lootbox_agent_duration_seconds",
  help: "Duration of external agent calls in seconds",
  labelNames: ["agent"] as const,
  buckets: [1, 5, 10, 30, 60, 120, 300],
});

export const agentErrors = new client.Counter({
  name: "lootbox_agent_errors_total",
  help: "Total errors from external AI agents",
  labelNames: ["agent", "error_type"] as const,
});

// ============== Circuit Breaker Metrics ==============

export const circuitBreakerState = new client.Gauge({
  name: "lootbox_circuit_breaker_state",
  help: "Circuit breaker state (0=closed, 1=open, 2=half-open)",
  labelNames: ["service"] as const,
});

export const circuitBreakerTrips = new client.Counter({
  name: "lootbox_circuit_breaker_trips_total",
  help: "Total number of times circuit breaker opened",
  labelNames: ["service"] as const,
});

// ============== Cache Metrics ==============

export const cacheHits = new client.Counter({
  name: "lootbox_cache_hits_total",
  help: "Total cache hits",
  labelNames: ["cache_type"] as const,
});

export const cacheMisses = new client.Counter({
  name: "lootbox_cache_misses_total",
  help: "Total cache misses",
  labelNames: ["cache_type"] as const,
});

// ============== Helper Functions ==============

/**
 * Record an RPC call with timing
 */
export function recordRpcCall(
  tool: string,
  method: string,
  status: "success" | "error" | "timeout",
  durationMs: number
): void {
  rpcCallsTotal.inc({ tool, method, status });
  rpcDuration.observe({ tool, method, status }, durationMs / 1000);
}

/**
 * Start timing an RPC call (returns a function to call when done)
 */
export function startRpcTimer(
  tool: string,
  method: string
): (status: "success" | "error" | "timeout") => void {
  const start = Date.now();
  rpcInFlight.inc({ tool });

  return (status: "success" | "error" | "timeout") => {
    const durationMs = Date.now() - start;
    rpcInFlight.dec({ tool });
    recordRpcCall(tool, method, status, durationMs);
  };
}

/**
 * Update worker metrics from WorkerManager stats
 */
export function updateWorkerMetrics(stats: {
  totalWorkers: number;
  readyWorkers: number;
  failedWorkers: number;
  pendingCalls: number;
}): void {
  workersTotal.set({ status: "ready" }, stats.readyWorkers);
  workersTotal.set({ status: "failed" }, stats.failedWorkers);
  workersTotal.set(
    { status: "starting" },
    stats.totalWorkers - stats.readyWorkers - stats.failedWorkers
  );
  pendingCalls.set(stats.pendingCalls);
}

/**
 * Record an external agent call
 */
export function recordAgentCall(
  agent: string,
  status: "success" | "error" | "timeout",
  durationMs: number,
  errorType?: string
): void {
  agentCallsTotal.inc({ agent, status });
  agentDuration.observe({ agent }, durationMs / 1000);

  if (status === "error" && errorType) {
    agentErrors.inc({ agent, error_type: errorType });
  }
}

/**
 * Update circuit breaker state
 * @param state 0=closed (healthy), 1=open (blocking), 2=half-open (testing)
 */
export function updateCircuitBreakerState(
  service: string,
  state: 0 | 1 | 2
): void {
  circuitBreakerState.set({ service }, state);
  if (state === 1) {
    circuitBreakerTrips.inc({ service });
  }
}

/**
 * Get all metrics as Prometheus text format
 */
export async function getMetrics(): Promise<string> {
  return registry.metrics();
}

/**
 * Get content type for metrics response
 */
export function getMetricsContentType(): string {
  return registry.contentType;
}
