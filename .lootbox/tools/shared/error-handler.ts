/**
 * Enhanced Error Handling for Lootbox Tools
 *
 * Provides graceful error handling, user-friendly messages, and actionable guidance
 * for common failure scenarios in repo_prompt and deep_research tools.
 */

import { createLogger } from "./logging.ts";
import { existsSync } from "node:fs";
import { $ } from "bun";

const log = createLogger("error-handler");

// ============================================================================
// ERROR TYPES & CATEGORIES
// ============================================================================

export enum ErrorCategory {
  NETWORK = "network",
  TIMEOUT = "timeout",
  PERMISSION = "permission",
  RESOURCE = "resource",
  CONFIGURATION = "configuration",
  DEPENDENCY = "dependency",
  UNKNOWN = "unknown"
}

export interface EnhancedError {
  category: ErrorCategory;
  message: string;
  userMessage: string;
  actionableSteps: string[];
  canRetry: boolean;
  retryDelay?: number;
  metadata?: Record<string, any>;
}

// ============================================================================
// ERROR CLASSIFICATION
// ============================================================================

export function classifyError(error: any): ErrorCategory {
  const errorStr = error?.toString?.() || "";
  const message = error?.message || errorStr;

  // Timeout errors
  if (message.includes("timeout") || message.includes("timed out")) {
    return ErrorCategory.TIMEOUT;
  }

  // Network errors
  if (
    message.includes("ECONNREFUSED") ||
    message.includes("ENOTFOUND") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("socket hang up")
  ) {
    return ErrorCategory.NETWORK;
  }

  // Permission errors
  if (
    message.includes("EACCES") ||
    message.includes("EPERM") ||
    message.includes("permission denied") ||
    message.includes("access denied")
  ) {
    return ErrorCategory.PERMISSION;
  }

  // Resource errors
  if (
    message.includes("ENOMEM") ||
    message.includes("ENOSPC") ||
    message.includes("out of memory") ||
    message.includes("no space left")
  ) {
    return ErrorCategory.RESOURCE;
  }

  // Configuration errors
  if (
    message.includes("ENOENT") ||
    message.includes("not found") ||
    message.includes("missing") ||
    message.includes("invalid configuration")
  ) {
    return ErrorCategory.CONFIGURATION;
  }

  // Dependency errors
  if (
    message.includes("command not found") ||
    message.includes("No such file or directory") ||
    message.includes("spawn") ||
    message.includes("ENOENT")
  ) {
    return ErrorCategory.DEPENDENCY;
  }

  return ErrorCategory.UNKNOWN;
}

// ============================================================================
// ERROR ENHANCEMENT
// ============================================================================

export function enhanceError(
  error: any,
  context: {
    tool: string;
    operation?: string;
    input?: any;
  }
): EnhancedError {
  const category = classifyError(error);
  const originalMessage = error?.message || error?.toString?.() || "Unknown error";

  let enhanced: EnhancedError = {
    category,
    message: originalMessage,
    userMessage: "",
    actionableSteps: [],
    canRetry: false,
    metadata: {
      tool: context.tool,
      operation: context.operation,
      timestamp: new Date().toISOString()
    }
  };

  switch (category) {
    case ErrorCategory.TIMEOUT:
      enhanced.userMessage = `The ${context.tool} operation timed out. This usually happens when processing large amounts of data or when external services are slow.`;
      enhanced.actionableSteps = [
        "Try again with a smaller dataset or more specific query",
        "Check if the lootbox server is responsive: curl http://localhost:3456/health",
        "Restart the lootbox server if needed: pkill -9 -f lootbox && cd ~/dev/lootbox-bun && bun run src/lootbox-cli.ts server --port 3456 &",
        "For deep_research, try 'quick' depth instead of 'thorough'",
        "For repo_prompt, reduce the budget_tokens or use fewer files"
      ];
      enhanced.canRetry = true;
      enhanced.retryDelay = 5000;
      break;

    case ErrorCategory.NETWORK:
      enhanced.userMessage = `Network connectivity issue detected. The tool couldn't connect to required services.`;
      enhanced.actionableSteps = [
        "Check your internet connection",
        "Verify the lootbox server is running: ps aux | grep lootbox",
        "Check if port 3456 is available: lsof -i :3456",
        "Restart the lootbox server: pkill -9 -f lootbox && cd ~/dev/lootbox-bun && bun run src/lootbox-cli.ts server --port 3456 &",
        "For API-based operations, check if API keys are configured"
      ];
      enhanced.canRetry = true;
      enhanced.retryDelay = 3000;
      break;

    case ErrorCategory.PERMISSION:
      enhanced.userMessage = `Permission denied. The tool doesn't have access to required resources.`;
      enhanced.actionableSteps = [
        "Check file permissions for the target directory",
        "Ensure you have read access to the repository",
        "For repo_prompt, verify .gitignore patterns aren't blocking access",
        "Try running from a different directory with proper permissions"
      ];
      enhanced.canRetry = false;
      break;

    case ErrorCategory.RESOURCE:
      enhanced.userMessage = `System resources exhausted. The operation requires more memory or disk space.`;
      enhanced.actionableSteps = [
        "Free up disk space or memory",
        "For repo_prompt, use smaller budget_tokens or compress option",
        "For deep_research, use 'quick' depth instead of 'thorough'",
        "Close other applications to free memory",
        "Consider processing in smaller batches"
      ];
      enhanced.canRetry = true;
      enhanced.retryDelay = 10000;
      break;

    case ErrorCategory.CONFIGURATION:
      enhanced.userMessage = `Configuration issue detected. Required files or settings are missing.`;
      enhanced.actionableSteps = [
        "Verify the target path exists and is accessible",
        "Check if required dependencies are installed",
        "For repo_prompt, ensure you're in a valid repository",
        "Review tool configuration in ~/.lootbox/",
        "Reinstall lootbox if configuration is corrupted"
      ];
      enhanced.canRetry = false;
      break;

    case ErrorCategory.DEPENDENCY:
      enhanced.userMessage = `Missing dependency. A required tool or command is not available.`;
      enhanced.actionableSteps = [
        "Check if all required CLI tools are installed (gemini, claude, codex for deep_research)",
        "Verify PATH includes required binaries",
        "Install missing dependencies: bun install",
        "For deep_research, ensure AI CLI tools are configured",
        "Check logs for specific missing commands: tail -50 ~/.lootbox-logs/*.log"
      ];
      enhanced.canRetry = false;
      break;

    default:
      enhanced.userMessage = `An unexpected error occurred in ${context.tool}.`;
      enhanced.actionableSteps = [
        "Check the logs for more details: tail -50 ~/.lootbox-logs/${context.tool}.log",
        "Try restarting the lootbox server",
        "Verify your input parameters are correct",
        "Report the issue with the error message if it persists"
      ];
      enhanced.canRetry = true;
      enhanced.retryDelay = 5000;
  }

  return enhanced;
}

// ============================================================================
// RETRY LOGIC
// ============================================================================

export interface RetryOptions {
  maxAttempts?: number;
  baseDelay?: number;
  maxDelay?: number;
  exponential?: boolean;
  onRetry?: (attempt: number, delay: number, error: any) => void;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelay = 1000,
    maxDelay = 30000,
    exponential = true,
    onRetry
  } = options;

  let lastError: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts) {
        throw error;
      }

      const enhanced = enhanceError(error, { tool: "retry" });

      if (!enhanced.canRetry) {
        throw error;
      }

      const delay = exponential
        ? Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay)
        : enhanced.retryDelay || baseDelay;

      if (onRetry) {
        onRetry(attempt, delay, error);
      }

      log.info(`Retrying after ${delay}ms (attempt ${attempt}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// ============================================================================
// HEALTH CHECKS
// ============================================================================

export interface HealthCheckResult {
  healthy: boolean;
  checks: {
    name: string;
    passed: boolean;
    message?: string;
    duration_ms?: number;
  }[];
  recommendations?: string[];
}

export async function performHealthCheck(tool: string): Promise<HealthCheckResult> {
  const checks: HealthCheckResult["checks"] = [];
  const recommendations: string[] = [];

  // Check lootbox server
  const serverStart = Date.now();
  try {
    const response = await fetch("http://localhost:3456/health");
    const serverHealthy = response.ok;
    checks.push({
      name: "lootbox_server",
      passed: serverHealthy,
      message: serverHealthy ? "Server is responsive" : "Server returned error",
      duration_ms: Date.now() - serverStart
    });

    if (!serverHealthy) {
      recommendations.push("Restart lootbox server: pkill -9 -f lootbox && cd ~/dev/lootbox-bun && bun run src/lootbox-cli.ts server --port 3456 &");
    }
  } catch (error) {
    checks.push({
      name: "lootbox_server",
      passed: false,
      message: "Cannot connect to server",
      duration_ms: Date.now() - serverStart
    });
    recommendations.push("Start lootbox server: cd ~/dev/lootbox-bun && bun run src/lootbox-cli.ts server --port 3456 &");
  }

  // Tool-specific checks
  if (tool === "deep_research") {
    // Check for AI CLI tools
    for (const cmd of ["gemini", "claude", "codex"]) {
      const cmdStart = Date.now();
      try {
        const result = await $`which ${cmd}`.quiet();
        const exists = result.exitCode === 0;
        checks.push({
          name: `cli_${cmd}`,
          passed: exists,
          message: exists ? `${cmd} CLI found` : `${cmd} CLI not found`,
          duration_ms: Date.now() - cmdStart
        });

        if (!exists) {
          recommendations.push(`Install ${cmd} CLI tool for full deep_research functionality`);
        }
      } catch {
        checks.push({
          name: `cli_${cmd}`,
          passed: false,
          message: `${cmd} CLI not found`,
          duration_ms: Date.now() - cmdStart
        });
      }
    }
  }

  if (tool === "repo_prompt") {
    // Check git availability
    const gitStart = Date.now();
    try {
      const result = await $`git --version`.quiet();
      const hasGit = result.exitCode === 0;
      checks.push({
        name: "git",
        passed: hasGit,
        message: hasGit ? "Git is available" : "Git not found",
        duration_ms: Date.now() - gitStart
      });
    } catch {
      checks.push({
        name: "git",
        passed: false,
        message: "Git not found",
        duration_ms: Date.now() - gitStart
      });
    }
  }

  // Check disk space
  const diskStart = Date.now();
  try {
    const result = await $`df -h /tmp | tail -1 | awk '{print $5}' | sed 's/%//'`.quiet();
    const usagePercent = parseInt(result.stdout.trim());
    const hasSpace = usagePercent < 90;
    checks.push({
      name: "disk_space",
      passed: hasSpace,
      message: `Disk usage: ${usagePercent}%`,
      duration_ms: Date.now() - diskStart
    });

    if (!hasSpace) {
      recommendations.push("Free up disk space - less than 10% available");
    }
  } catch {
    checks.push({
      name: "disk_space",
      passed: true,
      message: "Could not check disk space",
      duration_ms: Date.now() - diskStart
    });
  }

  const healthy = checks.every(c => c.passed);

  return {
    healthy,
    checks,
    recommendations: recommendations.length > 0 ? recommendations : undefined
  };
}

// ============================================================================
// USER-FRIENDLY ERROR FORMATTING
// ============================================================================

export function formatErrorForUser(enhanced: EnhancedError): string {
  const sections: string[] = [];

  // Header
  sections.push(`❌ ${enhanced.userMessage}\n`);

  // Category badge
  const categoryEmoji = {
    [ErrorCategory.NETWORK]: "🌐",
    [ErrorCategory.TIMEOUT]: "⏱️",
    [ErrorCategory.PERMISSION]: "🔒",
    [ErrorCategory.RESOURCE]: "💾",
    [ErrorCategory.CONFIGURATION]: "⚙️",
    [ErrorCategory.DEPENDENCY]: "📦",
    [ErrorCategory.UNKNOWN]: "❓"
  };

  sections.push(`${categoryEmoji[enhanced.category]} Error Type: ${enhanced.category.toUpperCase()}\n`);

  // Original error (condensed)
  if (enhanced.message.length > 200) {
    sections.push(`Details: ${enhanced.message.substring(0, 200)}...\n`);
  } else {
    sections.push(`Details: ${enhanced.message}\n`);
  }

  // Actionable steps
  if (enhanced.actionableSteps.length > 0) {
    sections.push("📋 What you can do:");
    enhanced.actionableSteps.forEach((step, i) => {
      sections.push(`   ${i + 1}. ${step}`);
    });
    sections.push("");
  }

  // Retry info
  if (enhanced.canRetry) {
    sections.push(`🔄 This error is retryable. You can try again${enhanced.retryDelay ? ` after ${enhanced.retryDelay / 1000}s` : ""}.`);
  }

  return sections.join("\n");
}