/**
 * Code Spider Tool - Parallel Agent Inspection of Codebase
 *
 * Spawns multiple AI agents as "spiders" that crawl through the codebase
 * in parallel, analyzing different sections for improvements, issues,
 * and opportunities.
 *
 * Features:
 * - Reads and parses the codemap into logical sections
 * - Spawns parallel agents per section (brainstorm-style analysis)
 * - Multiple inspection modes: improvements, bugs, security, performance, architecture
 * - Synthesizes findings into actionable recommendations
 * - Saves comprehensive reports to history
 */

import { createLogger, extractErrorMessage, type ProgressCallback, getCodeMapContext, spawnWithTimeout } from "./shared/index.ts";
import { saveToolResponse } from "./shared/response_history.ts";
import { getClientCwd } from "./shared/client-context.ts";

const log = createLogger("code_spider");

let globalProgressCallback: ProgressCallback | null = null;

export function setProgressCallback(callback: ProgressCallback | null): void {
  globalProgressCallback = callback;
}

function sendProgress(message: string): void {
  if (globalProgressCallback) {
    globalProgressCallback(message);
  }
}

// ============================================================================
// TYPES
// ============================================================================

interface CodeSection {
  name: string;
  path: string;
  description: string;
  files: string[];
  signatures: string[];
}

interface SpiderFinding {
  section: string;
  agent: string;
  category: "improvement" | "bug" | "security" | "performance" | "architecture" | "general";
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  description: string;
  affected_files?: string[];
  suggestion?: string;
}

interface SpiderResult {
  success: boolean;
  section: string;
  agent: string;
  findings: SpiderFinding[];
  raw_response?: string;
  duration_ms: number;
  error?: string;
}

interface CrawlResult {
  success: boolean;
  total_sections: number;
  sections_analyzed: number;
  findings: SpiderFinding[];
  findings_by_category: Record<string, number>;
  findings_by_severity: Record<string, number>;
  synthesis?: string;
  total_duration_ms: number;
  error?: string;
}

// ============================================================================
// AGENT CONFIGURATION
// ============================================================================

const AGENTS = {
  claude: {
    name: "Claude",
    command: "claude",
    args: ["-p", "--model", "sonnet", "--output-format", "text"],
  },
  codex: {
    name: "Codex",
    command: "codex",
    args: ["exec", "-m", "o4-mini"],
  },
  gemini: {
    name: "Gemini",
    command: "gemini",
    args: ["-m", "flash"],
  },
} as const;

type AgentName = keyof typeof AGENTS;

// ============================================================================
// INSPECTION MODES
// ============================================================================

const INSPECTION_MODES = {
  improvements: {
    name: "Code Improvements",
    description: "Find refactoring opportunities, better patterns, and code quality improvements",
    prompt: `Analyze this code section for IMPROVEMENTS and REFACTORING opportunities:
- Code duplication that could be abstracted
- Patterns that could be simplified
- Better naming or organization suggestions
- Missing abstractions or utilities
- Opportunities for better TypeScript types
- Dead code or unused exports

Format each finding as:
## [SEVERITY: low/medium/high] Title
**Files:** file1.ts, file2.ts
**Issue:** What's the problem
**Suggestion:** How to fix it`,
  },
  bugs: {
    name: "Bug Detection",
    description: "Find potential bugs, edge cases, and error handling issues",
    prompt: `Analyze this code section for potential BUGS and EDGE CASES:
- Null/undefined handling issues
- Race conditions or async problems
- Error handling gaps
- Type safety issues that could cause runtime errors
- Logic errors or off-by-one errors
- Unhandled promise rejections

Format each finding as:
## [SEVERITY: low/medium/high/critical] Title
**Files:** file1.ts, file2.ts
**Bug:** What could go wrong
**Impact:** What happens if this bug triggers
**Fix:** How to prevent it`,
  },
  security: {
    name: "Security Audit",
    description: "Find security vulnerabilities and unsafe patterns",
    prompt: `Analyze this code section for SECURITY vulnerabilities:
- Injection vulnerabilities (command, SQL, XSS)
- Unsafe input handling
- Hardcoded secrets or credentials
- Insecure file operations
- Missing authentication/authorization checks
- Unsafe dependency usage
- Path traversal risks

Format each finding as:
## [SEVERITY: low/medium/high/critical] Title
**Files:** file1.ts, file2.ts
**Vulnerability:** What's the security issue
**Attack Vector:** How it could be exploited
**Mitigation:** How to fix it`,
  },
  performance: {
    name: "Performance Analysis",
    description: "Find performance bottlenecks and optimization opportunities",
    prompt: `Analyze this code section for PERFORMANCE issues:
- Unnecessary re-renders or computations
- N+1 query patterns
- Memory leaks or unbounded growth
- Missing caching opportunities
- Blocking operations that could be async
- Large bundle size contributors
- Inefficient algorithms or data structures

Format each finding as:
## [SEVERITY: low/medium/high] Title
**Files:** file1.ts, file2.ts
**Bottleneck:** What's causing slowness
**Impact:** Estimated performance impact
**Optimization:** How to improve it`,
  },
  architecture: {
    name: "Architecture Review",
    description: "Find architectural issues and design improvements",
    prompt: `Analyze this code section for ARCHITECTURE and DESIGN issues:
- Coupling and cohesion problems
- Dependency direction violations
- Missing separation of concerns
- Scalability limitations
- Testing difficulties (hard to mock/test)
- Configuration/environment handling
- Error boundary gaps

Format each finding as:
## [SEVERITY: low/medium/high] Title
**Files:** file1.ts, file2.ts
**Issue:** What's the architectural problem
**Impact:** How it affects maintainability/scalability
**Refactoring:** Suggested architectural change`,
  },
  all: {
    name: "Comprehensive Analysis",
    description: "Run all inspection modes for thorough coverage",
    prompt: `Perform a COMPREHENSIVE code review covering:
1. Code quality and refactoring opportunities
2. Potential bugs and edge cases
3. Security vulnerabilities
4. Performance issues
5. Architecture and design problems

Format each finding as:
## [CATEGORY: improvement/bug/security/performance/architecture] [SEVERITY: low/medium/high/critical] Title
**Files:** file1.ts, file2.ts
**Issue:** What's the problem
**Suggestion:** How to address it`,
  },
} as const;

type InspectionMode = keyof typeof INSPECTION_MODES;

// ============================================================================
// CODEMAP PARSING
// ============================================================================

/**
 * Parse codemap into logical sections for parallel analysis
 */
function parseCodeMapIntoSections(codemap: string): CodeSection[] {
  const sections: CodeSection[] = [];
  const lines = codemap.split("\n");

  // Group files by top-level directory
  const filesByDir: Map<string, { files: string[]; signatures: string[] }> = new Map();

  let currentFile = "";
  let currentSignatures: string[] = [];

  for (const line of lines) {
    // Detect file paths (common patterns in codemaps)
    const fileMatch = line.match(/^(?:##?\s+)?(?:\[|\*\*)?([a-zA-Z0-9_./-]+\.[a-z]+)(?:\]|\*\*)?/);
    if (fileMatch) {
      // Save previous file's signatures
      if (currentFile && currentSignatures.length > 0) {
        const dir = getTopLevelDir(currentFile);
        if (!filesByDir.has(dir)) {
          filesByDir.set(dir, { files: [], signatures: [] });
        }
        const dirData = filesByDir.get(dir)!;
        dirData.files.push(currentFile);
        dirData.signatures.push(...currentSignatures);
      }

      currentFile = fileMatch[1];
      currentSignatures = [];
      continue;
    }

    // Capture signature lines (export, function, class, interface, type definitions)
    if (currentFile && isSignatureLine(line)) {
      currentSignatures.push(line.trim());
    }
  }

  // Don't forget the last file
  if (currentFile && currentSignatures.length > 0) {
    const dir = getTopLevelDir(currentFile);
    if (!filesByDir.has(dir)) {
      filesByDir.set(dir, { files: [], signatures: [] });
    }
    const dirData = filesByDir.get(dir)!;
    dirData.files.push(currentFile);
    dirData.signatures.push(...currentSignatures);
  }

  // Convert to sections
  for (const [dir, data] of filesByDir) {
    if (data.files.length === 0) continue;

    sections.push({
      name: dir || "root",
      path: dir || ".",
      description: describeSection(dir, data.files),
      files: data.files,
      signatures: data.signatures.slice(0, 100), // Limit signatures per section
    });
  }

  // If we got no sections from parsing, create a single section from the whole codemap
  if (sections.length === 0) {
    sections.push({
      name: "codebase",
      path: ".",
      description: "Full codebase analysis",
      files: [],
      signatures: codemap.split("\n").filter(l => l.trim()).slice(0, 200),
    });
  }

  return sections;
}

/**
 * Get the top-level directory from a file path
 */
function getTopLevelDir(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 1) return "";
  // Skip hidden directories and common non-interesting directories
  let dir = parts[0];
  if (dir.startsWith(".") && parts.length > 2) {
    dir = parts[0] + "/" + parts[1];
  }
  return dir;
}

/**
 * Check if a line looks like a code signature
 */
function isSignatureLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) return false;

  return /^(export\s+)?(async\s+)?(function|const|let|var|class|interface|type|enum)\s+\w+/.test(trimmed) ||
         /^(export\s+)?default\s+/.test(trimmed) ||
         /^\s*(public|private|protected)\s+(static\s+)?(async\s+)?(\w+)\s*[(<]/.test(trimmed);
}

/**
 * Generate a description for a code section
 */
function describeSection(dir: string, files: string[]): string {
  const extensions = new Set(files.map(f => f.split(".").pop()));
  const extList = Array.from(extensions).join(", ");

  if (dir.includes("test") || dir.includes("spec")) {
    return `Test files (${extList})`;
  }
  if (dir.includes("component") || dir.includes("ui")) {
    return `UI components (${extList})`;
  }
  if (dir.includes("hook")) {
    return `React hooks (${extList})`;
  }
  if (dir.includes("util") || dir.includes("helper") || dir.includes("lib")) {
    return `Utility/helper functions (${extList})`;
  }
  if (dir.includes("api") || dir.includes("service")) {
    return `API/service layer (${extList})`;
  }
  if (dir.includes("tool")) {
    return `Tools and utilities (${extList})`;
  }
  if (dir.includes("shared")) {
    return `Shared code (${extList})`;
  }

  return `${files.length} files (${extList})`;
}

// ============================================================================
// SPIDER AGENT EXECUTION
// ============================================================================

/**
 * Run a spider agent on a code section
 */
async function runSpiderAgent(
  section: CodeSection,
  mode: InspectionMode,
  agentKey: AgentName,
  timeout: number
): Promise<SpiderResult> {
  const agent = AGENTS[agentKey];
  const modeConfig = INSPECTION_MODES[mode];
  const startTime = Date.now();

  log.info(`[${agent.name}] Inspecting ${section.name}...`);
  sendProgress(`[${agent.name}] 🕷️ Crawling ${section.name}...`);

  // Build the inspection prompt
  const sectionContext = section.signatures.length > 0
    ? section.signatures.join("\n")
    : `Section: ${section.name}\nFiles: ${section.files.join(", ")}`;

  const prompt = `${modeConfig.prompt}

## Code Section: ${section.name}
${section.description}

### Code Signatures:
\`\`\`
${sectionContext}
\`\`\`

Analyze this section and provide specific, actionable findings. Be thorough but concise.
If you find no issues in a category, say "No issues found" for that category.`;

  try {
    const result = await spawnWithTimeout({
      command: agent.command,
      args: [...agent.args, prompt],
      timeoutMs: timeout,
      env: { CI: "true", TERM: "dumb" },
      onProgress: (chars, elapsedMs) => {
        const elapsed = Math.round(elapsedMs / 1000);
        sendProgress(`[${agent.name}] 🕷️ ${section.name} (${elapsed}s, ${chars} chars)`);
      },
      progressIntervalMs: 5000,
    });

    const duration_ms = result.durationMs;

    if (result.timedOut) {
      return {
        success: false,
        section: section.name,
        agent: agent.name,
        findings: [],
        duration_ms,
        error: `Timeout after ${timeout / 1000}s`,
      };
    }

    if (!result.success) {
      return {
        success: false,
        section: section.name,
        agent: agent.name,
        findings: [],
        duration_ms,
        error: result.error || result.stderr || `Exit code ${result.exitCode}`,
      };
    }

    // Parse findings from response
    const findings = parseFindingsFromResponse(result.stdout, section.name, agent.name, mode);

    sendProgress(`[${agent.name}] ✓ ${section.name}: ${findings.length} findings`);

    return {
      success: true,
      section: section.name,
      agent: agent.name,
      findings,
      raw_response: result.stdout,
      duration_ms,
    };
  } catch (error) {
    return {
      success: false,
      section: section.name,
      agent: agent.name,
      findings: [],
      duration_ms: Date.now() - startTime,
      error: extractErrorMessage(error),
    };
  }
}

/**
 * Parse findings from agent response
 */
function parseFindingsFromResponse(
  response: string,
  section: string,
  agent: string,
  mode: InspectionMode
): SpiderFinding[] {
  const findings: SpiderFinding[] = [];

  // Match headings that contain severity/category markers
  const headingPattern = /##\s*\[([^\]]+)\]\s*\[?([^\]\n]*)\]?\s*([^\n]+)/g;
  let match;

  while ((match = headingPattern.exec(response)) !== null) {
    const marker1 = match[1].toLowerCase();
    const marker2 = match[2]?.toLowerCase() || "";
    const title = match[3].trim();

    // Extract category
    let category: SpiderFinding["category"] = "general";
    const categoryMarkers = ["improvement", "bug", "security", "performance", "architecture"];
    for (const cat of categoryMarkers) {
      if (marker1.includes(cat) || marker2.includes(cat)) {
        category = cat as SpiderFinding["category"];
        break;
      }
    }

    // Default category based on mode
    if (category === "general" && mode !== "all") {
      const modeToCategory: Record<string, SpiderFinding["category"]> = {
        improvements: "improvement",
        bugs: "bug",
        security: "security",
        performance: "performance",
        architecture: "architecture",
      };
      category = modeToCategory[mode] || "general";
    }

    // Extract severity
    let severity: SpiderFinding["severity"] = "medium";
    if (marker1.includes("critical") || marker2.includes("critical")) severity = "critical";
    else if (marker1.includes("high") || marker2.includes("high")) severity = "high";
    else if (marker1.includes("low") || marker2.includes("low")) severity = "low";
    else if (marker1.includes("info") || marker2.includes("info")) severity = "info";

    // Get the content after this heading until the next heading
    const headingEnd = match.index + match[0].length;
    const nextHeadingMatch = response.substring(headingEnd).match(/\n##\s/);
    const contentEnd = nextHeadingMatch
      ? headingEnd + nextHeadingMatch.index!
      : response.length;
    const content = response.substring(headingEnd, contentEnd).trim();

    // Parse affected files
    const filesMatch = content.match(/\*\*Files?:?\*\*\s*([^\n]+)/i);
    const affected_files = filesMatch
      ? filesMatch[1].split(/[,;]/).map(f => f.trim()).filter(f => f)
      : undefined;

    // Parse suggestion
    const suggestionMatch = content.match(/\*\*(?:Suggestion|Fix|Mitigation|Optimization|Refactoring):?\*\*\s*([\s\S]*?)(?=\*\*|$)/i);
    const suggestion = suggestionMatch ? suggestionMatch[1].trim() : undefined;

    // Parse description (issue/bug/vulnerability/bottleneck)
    const descMatch = content.match(/\*\*(?:Issue|Bug|Vulnerability|Bottleneck|Problem):?\*\*\s*([\s\S]*?)(?=\*\*|$)/i);
    const description = descMatch ? descMatch[1].trim() : content.split("\n\n")[0] || title;

    findings.push({
      section,
      agent,
      category,
      severity,
      title,
      description,
      affected_files,
      suggestion,
    });
  }

  // If no structured findings found, try to extract from bullet points
  if (findings.length === 0) {
    const bulletPattern = /^[-*]\s+(.+)$/gm;
    let bulletMatch;
    while ((bulletMatch = bulletPattern.exec(response)) !== null) {
      const text = bulletMatch[1].trim();
      if (text.length > 20 && !text.toLowerCase().includes("no issues")) {
        findings.push({
          section,
          agent,
          category: mode === "all" ? "general" : (mode as SpiderFinding["category"]),
          severity: "medium",
          title: text.substring(0, 80) + (text.length > 80 ? "..." : ""),
          description: text,
        });
      }
    }
  }

  return findings;
}

// ============================================================================
// MAIN FUNCTIONS
// ============================================================================

/**
 * Crawl the codebase with spider agents
 *
 * Reads the codemap, splits it into sections, and spawns parallel agents
 * to inspect each section for the specified mode.
 *
 * @param args.mode - Inspection mode: improvements, bugs, security, performance, architecture, all
 * @param args.agents - Which agents to use per section (default: all three)
 * @param args.max_sections - Maximum sections to analyze (default: 10)
 * @param args.timeout_seconds - Timeout per agent (default: 90)
 * @param args.parallel - How many sections to analyze in parallel (default: 3)
 */
export async function crawl(args: {
  mode?: InspectionMode;
  agents?: AgentName[];
  max_sections?: number;
  timeout_seconds?: number;
  parallel?: number;
}): Promise<CrawlResult> {
  log.call("crawl", args);
  const {
    mode = "all",
    agents = ["claude", "codex", "gemini"],
    max_sections = 10,
    timeout_seconds = 90,
    parallel = 3,
  } = args;

  const startTime = Date.now();
  const timeout = timeout_seconds * 1000;

  sendProgress("🕷️ Loading codebase structure...");

  // Get codemap
  const codemap = await getCodeMapContext(getClientCwd(), false);
  if (!codemap) {
    return {
      success: false,
      total_sections: 0,
      sections_analyzed: 0,
      findings: [],
      findings_by_category: {},
      findings_by_severity: {},
      total_duration_ms: Date.now() - startTime,
      error: "Could not load codemap - ensure you're in a git repository",
    };
  }

  // Parse into sections
  const allSections = parseCodeMapIntoSections(codemap);
  const sections = allSections.slice(0, max_sections);

  sendProgress(`🕷️ Found ${allSections.length} sections, analyzing ${sections.length}...`);
  log.info(`Analyzing ${sections.length} sections with ${agents.length} agents each`);

  // Run spider agents in parallel batches
  const allFindings: SpiderFinding[] = [];
  let sectionsAnalyzed = 0;

  // Process sections in batches
  for (let i = 0; i < sections.length; i += parallel) {
    const batch = sections.slice(i, i + parallel);
    sendProgress(`🕷️ Batch ${Math.floor(i / parallel) + 1}: Analyzing ${batch.map(s => s.name).join(", ")}...`);

    // For each section in batch, run all agents in parallel
    const batchPromises: Promise<SpiderResult>[] = [];

    for (const section of batch) {
      // Distribute agents across sections for diversity
      // Each section gets analyzed by one agent (round-robin)
      const agentIndex = sections.indexOf(section) % agents.length;
      const agent = agents[agentIndex];

      batchPromises.push(runSpiderAgent(section, mode, agent, timeout));
    }

    const batchResults = await Promise.all(batchPromises);

    for (const result of batchResults) {
      if (result.success) {
        sectionsAnalyzed++;
        allFindings.push(...result.findings);
      } else {
        log.warn(`Spider failed on ${result.section}: ${result.error}`);
      }
    }
  }

  // Categorize findings
  const findings_by_category: Record<string, number> = {};
  const findings_by_severity: Record<string, number> = {};

  for (const finding of allFindings) {
    findings_by_category[finding.category] = (findings_by_category[finding.category] || 0) + 1;
    findings_by_severity[finding.severity] = (findings_by_severity[finding.severity] || 0) + 1;
  }

  // Sort findings by severity (critical first)
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  allFindings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const total_duration_ms = Date.now() - startTime;

  log.success("crawl", { sectionsAnalyzed, findingsCount: allFindings.length });
  sendProgress(`🕷️ Crawl complete: ${allFindings.length} findings from ${sectionsAnalyzed} sections`);

  const result: CrawlResult = {
    success: true,
    total_sections: allSections.length,
    sections_analyzed: sectionsAnalyzed,
    findings: allFindings,
    findings_by_category,
    findings_by_severity,
    total_duration_ms,
  };

  // Save to history
  if (allFindings.length > 0) {
    const historyContent = formatFindingsAsMarkdown(allFindings, mode, total_duration_ms);
    try {
      await saveToolResponse({
        tool: "code_spider",
        topic: `${INSPECTION_MODES[mode].name} - ${sectionsAnalyzed} sections`,
        content: historyContent,
        tags: ["code-spider", mode, ...Object.keys(findings_by_category)],
        duration_ms: total_duration_ms,
        agents: agents.map(a => AGENTS[a].name),
        extras: {
          mode,
          sections_analyzed: sectionsAnalyzed,
          total_findings: allFindings.length,
          findings_by_category,
          findings_by_severity,
        },
      });
    } catch (e) {
      log.warn("Failed to save response to history", e);
    }
  }

  return result;
}

/**
 * Quick spider scan - fast analysis with single agent
 *
 * @param args.mode - Inspection mode (default: improvements)
 * @param args.max_sections - Maximum sections (default: 5)
 */
export async function quick_scan(args: {
  mode?: InspectionMode;
  max_sections?: number;
}): Promise<CrawlResult> {
  log.call("quick_scan", args);

  return crawl({
    mode: args.mode || "improvements",
    agents: ["gemini"], // Fastest agent
    max_sections: args.max_sections || 5,
    timeout_seconds: 60,
    parallel: 3,
  });
}

/**
 * Deep spider scan - thorough multi-agent analysis
 *
 * @param args.mode - Inspection mode (default: all)
 * @param args.max_sections - Maximum sections (default: 15)
 */
export async function deep_scan(args: {
  mode?: InspectionMode;
  max_sections?: number;
}): Promise<CrawlResult> {
  log.call("deep_scan", args);

  return crawl({
    mode: args.mode || "all",
    agents: ["claude", "codex", "gemini"],
    max_sections: args.max_sections || 15,
    timeout_seconds: 120,
    parallel: 2, // Less parallel for deeper analysis
  });
}

/**
 * Security-focused spider scan
 */
export async function security_scan(args: {
  max_sections?: number;
}): Promise<CrawlResult> {
  log.call("security_scan", args);

  return crawl({
    mode: "security",
    agents: ["claude", "codex"], // Best at security analysis
    max_sections: args.max_sections || 10,
    timeout_seconds: 90,
    parallel: 2,
  });
}

/**
 * List available inspection modes
 */
export async function list_modes(): Promise<{
  success: boolean;
  modes: Array<{ key: string; name: string; description: string }>;
}> {
  log.call("list_modes", {});

  const modes = Object.entries(INSPECTION_MODES).map(([key, config]) => ({
    key,
    name: config.name,
    description: config.description,
  }));

  return { success: true, modes };
}

/**
 * Analyze a specific directory/section
 *
 * @param args.path - Directory path to analyze
 * @param args.mode - Inspection mode
 */
export async function analyze_section(args: {
  path: string;
  mode?: InspectionMode;
  agents?: AgentName[];
  timeout_seconds?: number;
}): Promise<SpiderResult[]> {
  log.call("analyze_section", args);
  const {
    path,
    mode = "all",
    agents = ["claude", "codex", "gemini"],
    timeout_seconds = 90,
  } = args;

  const timeout = timeout_seconds * 1000;

  // Create a section from the path
  const section: CodeSection = {
    name: path,
    path,
    description: `Analysis of ${path}`,
    files: [],
    signatures: [],
  };

  // Get codemap and extract signatures for this path
  const codemap = await getCodeMapContext(getClientCwd(), false);
  if (codemap) {
    const lines = codemap.split("\n");
    let inSection = false;

    for (const line of lines) {
      if (line.includes(path)) {
        inSection = true;
      }
      if (inSection && isSignatureLine(line)) {
        section.signatures.push(line.trim());
      }
      // Stop if we've moved to a different top-level section
      if (inSection && line.startsWith("##") && !line.includes(path)) {
        break;
      }
    }
  }

  sendProgress(`🕷️ Analyzing ${path} with ${agents.length} agents...`);

  // Run all agents on this section
  const promises = agents.map(agent =>
    runSpiderAgent(section, mode, agent, timeout)
  );

  const results = await Promise.all(promises);

  log.success("analyze_section", { results: results.length });
  return results;
}

/**
 * Synthesize findings into prioritized recommendations
 *
 * @param args.findings - Findings to synthesize
 */
export async function synthesize(args: {
  findings: SpiderFinding[];
  timeout_seconds?: number;
}): Promise<{
  success: boolean;
  synthesis?: string;
  top_priorities?: string[];
  error?: string;
}> {
  log.call("synthesize", args);
  const { findings, timeout_seconds = 90 } = args;

  if (!findings || findings.length === 0) {
    return { success: false, error: "No findings to synthesize" };
  }

  const prompt = `Analyze these code review findings and provide a prioritized action plan:

${findings.map(f => `- [${f.severity.toUpperCase()}][${f.category}] ${f.title}: ${f.description}`).join("\n")}

Provide:
1. TOP 5 PRIORITIES - The most important issues to address first
2. QUICK WINS - Easy fixes with good impact
3. TECHNICAL DEBT - Items to address over time
4. SUMMARY - Overall health assessment of the codebase`;

  try {
    const result = await spawnWithTimeout({
      command: AGENTS.claude.command,
      args: [...AGENTS.claude.args, prompt],
      timeoutMs: timeout_seconds * 1000,
      env: { CI: "true", TERM: "dumb" },
    });

    if (!result.success) {
      return { success: false, error: result.error || "Synthesis failed" };
    }

    // Extract top priorities from response
    const prioritiesMatch = result.stdout.match(/TOP 5 PRIORITIES[\s\S]*?(?=QUICK WINS|TECHNICAL DEBT|SUMMARY|$)/i);
    const priorities = prioritiesMatch
      ? prioritiesMatch[0]
          .split("\n")
          .filter(l => /^\d+\./.test(l.trim()) || l.trim().startsWith("-"))
          .map(l => l.replace(/^[\d.\-*]+\s*/, "").trim())
          .filter(l => l.length > 10)
          .slice(0, 5)
      : undefined;

    return {
      success: true,
      synthesis: result.stdout,
      top_priorities: priorities,
    };
  } catch (error) {
    return { success: false, error: extractErrorMessage(error) };
  }
}

// ============================================================================
// FORMATTING
// ============================================================================

/**
 * Format findings as markdown for history
 */
function formatFindingsAsMarkdown(
  findings: SpiderFinding[],
  mode: InspectionMode,
  duration_ms: number
): string {
  const lines: string[] = [
    `# Code Spider Report: ${INSPECTION_MODES[mode].name}`,
    "",
    `**Duration:** ${(duration_ms / 1000).toFixed(1)}s`,
    `**Total Findings:** ${findings.length}`,
    "",
  ];

  // Group by severity
  const critical = findings.filter(f => f.severity === "critical");
  const high = findings.filter(f => f.severity === "high");
  const medium = findings.filter(f => f.severity === "medium");
  const low = findings.filter(f => f.severity === "low");

  if (critical.length > 0) {
    lines.push("## 🔴 Critical Issues", "");
    for (const f of critical) {
      lines.push(formatFinding(f));
    }
  }

  if (high.length > 0) {
    lines.push("## 🟠 High Priority", "");
    for (const f of high) {
      lines.push(formatFinding(f));
    }
  }

  if (medium.length > 0) {
    lines.push("## 🟡 Medium Priority", "");
    for (const f of medium) {
      lines.push(formatFinding(f));
    }
  }

  if (low.length > 0) {
    lines.push("## 🟢 Low Priority", "");
    for (const f of low) {
      lines.push(formatFinding(f));
    }
  }

  return lines.join("\n");
}

function formatFinding(f: SpiderFinding): string {
  const lines = [
    `### ${f.title}`,
    `**Section:** ${f.section} | **Category:** ${f.category} | **Agent:** ${f.agent}`,
    "",
    f.description,
    "",
  ];

  if (f.affected_files?.length) {
    lines.push(`**Files:** ${f.affected_files.join(", ")}`, "");
  }

  if (f.suggestion) {
    lines.push(`**Suggestion:** ${f.suggestion}`, "");
  }

  lines.push("---", "");
  return lines.join("\n");
}
