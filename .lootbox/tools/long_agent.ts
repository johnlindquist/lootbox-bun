/**
 * Long-Running Agent Tools
 *
 * Tools to support long-running AI coding agents that work across multiple
 * context windows. Based on Anthropic's research on autonomous coding agents.
 *
 * Key concepts:
 * - Feature list: JSON file tracking all features with pass/fail status
 * - Progress file: Markdown log of what agents have done
 * - Init script: Shell script to set up development environment
 * - Incremental progress: Work on ONE feature at a time
 * - Clean handoffs: Leave environment ready for next agent
 *
 * @see https://www.anthropic.com/engineering/building-long-running-agents
 */

import { $ } from "bun";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createLogger, extractErrorMessage, getCodeMapContext } from "./shared/index.ts";

const log = createLogger("long_agent");

// Default filenames
const PROGRESS_FILE = "claude-progress.txt";
const FEATURES_FILE = "feature_list.json";
const INIT_SCRIPT = "init.sh";

// Feature interface matching the article's JSON structure
interface Feature {
  id: string;
  category: "functional" | "ui" | "performance" | "security" | "accessibility";
  description: string;
  steps: string[];
  passes: boolean;
  priority?: number;
}

interface FeatureList {
  project: string;
  description: string;
  features: Feature[];
  metadata?: {
    created: string;
    lastUpdated: string;
    totalFeatures: number;
    passingFeatures: number;
  };
}

/**
 * Initialize a project for long-running agent work
 *
 * Creates the scaffolding needed for agents to work across context windows:
 * - feature_list.json with expanded features
 * - claude-progress.txt for progress tracking
 * - init.sh for environment setup
 * - Initial git commit
 *
 * @param args.project_path - Path to the project directory
 * @param args.project_name - Name of the project
 * @param args.description - Brief description of what to build
 * @param args.features - Initial list of high-level features to expand
 * @param args.init_commands - Commands for init.sh (e.g., "npm run dev")
 */
export async function init_project(args: {
  project_path: string;
  project_name: string;
  description: string;
  features?: string[];
  init_commands?: string[];
}): Promise<{
  success: boolean;
  files_created?: string[];
  error?: string;
}> {
  log.call("init_project", args);

  const { project_path, project_name, description, features = [], init_commands = [] } = args;

  try {
    // Ensure directory exists
    if (!existsSync(project_path)) {
      mkdirSync(project_path, { recursive: true });
    }

    const filesCreated: string[] = [];

    // Create feature list
    const featureListPath = join(project_path, FEATURES_FILE);
    const featureList: FeatureList = {
      project: project_name,
      description,
      features: features.map((f, i) => ({
        id: `feature-${i + 1}`,
        category: "functional" as const,
        description: f,
        steps: ["Implement the feature", "Test the feature", "Verify end-to-end functionality"],
        passes: false,
        priority: i + 1,
      })),
      metadata: {
        created: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        totalFeatures: features.length,
        passingFeatures: 0,
      },
    };
    writeFileSync(featureListPath, JSON.stringify(featureList, null, 2));
    filesCreated.push(FEATURES_FILE);

    // Create progress file
    const progressPath = join(project_path, PROGRESS_FILE);
    const progressContent = `# ${project_name} - Agent Progress Log

## Project Description
${description}

## Progress Log

### Session 1 - ${new Date().toISOString().split("T")[0]}
- Project initialized for long-running agent work
- Created feature list with ${features.length} features
- Created init.sh script

---
## Guidelines for Agents

1. Read this file and git log at the start of each session
2. Work on ONE feature at a time
3. Test features end-to-end before marking as complete
4. Commit progress with descriptive messages
5. Update this file at the end of each session
6. Leave the codebase in a clean, working state

`;
    writeFileSync(progressPath, progressContent);
    filesCreated.push(PROGRESS_FILE);

    // Create init script
    const initPath = join(project_path, INIT_SCRIPT);
    const initContent = `#!/bin/bash
# ${project_name} - Initialization Script
# Run this at the start of each agent session

set -e

echo "🚀 Initializing ${project_name}..."

# Install dependencies if needed
if [ -f "package.json" ] && [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

${init_commands.map((cmd) => `# Run: ${cmd}\n${cmd}`).join("\n\n")}

echo "✅ Environment ready!"
`;
    writeFileSync(initPath, initContent);
    await $`chmod +x ${initPath}`.quiet();
    filesCreated.push(INIT_SCRIPT);

    // Initialize git if not already
    const gitDir = join(project_path, ".git");
    if (!existsSync(gitDir)) {
      await $`cd ${project_path} && git init`.quiet();
      filesCreated.push(".git");
    }

    // Create initial commit
    await $`cd ${project_path} && git add ${FEATURES_FILE} ${PROGRESS_FILE} ${INIT_SCRIPT}`.quiet();
    await $`cd ${project_path} && git commit -m "Initialize project for long-running agent work" --allow-empty`.quiet();

    log.success("init_project", { filesCreated });
    return { success: true, files_created: filesCreated };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("init_project", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Get bearings at the start of a new session
 *
 * Returns all the context an agent needs to understand current state:
 * - Current working directory
 * - Recent git commits
 * - Progress file contents
 * - Feature list summary
 * - Codebase structure (code map)
 *
 * @param args.project_path - Path to the project directory
 * @param args.include_codemap - Include codebase structure context (default: true)
 */
export async function get_bearings(args: {
  project_path: string;
  /** Include codebase structure context (default: true) */
  include_codemap?: boolean;
}): Promise<{
  success: boolean;
  bearings?: {
    cwd: string;
    git_log: string;
    progress: string;
    feature_summary: {
      total: number;
      passing: number;
      failing: number;
      next_feature?: Feature;
    };
    /** Codebase structure map showing files, exports, and signatures */
    codemap?: string;
  };
  error?: string;
}> {
  log.call("get_bearings", args);

  const { project_path, include_codemap = true } = args;

  try {
    // Get current directory
    const cwd = project_path;

    // Get git log
    let gitLog = "No git history";
    try {
      const result = await $`cd ${project_path} && git log --oneline -20`.quiet();
      gitLog = result.text();
    } catch {
      // Git not initialized or no commits
    }

    // Read progress file
    const progressPath = join(project_path, PROGRESS_FILE);
    let progress = "No progress file found";
    if (existsSync(progressPath)) {
      progress = readFileSync(progressPath, "utf-8");
    }

    // Read and summarize features
    const featuresPath = join(project_path, FEATURES_FILE);
    let featureSummary = {
      total: 0,
      passing: 0,
      failing: 0,
      next_feature: undefined as Feature | undefined,
    };

    if (existsSync(featuresPath)) {
      const featureList: FeatureList = JSON.parse(readFileSync(featuresPath, "utf-8"));
      const passing = featureList.features.filter((f) => f.passes).length;
      const failing = featureList.features.filter((f) => !f.passes);

      featureSummary = {
        total: featureList.features.length,
        passing,
        failing: failing.length,
        next_feature: failing.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))[0],
      };
    }

    // Get codebase structure map
    let codemap: string | undefined;
    if (include_codemap) {
      const codeMapContext = await getCodeMapContext(project_path);
      if (codeMapContext) {
        codemap = codeMapContext;
        log.info(`Loaded code map context (${codeMapContext.length} chars)`);
      } else {
        log.info("No code map available (not a git repo or generation failed)");
      }
    }

    const bearings = {
      cwd,
      git_log: gitLog,
      progress,
      feature_summary: featureSummary,
      codemap,
    };

    log.success("get_bearings", { total: featureSummary.total, passing: featureSummary.passing, hasCodemap: !!codemap });
    return { success: true, bearings };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("get_bearings", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Read the progress file
 *
 * @param args.project_path - Path to the project directory
 */
export async function read_progress(args: {
  project_path: string;
}): Promise<{
  success: boolean;
  content?: string;
  error?: string;
}> {
  log.call("read_progress", args);

  const { project_path } = args;
  const progressPath = join(project_path, PROGRESS_FILE);

  try {
    if (!existsSync(progressPath)) {
      return { success: false, error: `Progress file not found: ${progressPath}` };
    }

    const content = readFileSync(progressPath, "utf-8");
    log.success("read_progress", content.substring(0, 200));
    return { success: true, content };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("read_progress", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Update the progress file with session work
 *
 * @param args.project_path - Path to the project directory
 * @param args.session_number - Current session number
 * @param args.work_done - List of accomplishments this session
 * @param args.issues - Any issues or blockers encountered
 * @param args.next_steps - Suggested next steps for the next session
 */
export async function update_progress(args: {
  project_path: string;
  session_number: number;
  work_done: string[];
  issues?: string[];
  next_steps?: string[];
}): Promise<{
  success: boolean;
  error?: string;
}> {
  log.call("update_progress", args);

  const { project_path, session_number, work_done, issues = [], next_steps = [] } = args;
  const progressPath = join(project_path, PROGRESS_FILE);

  try {
    if (!existsSync(progressPath)) {
      return { success: false, error: `Progress file not found: ${progressPath}` };
    }

    let content = readFileSync(progressPath, "utf-8");

    const sessionEntry = `
### Session ${session_number} - ${new Date().toISOString().split("T")[0]}

**Work Completed:**
${work_done.map((w) => `- ${w}`).join("\n")}

${issues.length > 0 ? `**Issues Encountered:**\n${issues.map((i) => `- ${i}`).join("\n")}\n` : ""}
${next_steps.length > 0 ? `**Suggested Next Steps:**\n${next_steps.map((n) => `- ${n}`).join("\n")}\n` : ""}
---
`;

    // Insert after the Progress Log header
    const insertPoint = content.indexOf("## Progress Log\n");
    if (insertPoint !== -1) {
      const afterHeader = insertPoint + "## Progress Log\n".length;
      content = content.slice(0, afterHeader) + sessionEntry + content.slice(afterHeader);
    } else {
      content += sessionEntry;
    }

    writeFileSync(progressPath, content);
    log.success("update_progress", { session_number });
    return { success: true };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("update_progress", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Get the feature list
 *
 * @param args.project_path - Path to the project directory
 * @param args.filter - Optional filter: "all", "passing", "failing" (default: "all")
 */
export async function get_features(args: {
  project_path: string;
  filter?: "all" | "passing" | "failing";
}): Promise<{
  success: boolean;
  features?: Feature[];
  summary?: {
    total: number;
    passing: number;
    failing: number;
  };
  error?: string;
}> {
  log.call("get_features", args);

  const { project_path, filter = "all" } = args;
  const featuresPath = join(project_path, FEATURES_FILE);

  try {
    if (!existsSync(featuresPath)) {
      return { success: false, error: `Feature file not found: ${featuresPath}` };
    }

    const featureList: FeatureList = JSON.parse(readFileSync(featuresPath, "utf-8"));
    let features = featureList.features;

    if (filter === "passing") {
      features = features.filter((f) => f.passes);
    } else if (filter === "failing") {
      features = features.filter((f) => !f.passes);
    }

    const summary = {
      total: featureList.features.length,
      passing: featureList.features.filter((f) => f.passes).length,
      failing: featureList.features.filter((f) => !f.passes).length,
    };

    log.success("get_features", summary);
    return { success: true, features, summary };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("get_features", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Add a new feature to the feature list
 *
 * @param args.project_path - Path to the project directory
 * @param args.description - Feature description
 * @param args.category - Feature category
 * @param args.steps - Steps to verify the feature
 * @param args.priority - Priority (lower = higher priority)
 */
export async function add_feature(args: {
  project_path: string;
  description: string;
  category?: "functional" | "ui" | "performance" | "security" | "accessibility";
  steps?: string[];
  priority?: number;
}): Promise<{
  success: boolean;
  feature_id?: string;
  error?: string;
}> {
  log.call("add_feature", args);

  const { project_path, description, category = "functional", steps = [], priority } = args;
  const featuresPath = join(project_path, FEATURES_FILE);

  try {
    if (!existsSync(featuresPath)) {
      return { success: false, error: `Feature file not found: ${featuresPath}` };
    }

    const featureList: FeatureList = JSON.parse(readFileSync(featuresPath, "utf-8"));

    const newId = `feature-${featureList.features.length + 1}`;
    const newFeature: Feature = {
      id: newId,
      category,
      description,
      steps: steps.length > 0 ? steps : ["Implement the feature", "Test end-to-end"],
      passes: false,
      priority: priority ?? featureList.features.length + 1,
    };

    featureList.features.push(newFeature);

    if (featureList.metadata) {
      featureList.metadata.lastUpdated = new Date().toISOString();
      featureList.metadata.totalFeatures = featureList.features.length;
    }

    writeFileSync(featuresPath, JSON.stringify(featureList, null, 2));

    log.success("add_feature", { feature_id: newId });
    return { success: true, feature_id: newId };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("add_feature", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Mark a feature as passing or failing
 *
 * IMPORTANT: Only change the passes field. Never delete or modify feature descriptions.
 *
 * @param args.project_path - Path to the project directory
 * @param args.feature_id - ID of the feature to update
 * @param args.passes - Whether the feature now passes
 */
export async function mark_feature(args: {
  project_path: string;
  feature_id: string;
  passes: boolean;
}): Promise<{
  success: boolean;
  error?: string;
}> {
  log.call("mark_feature", args);

  const { project_path, feature_id, passes } = args;
  const featuresPath = join(project_path, FEATURES_FILE);

  try {
    if (!existsSync(featuresPath)) {
      return { success: false, error: `Feature file not found: ${featuresPath}` };
    }

    const featureList: FeatureList = JSON.parse(readFileSync(featuresPath, "utf-8"));
    const feature = featureList.features.find((f) => f.id === feature_id);

    if (!feature) {
      return { success: false, error: `Feature not found: ${feature_id}` };
    }

    feature.passes = passes;

    if (featureList.metadata) {
      featureList.metadata.lastUpdated = new Date().toISOString();
      featureList.metadata.passingFeatures = featureList.features.filter((f) => f.passes).length;
    }

    writeFileSync(featuresPath, JSON.stringify(featureList, null, 2));

    log.success("mark_feature", { feature_id, passes });
    return { success: true };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("mark_feature", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Get the next feature to work on
 *
 * Returns the highest priority feature that hasn't passed yet.
 *
 * @param args.project_path - Path to the project directory
 */
export async function get_next_feature(args: {
  project_path: string;
}): Promise<{
  success: boolean;
  feature?: Feature;
  remaining_count?: number;
  error?: string;
}> {
  log.call("get_next_feature", args);

  const { project_path } = args;
  const featuresPath = join(project_path, FEATURES_FILE);

  try {
    if (!existsSync(featuresPath)) {
      return { success: false, error: `Feature file not found: ${featuresPath}` };
    }

    const featureList: FeatureList = JSON.parse(readFileSync(featuresPath, "utf-8"));
    const failing = featureList.features.filter((f) => !f.passes);

    if (failing.length === 0) {
      log.success("get_next_feature", "All features passing!");
      return { success: true, feature: undefined, remaining_count: 0 };
    }

    // Sort by priority (lower = higher priority)
    const sorted = failing.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
    const nextFeature = sorted[0];

    log.success("get_next_feature", { feature_id: nextFeature.id, remaining: failing.length });
    return { success: true, feature: nextFeature, remaining_count: failing.length };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("get_next_feature", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Commit progress with a descriptive message
 *
 * @param args.project_path - Path to the project directory
 * @param args.message - Commit message describing the work done
 * @param args.files - Optional specific files to commit (default: all changes)
 */
export async function commit_progress(args: {
  project_path: string;
  message: string;
  files?: string[];
}): Promise<{
  success: boolean;
  commit_hash?: string;
  error?: string;
}> {
  log.call("commit_progress", args);

  const { project_path, message, files } = args;

  try {
    // Stage files
    if (files && files.length > 0) {
      await $`cd ${project_path} && git add ${files}`.quiet();
    } else {
      await $`cd ${project_path} && git add -A`.quiet();
    }

    // Check if there are changes to commit
    const status = await $`cd ${project_path} && git status --porcelain`.quiet();
    if (!status.text().trim()) {
      return { success: false, error: "No changes to commit" };
    }

    // Commit
    await $`cd ${project_path} && git commit -m ${message}`.quiet();

    // Get commit hash
    const hash = await $`cd ${project_path} && git rev-parse --short HEAD`.quiet();
    const commitHash = hash.text().trim();

    log.success("commit_progress", { commit_hash: commitHash });
    return { success: true, commit_hash: commitHash };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("commit_progress", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Generate an end-of-session summary
 *
 * Collects all relevant information for handoff to the next session.
 *
 * @param args.project_path - Path to the project directory
 */
export async function session_summary(args: {
  project_path: string;
}): Promise<{
  success: boolean;
  summary?: {
    feature_progress: {
      total: number;
      passing: number;
      failing: number;
      percent_complete: number;
    };
    recent_commits: string;
    next_feature?: Feature;
    recommendations: string[];
  };
  error?: string;
}> {
  log.call("session_summary", args);

  const { project_path } = args;

  try {
    // Get feature progress
    const featuresPath = join(project_path, FEATURES_FILE);
    let featureProgress = {
      total: 0,
      passing: 0,
      failing: 0,
      percent_complete: 0,
    };
    let nextFeature: Feature | undefined;

    if (existsSync(featuresPath)) {
      const featureList: FeatureList = JSON.parse(readFileSync(featuresPath, "utf-8"));
      const passing = featureList.features.filter((f) => f.passes).length;
      const failing = featureList.features.filter((f) => !f.passes);

      featureProgress = {
        total: featureList.features.length,
        passing,
        failing: failing.length,
        percent_complete:
          featureList.features.length > 0
            ? Math.round((passing / featureList.features.length) * 100)
            : 0,
      };

      if (failing.length > 0) {
        nextFeature = failing.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))[0];
      }
    }

    // Get recent commits
    let recentCommits = "No commits yet";
    try {
      const result = await $`cd ${project_path} && git log --oneline -5`.quiet();
      recentCommits = result.text();
    } catch {
      // No commits yet
    }

    // Generate recommendations
    const recommendations: string[] = [];

    if (featureProgress.percent_complete === 100) {
      recommendations.push("All features complete! Consider running comprehensive tests.");
      recommendations.push("Review the codebase for any cleanup opportunities.");
    } else if (nextFeature) {
      recommendations.push(`Next priority: ${nextFeature.description}`);
      recommendations.push("Run init.sh to ensure environment is ready.");
      recommendations.push("Test basic functionality before starting new work.");
    }

    if (featureProgress.failing > 10) {
      recommendations.push("Many features remaining. Focus on core functionality first.");
    }

    const summary = {
      feature_progress: featureProgress,
      recent_commits: recentCommits,
      next_feature: nextFeature,
      recommendations,
    };

    log.success("session_summary", featureProgress);
    return { success: true, summary };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("session_summary", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Run the init script to set up the environment
 *
 * @param args.project_path - Path to the project directory
 */
export async function run_init(args: {
  project_path: string;
}): Promise<{
  success: boolean;
  output?: string;
  error?: string;
}> {
  log.call("run_init", args);

  const { project_path } = args;
  const initPath = join(project_path, INIT_SCRIPT);

  try {
    if (!existsSync(initPath)) {
      return { success: false, error: `Init script not found: ${initPath}` };
    }

    const result = await $`cd ${project_path} && bash ${INIT_SCRIPT}`.quiet();
    const output = result.text();

    log.success("run_init", output.substring(0, 200));
    return { success: true, output };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("run_init", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Expand a high-level feature into detailed sub-features
 *
 * Takes a general feature description and breaks it down into specific,
 * testable sub-features with verification steps.
 *
 * @param args.project_path - Path to the project directory
 * @param args.feature_description - High-level feature to expand
 * @param args.sub_features - Detailed sub-features to add
 */
export async function expand_feature(args: {
  project_path: string;
  feature_description: string;
  sub_features: Array<{
    description: string;
    category?: "functional" | "ui" | "performance" | "security" | "accessibility";
    steps?: string[];
  }>;
}): Promise<{
  success: boolean;
  added_count?: number;
  feature_ids?: string[];
  error?: string;
}> {
  log.call("expand_feature", args);

  const { project_path, feature_description, sub_features } = args;
  const featuresPath = join(project_path, FEATURES_FILE);

  try {
    if (!existsSync(featuresPath)) {
      return { success: false, error: `Feature file not found: ${featuresPath}` };
    }

    const featureList: FeatureList = JSON.parse(readFileSync(featuresPath, "utf-8"));
    const addedIds: string[] = [];

    for (const sf of sub_features) {
      const newId = `feature-${featureList.features.length + 1}`;
      const newFeature: Feature = {
        id: newId,
        category: sf.category || "functional",
        description: `[${feature_description}] ${sf.description}`,
        steps: sf.steps || ["Implement", "Test", "Verify end-to-end"],
        passes: false,
        priority: featureList.features.length + 1,
      };
      featureList.features.push(newFeature);
      addedIds.push(newId);
    }

    if (featureList.metadata) {
      featureList.metadata.lastUpdated = new Date().toISOString();
      featureList.metadata.totalFeatures = featureList.features.length;
    }

    writeFileSync(featuresPath, JSON.stringify(featureList, null, 2));

    log.success("expand_feature", { added_count: addedIds.length });
    return { success: true, added_count: addedIds.length, feature_ids: addedIds };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("expand_feature", errorMsg);
    return { success: false, error: errorMsg };
  }
}
