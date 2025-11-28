/**
 * Progress Indicator System for Long-Running Operations
 *
 * Provides visual feedback and prevents timeouts during extended operations
 * like deep_research searches and large repo_prompt packing.
 */

import type { ProgressCallback } from "./types.ts";
import { createLogger } from "./logging.ts";

const log = createLogger("progress");

// ============================================================================
// PROGRESS STATE
// ============================================================================

export interface ProgressState {
  operation: string;
  startTime: number;
  lastUpdate: number;
  steps: ProgressStep[];
  currentStep?: number;
  totalSteps?: number;
  metadata?: Record<string, any>;
}

export interface ProgressStep {
  name: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  startTime?: number;
  endTime?: number;
  message?: string;
  progress?: number; // 0-100
}

// ============================================================================
// PROGRESS MANAGER
// ============================================================================

export class ProgressManager {
  private callback: ProgressCallback | null = null;
  private state: ProgressState | null = null;
  private updateInterval: Timer | null = null;
  private lastProgressMessage: string = "";

  constructor(callback?: ProgressCallback) {
    this.callback = callback || null;
  }

  /**
   * Start tracking a new operation
   */
  startOperation(operation: string, steps?: string[]): void {
    this.state = {
      operation,
      startTime: Date.now(),
      lastUpdate: Date.now(),
      steps: steps ? steps.map(name => ({ name, status: "pending" })) : [],
      currentStep: steps ? 0 : undefined,
      totalSteps: steps?.length
    };

    this.sendUpdate(`Starting ${operation}...`);
    this.startHeartbeat();
  }

  /**
   * Add a step dynamically
   */
  addStep(name: string): void {
    if (!this.state) return;

    this.state.steps.push({ name, status: "pending" });
    this.state.totalSteps = this.state.steps.length;
    this.sendUpdate(`Added step: ${name}`);
  }

  /**
   * Start a specific step
   */
  startStep(nameOrIndex: string | number): void {
    if (!this.state) return;

    const step = this.getStep(nameOrIndex);
    if (!step) return;

    step.status = "running";
    step.startTime = Date.now();

    const stepIndex = this.state.steps.indexOf(step);
    this.state.currentStep = stepIndex;

    const progressInfo = this.state.totalSteps
      ? ` (${stepIndex + 1}/${this.state.totalSteps})`
      : "";

    this.sendUpdate(`${step.name}${progressInfo}...`);
  }

  /**
   * Complete a step
   */
  completeStep(nameOrIndex: string | number, message?: string): void {
    if (!this.state) return;

    const step = this.getStep(nameOrIndex);
    if (!step) return;

    step.status = "completed";
    step.endTime = Date.now();
    step.message = message;
    step.progress = 100;

    const duration = step.startTime ? ((step.endTime - step.startTime) / 1000).toFixed(1) : "?";
    this.sendUpdate(`✓ ${step.name} (${duration}s)`);

    // Auto-start next pending step
    this.autoAdvance();
  }

  /**
   * Fail a step
   */
  failStep(nameOrIndex: string | number, error: string): void {
    if (!this.state) return;

    const step = this.getStep(nameOrIndex);
    if (!step) return;

    step.status = "failed";
    step.endTime = Date.now();
    step.message = error;

    this.sendUpdate(`✗ ${step.name}: ${error}`);
  }

  /**
   * Skip a step
   */
  skipStep(nameOrIndex: string | number, reason?: string): void {
    if (!this.state) return;

    const step = this.getStep(nameOrIndex);
    if (!step) return;

    step.status = "skipped";
    step.message = reason;

    this.sendUpdate(`⊘ ${step.name} (skipped${reason ? `: ${reason}` : ""})`);
    this.autoAdvance();
  }

  /**
   * Update progress for current step (0-100)
   */
  updateProgress(progress: number, message?: string): void {
    if (!this.state || this.state.currentStep === undefined) return;

    const step = this.state.steps[this.state.currentStep];
    if (!step || step.status !== "running") return;

    step.progress = Math.min(100, Math.max(0, progress));

    const progressBar = this.renderProgressBar(step.progress);
    const stepInfo = message || step.name;

    this.sendUpdate(`${stepInfo} ${progressBar} ${step.progress}%`);
  }

  /**
   * Send a custom message
   */
  sendMessage(message: string): void {
    this.sendUpdate(message);
  }

  /**
   * Complete the entire operation
   */
  complete(summary?: string): void {
    if (!this.state) return;

    const duration = ((Date.now() - this.state.startTime) / 1000).toFixed(1);
    const completedSteps = this.state.steps.filter(s => s.status === "completed").length;
    const failedSteps = this.state.steps.filter(s => s.status === "failed").length;

    let message = `✓ ${this.state.operation} completed in ${duration}s`;

    if (this.state.steps.length > 0) {
      message += ` (${completedSteps}/${this.state.steps.length} steps`;
      if (failedSteps > 0) {
        message += `, ${failedSteps} failed`;
      }
      message += ")";
    }

    if (summary) {
      message += `\n${summary}`;
    }

    this.sendUpdate(message);
    this.cleanup();
  }

  /**
   * Fail the entire operation
   */
  fail(error: string): void {
    if (!this.state) return;

    const duration = ((Date.now() - this.state.startTime) / 1000).toFixed(1);
    this.sendUpdate(`✗ ${this.state.operation} failed after ${duration}s: ${error}`);
    this.cleanup();
  }

  /**
   * Set metadata for the operation
   */
  setMetadata(key: string, value: any): void {
    if (!this.state) return;

    if (!this.state.metadata) {
      this.state.metadata = {};
    }

    this.state.metadata[key] = value;
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  private getStep(nameOrIndex: string | number): ProgressStep | undefined {
    if (!this.state) return undefined;

    if (typeof nameOrIndex === "number") {
      return this.state.steps[nameOrIndex];
    }

    return this.state.steps.find(s => s.name === nameOrIndex);
  }

  private autoAdvance(): void {
    if (!this.state) return;

    const nextPending = this.state.steps.findIndex(s => s.status === "pending");
    if (nextPending !== -1) {
      this.startStep(nextPending);
    }
  }

  private renderProgressBar(progress: number, width: number = 20): string {
    const filled = Math.floor((progress / 100) * width);
    const empty = width - filled;
    return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
  }

  private sendUpdate(message: string): void {
    // Avoid sending duplicate messages
    if (message === this.lastProgressMessage) return;

    this.lastProgressMessage = message;
    this.state!.lastUpdate = Date.now();

    // Format message with timestamp
    const elapsed = this.state ? ((Date.now() - this.state.startTime) / 1000).toFixed(1) : "0";
    const formattedMessage = `[${elapsed}s] ${message}`;

    // Send via callback
    if (this.callback) {
      this.callback(formattedMessage);
    }

    // Also log it
    log.info(formattedMessage);
  }

  private startHeartbeat(): void {
    // Send periodic updates to prevent timeout
    this.updateInterval = setInterval(() => {
      if (!this.state) return;

      const elapsed = (Date.now() - this.state.lastUpdate) / 1000;

      // Only send heartbeat if no update in last 10 seconds
      if (elapsed > 10) {
        const totalElapsed = ((Date.now() - this.state.startTime) / 1000).toFixed(0);
        const currentStepName = this.state.currentStep !== undefined
          ? this.state.steps[this.state.currentStep]?.name
          : this.state.operation;

        this.sendUpdate(`Still working on ${currentStepName}... (${totalElapsed}s elapsed)`);
      }
    }, 5000); // Check every 5 seconds
  }

  private cleanup(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    this.state = null;
    this.lastProgressMessage = "";
  }
}

// ============================================================================
// OPERATION TEMPLATES
// ============================================================================

/**
 * Pre-defined progress templates for common operations
 */
export const ProgressTemplates = {
  deepResearch: {
    quick: [
      "Expanding search queries",
      "Running parallel searches",
      "Synthesizing findings"
    ],
    standard: [
      "Expanding search queries",
      "Running parallel searches",
      "Initial synthesis",
      "Identifying knowledge gaps",
      "Gap follow-up research",
      "Final synthesis"
    ],
    thorough: [
      "Expanding search queries",
      "Running primary searches",
      "Initial synthesis",
      "Identifying knowledge gaps",
      "Deep-dive research",
      "Multi-agent analysis",
      "Cross-validation",
      "Final report generation"
    ]
  },

  repoPrompt: {
    analyze: [
      "Scanning repository",
      "Counting files",
      "Estimating tokens",
      "Generating statistics"
    ],
    pack: [
      "Loading repository",
      "Filtering files",
      "Reading content",
      "Formatting output",
      "Calculating token usage"
    ],
    smartPack: [
      "Analyzing repository",
      "Scoring file relevance",
      "Expanding dependencies",
      "Allocating token budget",
      "Packing content",
      "Generating codemaps",
      "Finalizing output"
    ]
  }
};

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Create a progress-tracked wrapper for async operations
 */
export function withProgress<T>(
  operation: string,
  steps: string[],
  callback: ProgressCallback,
  fn: (progress: ProgressManager) => Promise<T>
): Promise<T> {
  const progress = new ProgressManager(callback);
  progress.startOperation(operation, steps);

  return fn(progress)
    .then((result) => {
      progress.complete();
      return result;
    })
    .catch((error) => {
      progress.fail(error.message || "Unknown error");
      throw error;
    });
}

/**
 * Simple progress reporter for quick operations
 */
export class SimpleProgressReporter {
  private callback: ProgressCallback | null;
  private lastUpdate: number = 0;
  private minInterval: number = 1000; // Minimum time between updates

  constructor(callback?: ProgressCallback, minInterval?: number) {
    this.callback = callback || null;
    this.minInterval = minInterval || 1000;
  }

  report(message: string, force: boolean = false): void {
    const now = Date.now();

    if (!force && (now - this.lastUpdate) < this.minInterval) {
      return;
    }

    this.lastUpdate = now;

    if (this.callback) {
      this.callback(message);
    }

    log.info(message);
  }
}