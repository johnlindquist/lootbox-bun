/**
 * HealthMonitor
 *
 * Monitors server health and resource usage.
 * Detects runaway processes, high CPU, memory leaks.
 *
 * Logs warnings when thresholds are exceeded.
 */

import { cpus } from "os";

interface HealthMetrics {
  timestamp: number;
  cpuUsage: NodeJS.CpuUsage;
  memoryUsage: NodeJS.MemoryUsage;
  eventLoopLag: number;
  activeHandles: number;
  activeRequests: number;
}

interface HealthStatus {
  healthy: boolean;
  warnings: string[];
  metrics: HealthMetrics;
}

// Thresholds
const CPU_THRESHOLD_PERCENT = 80; // Warn if CPU > 80%
const MEMORY_THRESHOLD_MB = 500; // Warn if RSS > 500MB
const EVENT_LOOP_LAG_MS = 100; // Warn if event loop lag > 100ms
const CHECK_INTERVAL_MS = 5000; // Check every 5 seconds

export class HealthMonitor {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastCpuUsage: NodeJS.CpuUsage | null = null;
  private lastCheck: number = Date.now();
  private consecutiveHighCpu = 0;
  private enabled = false;

  // Event loop lag measurement
  private lagCheckStart = 0;
  private lastEventLoopLag = 0;

  /**
   * Start monitoring
   */
  start(): void {
    if (this.enabled) return;
    this.enabled = true;

    console.error("[HealthMonitor] Starting health monitoring...");
    this.lastCpuUsage = process.cpuUsage();
    this.lastCheck = Date.now();

    // Start periodic checks
    this.intervalId = setInterval(() => {
      this.checkHealth();
    }, CHECK_INTERVAL_MS);

    // Start event loop lag monitoring
    this.scheduleEventLoopCheck();
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (!this.enabled) return;
    this.enabled = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.error("[HealthMonitor] Stopped health monitoring");
  }

  /**
   * Schedule event loop lag check using setImmediate
   */
  private scheduleEventLoopCheck(): void {
    if (!this.enabled) return;

    this.lagCheckStart = performance.now();
    setImmediate(() => {
      const lag = performance.now() - this.lagCheckStart;
      this.lastEventLoopLag = lag;

      // Reschedule
      setTimeout(() => this.scheduleEventLoopCheck(), 1000);
    });
  }

  /**
   * Check health and log warnings
   */
  private checkHealth(): void {
    const status = this.getStatus();

    if (!status.healthy) {
      console.error(`[HealthMonitor] ⚠️  Health warnings detected:`);
      for (const warning of status.warnings) {
        console.error(`[HealthMonitor]   - ${warning}`);
      }

      // Log metrics for debugging
      const mem = status.metrics.memoryUsage;
      console.error(`[HealthMonitor] Metrics:`, {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
        eventLoopLagMs: Math.round(status.metrics.eventLoopLag),
        activeHandles: status.metrics.activeHandles,
        activeRequests: status.metrics.activeRequests,
      });
    }

    // Track consecutive high CPU
    const cpuPercent = this.calculateCpuPercent(status.metrics.cpuUsage);
    if (cpuPercent > CPU_THRESHOLD_PERCENT) {
      this.consecutiveHighCpu++;
      if (this.consecutiveHighCpu >= 3) {
        console.error(
          `[HealthMonitor] 🔥 CPU has been high (>${CPU_THRESHOLD_PERCENT}%) for ${this.consecutiveHighCpu * CHECK_INTERVAL_MS / 1000}s - possible runaway process!`
        );
        this.logStackTrace();
      }
    } else {
      this.consecutiveHighCpu = 0;
    }
  }

  /**
   * Calculate CPU percentage from usage
   */
  private calculateCpuPercent(cpuUsage: NodeJS.CpuUsage): number {
    if (!this.lastCpuUsage) {
      this.lastCpuUsage = cpuUsage;
      return 0;
    }

    const now = Date.now();
    const elapsed = now - this.lastCheck;

    // Calculate CPU time delta (user + system) in microseconds
    const userDelta = cpuUsage.user - this.lastCpuUsage.user;
    const systemDelta = cpuUsage.system - this.lastCpuUsage.system;
    const totalCpuTime = userDelta + systemDelta;

    // Convert elapsed to microseconds and calculate percentage
    const elapsedMicro = elapsed * 1000;
    const cpuPercent = (totalCpuTime / elapsedMicro) * 100;

    // Update for next check
    this.lastCpuUsage = cpuUsage;
    this.lastCheck = now;

    return cpuPercent;
  }

  /**
   * Log current stack traces for debugging
   */
  private logStackTrace(): void {
    console.error("[HealthMonitor] Current stack trace:");
    console.error(new Error("Stack trace").stack);

    // Log active handles info if available
    if (typeof (process as any)._getActiveHandles === "function") {
      const handles = (process as any)._getActiveHandles();
      console.error(`[HealthMonitor] Active handles (${handles.length}):`);
      const handleTypes = new Map<string, number>();
      for (const h of handles) {
        const type = h.constructor?.name || "Unknown";
        handleTypes.set(type, (handleTypes.get(type) || 0) + 1);
      }
      for (const [type, count] of handleTypes) {
        console.error(`[HealthMonitor]   ${type}: ${count}`);
      }
    }
  }

  /**
   * Get current health status
   */
  getStatus(): HealthStatus {
    const cpuUsage = process.cpuUsage();
    const memoryUsage = process.memoryUsage();
    const warnings: string[] = [];

    // Calculate CPU percentage
    const cpuPercent = this.calculateCpuPercent(cpuUsage);
    if (cpuPercent > CPU_THRESHOLD_PERCENT) {
      warnings.push(`High CPU usage: ${cpuPercent.toFixed(1)}%`);
    }

    // Check memory
    const rssMB = memoryUsage.rss / 1024 / 1024;
    if (rssMB > MEMORY_THRESHOLD_MB) {
      warnings.push(`High memory usage: ${rssMB.toFixed(1)}MB RSS`);
    }

    // Check event loop lag
    if (this.lastEventLoopLag > EVENT_LOOP_LAG_MS) {
      warnings.push(`Event loop lag: ${this.lastEventLoopLag.toFixed(1)}ms`);
    }

    // Get active handles/requests (Bun compatibility)
    let activeHandles = 0;
    let activeRequests = 0;
    if (typeof (process as any)._getActiveHandles === "function") {
      activeHandles = (process as any)._getActiveHandles().length;
    }
    if (typeof (process as any)._getActiveRequests === "function") {
      activeRequests = (process as any)._getActiveRequests().length;
    }

    return {
      healthy: warnings.length === 0,
      warnings,
      metrics: {
        timestamp: Date.now(),
        cpuUsage,
        memoryUsage,
        eventLoopLag: this.lastEventLoopLag,
        activeHandles,
        activeRequests,
      },
    };
  }

  /**
   * Get metrics for external use
   */
  getMetrics(): HealthMetrics {
    return this.getStatus().metrics;
  }
}

// Singleton instance
let healthMonitor: HealthMonitor | null = null;

export function getHealthMonitor(): HealthMonitor {
  if (!healthMonitor) {
    healthMonitor = new HealthMonitor();
  }
  return healthMonitor;
}
