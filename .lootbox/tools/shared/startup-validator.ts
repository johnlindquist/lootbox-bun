/**
 * Startup Validation for Lootbox Tools
 *
 * Ensures tools have everything they need before attempting operations,
 * providing clear diagnostics when prerequisites are missing.
 */

import { existsSync, statSync } from "node:fs";
import { $ } from "bun";
import { createLogger } from "./logging.ts";
import { performHealthCheck, type HealthCheckResult } from "./error-handler.ts";

const log = createLogger("startup-validator");

// ============================================================================
// VALIDATION TYPES
// ============================================================================

export interface ValidationRule {
  name: string;
  description: string;
  check: () => Promise<ValidationResult>;
  required: boolean;
  autoFix?: () => Promise<boolean>;
}

export interface ValidationResult {
  passed: boolean;
  message: string;
  details?: string;
  fixCommand?: string;
}

export interface StartupValidation {
  tool: string;
  timestamp: number;
  valid: boolean;
  rules: {
    rule: string;
    result: ValidationResult;
    required: boolean;
  }[];
  autoFixAttempted: boolean;
  recommendations: string[];
}

// ============================================================================
// COMMON VALIDATORS
// ============================================================================

/**
 * Check if lootbox server is running
 */
export async function validateLootboxServer(): Promise<ValidationResult> {
  try {
    const response = await fetch("http://localhost:3456/health", {
      signal: AbortSignal.timeout(5000)
    });

    if (response.ok) {
      const data = await response.json();
      return {
        passed: true,
        message: "Lootbox server is running",
        details: `Version: ${data.version || "unknown"}`
      };
    }

    return {
      passed: false,
      message: "Lootbox server returned error",
      details: `Status: ${response.status}`,
      fixCommand: "cd ~/dev/lootbox-bun && bun run src/lootbox-cli.ts server --port 3456 &"
    };
  } catch (error: any) {
    return {
      passed: false,
      message: "Cannot connect to lootbox server",
      details: error.message,
      fixCommand: "cd ~/dev/lootbox-bun && bun run src/lootbox-cli.ts server --port 3456 &"
    };
  }
}

/**
 * Check if a CLI command exists
 */
export async function validateCommand(command: string): Promise<ValidationResult> {
  try {
    const result = await $`which ${command}`.quiet();

    if (result.exitCode === 0) {
      const path = result.stdout.trim();
      return {
        passed: true,
        message: `${command} found`,
        details: `Path: ${path}`
      };
    }

    return {
      passed: false,
      message: `${command} not found in PATH`,
      fixCommand: `Install ${command} or add it to your PATH`
    };
  } catch {
    return {
      passed: false,
      message: `${command} not found`,
      fixCommand: `Install ${command} or add it to your PATH`
    };
  }
}

/**
 * Check if a directory exists and is accessible
 */
export async function validateDirectory(path: string): Promise<ValidationResult> {
  try {
    if (!existsSync(path)) {
      return {
        passed: false,
        message: `Directory does not exist: ${path}`,
        fixCommand: `mkdir -p ${path}`
      };
    }

    const stats = statSync(path);
    if (!stats.isDirectory()) {
      return {
        passed: false,
        message: `Path is not a directory: ${path}`
      };
    }

    // Check if we can list contents (read permission)
    await $`ls ${path}`.quiet();

    return {
      passed: true,
      message: `Directory is accessible: ${path}`
    };
  } catch (error: any) {
    return {
      passed: false,
      message: `Cannot access directory: ${path}`,
      details: error.message
    };
  }
}

/**
 * Check available disk space
 */
export async function validateDiskSpace(minGb: number = 1): Promise<ValidationResult> {
  try {
    const result = await $`df -BG / | tail -1 | awk '{print $4}' | sed 's/G//'`.quiet();
    const availableGb = parseInt(result.stdout.trim());

    if (availableGb >= minGb) {
      return {
        passed: true,
        message: `Sufficient disk space available`,
        details: `${availableGb}GB free`
      };
    }

    return {
      passed: false,
      message: `Insufficient disk space`,
      details: `Only ${availableGb}GB free, need at least ${minGb}GB`,
      fixCommand: "Free up disk space by removing unnecessary files"
    };
  } catch {
    return {
      passed: true, // Don't fail on check error
      message: "Could not verify disk space"
    };
  }
}

/**
 * Check available memory
 */
export async function validateMemory(minGb: number = 2): Promise<ValidationResult> {
  try {
    // macOS specific
    const result = await $`vm_stat | grep "Pages free" | awk '{print $3}' | sed 's/\\.//'`.quiet();
    const freePages = parseInt(result.stdout.trim());
    const pageSize = 4096; // 4KB pages on macOS
    const freeGb = (freePages * pageSize) / (1024 * 1024 * 1024);

    if (freeGb >= minGb) {
      return {
        passed: true,
        message: `Sufficient memory available`,
        details: `${freeGb.toFixed(1)}GB free`
      };
    }

    return {
      passed: false,
      message: `Insufficient memory`,
      details: `Only ${freeGb.toFixed(1)}GB free, need at least ${minGb}GB`,
      fixCommand: "Close other applications to free memory"
    };
  } catch {
    // Try Linux approach
    try {
      const result = await $`free -g | grep Mem | awk '{print $7}'`.quiet();
      const availableGb = parseInt(result.stdout.trim());

      if (availableGb >= minGb) {
        return {
          passed: true,
          message: `Sufficient memory available`,
          details: `${availableGb}GB free`
        };
      }

      return {
        passed: false,
        message: `Insufficient memory`,
        details: `Only ${availableGb}GB free, need at least ${minGb}GB`,
        fixCommand: "Close other applications to free memory"
      };
    } catch {
      return {
        passed: true, // Don't fail on check error
        message: "Could not verify memory"
      };
    }
  }
}

/**
 * Check if running in a git repository
 */
export async function validateGitRepo(path: string = "."): Promise<ValidationResult> {
  try {
    const result = await $`cd ${path} && git rev-parse --is-inside-work-tree`.quiet();

    if (result.exitCode === 0) {
      const rootResult = await $`cd ${path} && git rev-parse --show-toplevel`.quiet();
      const root = rootResult.stdout.trim();

      return {
        passed: true,
        message: "Inside a git repository",
        details: `Root: ${root}`
      };
    }

    return {
      passed: false,
      message: "Not in a git repository",
      fixCommand: "Navigate to a git repository or run 'git init'"
    };
  } catch {
    return {
      passed: false,
      message: "Git not available or not in a repository",
      fixCommand: "Install git and/or navigate to a git repository"
    };
  }
}

// ============================================================================
// TOOL-SPECIFIC VALIDATORS
// ============================================================================

/**
 * Get validation rules for repo_prompt tool
 */
export function getRepoPromptValidationRules(): ValidationRule[] {
  return [
    {
      name: "lootbox_server",
      description: "Lootbox server must be running",
      check: validateLootboxServer,
      required: true,
      autoFix: async () => {
        try {
          await $`pkill -9 -f lootbox`.quiet();
          await new Promise(resolve => setTimeout(resolve, 1000));
          await $`cd ~/dev/lootbox-bun && bun run src/lootbox-cli.ts server --port 3456 &`.quiet();
          await new Promise(resolve => setTimeout(resolve, 3000));
          return true;
        } catch {
          return false;
        }
      }
    },
    {
      name: "git_command",
      description: "Git command should be available",
      check: () => validateCommand("git"),
      required: false
    },
    {
      name: "disk_space",
      description: "At least 1GB free disk space",
      check: () => validateDiskSpace(1),
      required: false
    },
    {
      name: "logs_directory",
      description: "Logs directory exists",
      check: () => validateDirectory(process.env.HOME + "/.lootbox-logs"),
      required: false,
      autoFix: async () => {
        try {
          await $`mkdir -p ~/.lootbox-logs`.quiet();
          return true;
        } catch {
          return false;
        }
      }
    }
  ];
}

/**
 * Get validation rules for deep_research tool
 */
export function getDeepResearchValidationRules(): ValidationRule[] {
  return [
    {
      name: "lootbox_server",
      description: "Lootbox server must be running",
      check: validateLootboxServer,
      required: true,
      autoFix: async () => {
        try {
          await $`pkill -9 -f lootbox`.quiet();
          await new Promise(resolve => setTimeout(resolve, 1000));
          await $`cd ~/dev/lootbox-bun && bun run src/lootbox-cli.ts server --port 3456 &`.quiet();
          await new Promise(resolve => setTimeout(resolve, 3000));
          return true;
        } catch {
          return false;
        }
      }
    },
    {
      name: "gemini_cli",
      description: "Gemini CLI for web searches",
      check: () => validateCommand("gemini"),
      required: true
    },
    {
      name: "claude_cli",
      description: "Claude CLI for analysis",
      check: () => validateCommand("claude"),
      required: false
    },
    {
      name: "codex_cli",
      description: "Codex CLI for analysis",
      check: () => validateCommand("codex"),
      required: false
    },
    {
      name: "memory_available",
      description: "At least 2GB free memory",
      check: () => validateMemory(2),
      required: false
    },
    {
      name: "logs_directory",
      description: "Logs directory exists",
      check: () => validateDirectory(process.env.HOME + "/.lootbox-logs"),
      required: false,
      autoFix: async () => {
        try {
          await $`mkdir -p ~/.lootbox-logs`.quiet();
          return true;
        } catch {
          return false;
        }
      }
    }
  ];
}

// ============================================================================
// VALIDATION RUNNER
// ============================================================================

/**
 * Run startup validation for a tool
 */
export async function validateStartup(
  tool: string,
  autoFix: boolean = true
): Promise<StartupValidation> {
  log.info(`Running startup validation for ${tool}`);

  let rules: ValidationRule[];

  switch (tool) {
    case "repo_prompt":
      rules = getRepoPromptValidationRules();
      break;
    case "deep_research":
      rules = getDeepResearchValidationRules();
      break;
    default:
      rules = [
        {
          name: "lootbox_server",
          description: "Lootbox server must be running",
          check: validateLootboxServer,
          required: true
        }
      ];
  }

  const validation: StartupValidation = {
    tool,
    timestamp: Date.now(),
    valid: true,
    rules: [],
    autoFixAttempted: false,
    recommendations: []
  };

  // Run all checks
  for (const rule of rules) {
    log.info(`Checking: ${rule.name}`);

    let result = await rule.check();

    // Try auto-fix if failed and available
    if (!result.passed && rule.autoFix && autoFix) {
      log.info(`Attempting auto-fix for ${rule.name}`);
      validation.autoFixAttempted = true;

      const fixed = await rule.autoFix();
      if (fixed) {
        // Re-run check
        result = await rule.check();
        if (result.passed) {
          log.info(`Auto-fix successful for ${rule.name}`);
        }
      }
    }

    validation.rules.push({
      rule: rule.name,
      result,
      required: rule.required
    });

    // Track overall validity
    if (rule.required && !result.passed) {
      validation.valid = false;
    }

    // Add fix commands to recommendations
    if (!result.passed && result.fixCommand) {
      validation.recommendations.push(result.fixCommand);
    }
  }

  // Add general recommendations
  if (!validation.valid) {
    validation.recommendations.unshift(
      "Some required checks failed. Please address these issues before proceeding."
    );

    // Run health check for additional diagnostics
    const health = await performHealthCheck(tool);
    if (health.recommendations) {
      validation.recommendations.push(...health.recommendations);
    }
  }

  log.info(`Validation complete: ${validation.valid ? "PASSED" : "FAILED"}`);
  return validation;
}

// ============================================================================
// VALIDATION FORMATTER
// ============================================================================

/**
 * Format validation results for user display
 */
export function formatValidationResults(validation: StartupValidation): string {
  const lines: string[] = [];

  // Header
  const statusEmoji = validation.valid ? "✅" : "❌";
  lines.push(`${statusEmoji} Startup Validation for ${validation.tool}`);
  lines.push("");

  // Results table
  lines.push("Checks:");
  for (const { rule, result, required } of validation.rules) {
    const status = result.passed ? "✓" : "✗";
    const reqTag = required ? "[REQUIRED]" : "[optional]";
    lines.push(`  ${status} ${rule} ${reqTag}`);

    if (result.details) {
      lines.push(`    ${result.details}`);
    }

    if (!result.passed && result.message) {
      lines.push(`    ⚠️  ${result.message}`);
    }
  }

  // Auto-fix note
  if (validation.autoFixAttempted) {
    lines.push("");
    lines.push("ℹ️  Auto-fix was attempted for some issues");
  }

  // Recommendations
  if (validation.recommendations.length > 0) {
    lines.push("");
    lines.push("📋 Recommended Actions:");
    validation.recommendations.forEach((rec, i) => {
      lines.push(`  ${i + 1}. ${rec}`);
    });
  }

  // Summary
  lines.push("");
  if (validation.valid) {
    lines.push("✅ All required checks passed. Tool is ready to use!");
  } else {
    lines.push("❌ Some required checks failed. Please fix the issues above.");
  }

  return lines.join("\n");
}