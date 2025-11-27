/**
 * Repo Prompt Tool - Pack repository code for LLM consumption
 *
 * Inspired by RepoPrompt, this tool optimizes code context for LLMs by:
 * - Packaging files in structured XML format
 * - Generating CodeMaps (signatures only) for token efficiency
 * - Estimating token counts
 * - Respecting .gitignore and custom ignore patterns
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname, basename, dirname } from "node:path";
import { $ } from "bun";
import { createLogger, extractErrorMessage } from "./shared/index.ts";

const log = createLogger("repo_prompt");

// Language mappings for file extensions
const LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".vue": "vue",
  ".svelte": "svelte",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".xml": "xml",
  ".md": "markdown",
  ".sql": "sql",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "zsh",
  ".fish": "fish",
  ".dockerfile": "dockerfile",
  ".toml": "toml",
  ".ini": "ini",
  ".env": "env",
  ".graphql": "graphql",
  ".proto": "protobuf",
};

// Default ignore patterns (common files to exclude)
const DEFAULT_IGNORES = [
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "out",
  ".cache",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "venv",
  ".venv",
  "env",
  ".env.local",
  ".DS_Store",
  "Thumbs.db",
  "*.log",
  "*.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.pyc",
  "*.pyo",
  "*.class",
  "*.o",
  "*.obj",
  "*.exe",
  "*.dll",
  "*.so",
  "*.dylib",
];

// Patterns for extracting code signatures
const SIGNATURE_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /^export\s+(interface|type|enum|class|abstract\s+class)\s+\w+[^{]*\{/gm,
    /^export\s+(const|let|var|function|async\s+function)\s+\w+[^=;{]*[=:]/gm,
    /^(interface|type|enum|class|abstract\s+class)\s+\w+[^{]*\{/gm,
    /^(const|let|var|function|async\s+function)\s+\w+.*?(?=\{|\=\>)/gm,
  ],
  javascript: [
    /^export\s+(class|function|async\s+function)\s+\w+[^{]*\{/gm,
    /^export\s+(const|let|var)\s+\w+\s*=/gm,
    /^(class|function|async\s+function)\s+\w+[^{]*\{/gm,
    /^(const|let|var)\s+\w+\s*=\s*(async\s+)?\([^)]*\)\s*=>/gm,
  ],
  python: [
    /^(class|def|async\s+def)\s+\w+[^:]*:/gm,
    /^@\w+(\([^)]*\))?$/gm,
  ],
  go: [
    /^(type|func|interface)\s+\w+[^{]*\{/gm,
    /^(var|const)\s+\w+/gm,
  ],
  rust: [
    /^(pub\s+)?(fn|struct|enum|trait|impl|type|const|static)\s+\w+[^{;]*[{;]/gm,
  ],
  java: [
    /^(public|private|protected)?\s*(static)?\s*(class|interface|enum)\s+\w+[^{]*\{/gm,
    /^(public|private|protected)?\s*(static)?\s*\w+\s+\w+\s*\([^)]*\)/gm,
  ],
};

/**
 * Get language type from file extension
 */
function getLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return LANGUAGE_MAP[ext] || "text";
}

/**
 * Check if a path matches any ignore pattern
 */
function shouldIgnore(
  path: string,
  ignorePatterns: string[],
  basePath: string
): boolean {
  const relativePath = relative(basePath, path);
  const fileName = basename(path);

  for (const pattern of ignorePatterns) {
    // Handle glob patterns with *
    if (pattern.includes("*")) {
      const regex = new RegExp(
        "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$"
      );
      if (regex.test(fileName) || regex.test(relativePath)) {
        return true;
      }
    } else {
      // Direct match for directory or file name
      if (
        fileName === pattern ||
        relativePath === pattern ||
        relativePath.startsWith(pattern + "/") ||
        relativePath.includes("/" + pattern + "/") ||
        relativePath.includes("/" + pattern)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Load .gitignore patterns from a directory
 */
function loadGitignore(dir: string): string[] {
  const gitignorePath = join(dir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    return [];
  }

  try {
    const content = readFileSync(gitignorePath, "utf-8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * Recursively collect files from a directory
 */
function collectFiles(
  dir: string,
  basePath: string,
  ignorePatterns: string[],
  maxFiles: number = 500
): string[] {
  const files: string[] = [];

  function walk(currentDir: string): void {
    if (files.length >= maxFiles) return;

    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) break;

      const fullPath = join(currentDir, entry.name);

      if (shouldIgnore(fullPath, ignorePatterns, basePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files;
}

/**
 * Estimate token count using a simple approximation
 * ~4 characters per token on average for code
 */
function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

/**
 * Extract code signatures/definitions from content
 */
function extractSignatures(content: string, language: string): string {
  const patterns = SIGNATURE_PATTERNS[language];
  if (!patterns) {
    // For unknown languages, try to extract obvious definitions
    const lines = content.split("\n");
    const signatures: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      // Look for common definition patterns
      if (
        /^(export\s+)?(class|interface|type|enum|function|def|fn|pub fn|struct|impl|trait)\s+\w+/.test(
          trimmed
        )
      ) {
        signatures.push(trimmed);
      }
    }

    return signatures.join("\n");
  }

  const signatures = new Set<string>();
  const lines = content.split("\n");

  for (const pattern of patterns) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (match) {
        // Get the signature line and possibly the next few lines for context
        let sig = line.trim();

        // For function/method definitions, include parameter list if split across lines
        if (sig.includes("(") && !sig.includes(")")) {
          for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
            sig += " " + lines[j].trim();
            if (lines[j].includes(")")) break;
          }
        }

        // Clean up and truncate if too long
        sig = sig.replace(/\s+/g, " ").trim();
        if (sig.length > 200) {
          sig = sig.substring(0, 200) + "...";
        }

        signatures.add(sig);
      }
    }
  }

  return Array.from(signatures).join("\n");
}

/**
 * Generate XML format for files (RepoPrompt-style)
 */
function formatAsXml(
  files: { path: string; content: string; isCodemap?: boolean }[],
  instruction?: string
): string {
  const lines: string[] = ["<prompt>"];

  if (instruction) {
    lines.push("  <instruction>");
    lines.push(`    ${instruction}`);
    lines.push("  </instruction>");
  }

  lines.push("  <files>");

  for (const file of files) {
    const language = getLanguage(file.path);
    const format = file.isCodemap ? ' format="codemap"' : "";
    lines.push(`    <file path="${file.path}" type="${language}"${format}>`);
    lines.push(file.content);
    lines.push("    </file>");
  }

  lines.push("  </files>");
  lines.push("</prompt>");

  return lines.join("\n");
}

/**
 * Generate Markdown format for files
 */
function formatAsMarkdown(
  files: { path: string; content: string; isCodemap?: boolean }[],
  instruction?: string
): string {
  const lines: string[] = [];

  if (instruction) {
    lines.push("## Instruction");
    lines.push("");
    lines.push(instruction);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  lines.push("## Files");
  lines.push("");

  for (const file of files) {
    const language = getLanguage(file.path);
    const formatNote = file.isCodemap ? " (CodeMap - signatures only)" : "";
    lines.push(`### ${file.path}${formatNote}`);
    lines.push("");
    lines.push("```" + language);
    lines.push(file.content);
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate a tree structure of the repository
 */
function generateTree(files: string[], basePath: string): string {
  const tree: Map<string, Set<string>> = new Map();

  for (const file of files) {
    const relativePath = relative(basePath, file);
    const parts = relativePath.split("/");
    let currentPath = "";

    for (let i = 0; i < parts.length - 1; i++) {
      const parent = currentPath || ".";
      currentPath = currentPath ? currentPath + "/" + parts[i] : parts[i];

      if (!tree.has(parent)) {
        tree.set(parent, new Set());
      }
      tree.get(parent)!.add(parts[i] + "/");
    }

    const dir = dirname(relativePath);
    const dirKey = dir === "." ? "." : dir;
    if (!tree.has(dirKey)) {
      tree.set(dirKey, new Set());
    }
    tree.get(dirKey)!.add(basename(file));
  }

  const lines: string[] = [];

  function renderDir(path: string, indent: string): void {
    const children = tree.get(path);
    if (!children) return;

    const sorted = Array.from(children).sort((a, b) => {
      const aIsDir = a.endsWith("/");
      const bIsDir = b.endsWith("/");
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.localeCompare(b);
    });

    for (let i = 0; i < sorted.length; i++) {
      const item = sorted[i];
      const isLast = i === sorted.length - 1;
      const prefix = isLast ? "└── " : "├── ";
      const childIndent = isLast ? "    " : "│   ";

      lines.push(indent + prefix + item);

      if (item.endsWith("/")) {
        const childPath = path === "." ? item.slice(0, -1) : path + "/" + item.slice(0, -1);
        renderDir(childPath, indent + childIndent);
      }
    }
  }

  lines.push(".");
  renderDir(".", "");

  return lines.join("\n");
}

// ============================================================================
// Exported Tool Functions
// ============================================================================

/**
 * Pack repository files into XML or Markdown format for LLM consumption
 * @param args.path - Path to repository or directory (defaults to current directory)
 * @param args.files - Specific files to include (optional, overrides auto-discovery)
 * @param args.glob - Glob pattern to filter files (e.g., "*.ts", "src/**\/*.tsx")
 * @param args.format - Output format: "xml" (default) or "markdown"
 * @param args.instruction - Instruction to include in the prompt
 * @param args.use_codemap - Use CodeMap format for context files (signatures only)
 * @param args.target_files - Files to include with full content (others become codemaps)
 * @param args.max_files - Maximum number of files to include (default: 100)
 * @param args.ignore - Additional patterns to ignore
 */
export async function pack_repo(args: {
  path?: string;
  files?: string[];
  glob?: string;
  format?: "xml" | "markdown";
  instruction?: string;
  use_codemap?: boolean;
  target_files?: string[];
  max_files?: number;
  ignore?: string[];
}): Promise<{
  success: boolean;
  output?: string;
  file_count?: number;
  token_estimate?: number;
  error?: string;
}> {
  log.call("pack_repo", args);

  const basePath = args.path || process.cwd();
  const format = args.format || "xml";
  const maxFiles = args.max_files || 100;
  const useCodemap = args.use_codemap || false;
  const targetFiles = new Set(args.target_files || []);

  if (!existsSync(basePath)) {
    const error = `Path not found: ${basePath}`;
    log.error("pack_repo", error);
    return { success: false, error };
  }

  try {
    let filePaths: string[];

    if (args.files && args.files.length > 0) {
      // Use specified files
      filePaths = args.files.map((f) =>
        f.startsWith("/") ? f : join(basePath, f)
      );
    } else if (args.glob) {
      // Use glob pattern
      const result = await $`cd ${basePath} && find . -type f -name "${args.glob}" 2>/dev/null | head -${maxFiles}`.text();
      filePaths = result
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((f) => join(basePath, f.replace(/^\.\//, "")));
    } else {
      // Auto-discover files
      const gitignorePatterns = loadGitignore(basePath);
      const ignorePatterns = [
        ...DEFAULT_IGNORES,
        ...gitignorePatterns,
        ...(args.ignore || []),
      ];
      filePaths = collectFiles(basePath, basePath, ignorePatterns, maxFiles);
    }

    // Filter to only existing files
    filePaths = filePaths.filter((f) => existsSync(f) && statSync(f).isFile());

    if (filePaths.length === 0) {
      return { success: false, error: "No files found" };
    }

    // Read and process files
    const files: { path: string; content: string; isCodemap?: boolean }[] = [];

    for (const filePath of filePaths) {
      try {
        const content = readFileSync(filePath, "utf-8");
        const relativePath = relative(basePath, filePath);
        const language = getLanguage(filePath);

        // Determine if this file should be a codemap
        // If useCodemap is true and no target_files specified, ALL files become codemaps
        // If useCodemap is true and target_files specified, only non-target files become codemaps
        const shouldBeCodemap =
          useCodemap && (targetFiles.size === 0 || !targetFiles.has(relativePath));

        if (shouldBeCodemap) {
          const signatures = extractSignatures(content, language);
          files.push({
            path: relativePath,
            content: signatures || "// No signatures extracted",
            isCodemap: true,
          });
        } else {
          files.push({
            path: relativePath,
            content,
          });
        }
      } catch (err) {
        log.warn(`Failed to read file: ${filePath}`);
      }
    }

    // Format output
    const output =
      format === "xml"
        ? formatAsXml(files, args.instruction)
        : formatAsMarkdown(files, args.instruction);

    const tokenEstimate = estimateTokens(output);

    log.success("pack_repo", `Packed ${files.length} files, ~${tokenEstimate} tokens`);
    return {
      success: true,
      output,
      file_count: files.length,
      token_estimate: tokenEstimate,
    };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("pack_repo", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Generate CodeMap (signatures only) for files to save tokens
 * @param args.path - Path to repository or directory
 * @param args.files - Specific files to generate codemaps for
 * @param args.glob - Glob pattern to filter files
 * @param args.format - Output format: "xml" (default) or "markdown"
 */
export async function generate_codemap(args: {
  path?: string;
  files?: string[];
  glob?: string;
  format?: "xml" | "markdown";
}): Promise<{
  success: boolean;
  output?: string;
  file_count?: number;
  token_estimate?: number;
  error?: string;
}> {
  log.call("generate_codemap", args);

  // Delegate to pack_repo with codemap settings
  return pack_repo({
    ...args,
    use_codemap: true,
    target_files: [], // All files become codemaps
  });
}

/**
 * Get repository structure as a tree
 * @param args.path - Path to repository or directory (defaults to current directory)
 * @param args.max_files - Maximum number of files to include in tree (default: 500)
 * @param args.ignore - Additional patterns to ignore
 */
export async function get_repo_structure(args: {
  path?: string;
  max_files?: number;
  ignore?: string[];
}): Promise<{
  success: boolean;
  tree?: string;
  file_count?: number;
  error?: string;
}> {
  log.call("get_repo_structure", args);

  const basePath = args.path || process.cwd();
  const maxFiles = args.max_files || 500;

  if (!existsSync(basePath)) {
    const error = `Path not found: ${basePath}`;
    log.error("get_repo_structure", error);
    return { success: false, error };
  }

  try {
    const gitignorePatterns = loadGitignore(basePath);
    const ignorePatterns = [
      ...DEFAULT_IGNORES,
      ...gitignorePatterns,
      ...(args.ignore || []),
    ];

    const files = collectFiles(basePath, basePath, ignorePatterns, maxFiles);
    const tree = generateTree(files, basePath);

    log.success("get_repo_structure", `Generated tree with ${files.length} files`);
    return {
      success: true,
      tree,
      file_count: files.length,
    };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("get_repo_structure", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Estimate token count for content or files
 * @param args.content - Direct content to estimate
 * @param args.files - Files to estimate tokens for
 * @param args.path - Base path for relative file paths
 */
export async function estimate_tokens(args: {
  content?: string;
  files?: string[];
  path?: string;
}): Promise<{
  success: boolean;
  total_tokens?: number;
  breakdown?: { file: string; tokens: number }[];
  error?: string;
}> {
  log.call("estimate_tokens", args);

  try {
    if (args.content) {
      const tokens = estimateTokens(args.content);
      log.success("estimate_tokens", `~${tokens} tokens`);
      return { success: true, total_tokens: tokens };
    }

    if (args.files && args.files.length > 0) {
      const basePath = args.path || process.cwd();
      const breakdown: { file: string; tokens: number }[] = [];
      let total = 0;

      for (const file of args.files) {
        const fullPath = file.startsWith("/") ? file : join(basePath, file);
        if (existsSync(fullPath)) {
          const content = readFileSync(fullPath, "utf-8");
          const tokens = estimateTokens(content);
          breakdown.push({ file, tokens });
          total += tokens;
        }
      }

      log.success("estimate_tokens", `~${total} tokens across ${breakdown.length} files`);
      return { success: true, total_tokens: total, breakdown };
    }

    return { success: false, error: "Either content or files must be provided" };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("estimate_tokens", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * List files in a repository with filtering
 * @param args.path - Path to repository or directory (defaults to current directory)
 * @param args.glob - Glob pattern to filter files
 * @param args.max_files - Maximum number of files to return (default: 100)
 * @param args.ignore - Additional patterns to ignore
 * @param args.include_size - Include file sizes in output
 */
export async function list_files(args: {
  path?: string;
  glob?: string;
  max_files?: number;
  ignore?: string[];
  include_size?: boolean;
}): Promise<{
  success: boolean;
  files?: { path: string; size?: number; language?: string }[];
  total_count?: number;
  error?: string;
}> {
  log.call("list_files", args);

  const basePath = args.path || process.cwd();
  const maxFiles = args.max_files || 100;

  if (!existsSync(basePath)) {
    const error = `Path not found: ${basePath}`;
    log.error("list_files", error);
    return { success: false, error };
  }

  try {
    let filePaths: string[];

    if (args.glob) {
      const result = await $`cd ${basePath} && find . -type f -name "${args.glob}" 2>/dev/null | head -${maxFiles}`.text();
      filePaths = result
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((f) => join(basePath, f.replace(/^\.\//, "")));
    } else {
      const gitignorePatterns = loadGitignore(basePath);
      const ignorePatterns = [
        ...DEFAULT_IGNORES,
        ...gitignorePatterns,
        ...(args.ignore || []),
      ];
      filePaths = collectFiles(basePath, basePath, ignorePatterns, maxFiles);
    }

    const files = filePaths.map((f) => {
      const relativePath = relative(basePath, f);
      const result: { path: string; size?: number; language?: string } = {
        path: relativePath,
        language: getLanguage(f),
      };

      if (args.include_size) {
        try {
          result.size = statSync(f).size;
        } catch {
          // Skip files we can't stat
        }
      }

      return result;
    });

    log.success("list_files", `Found ${files.length} files`);
    return {
      success: true,
      files,
      total_count: files.length,
    };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("list_files", errorMsg);
    return { success: false, error: errorMsg };
  }
}

// ============================================================================
// Advanced Optimization Functions (Council-inspired)
// ============================================================================

/**
 * Provider-specific format presets for optimal LLM consumption
 */
const PROVIDER_PRESETS: Record<string, {
  format: "xml" | "markdown";
  compactTags: boolean;
  maxLineLength: number | null;
  includeMetadata: boolean;
  wrapInstructions: boolean;
}> = {
  anthropic: {
    format: "xml",
    compactTags: false,
    maxLineLength: null,
    includeMetadata: true,
    wrapInstructions: true,
  },
  openai: {
    format: "markdown",
    compactTags: true,
    maxLineLength: 120,
    includeMetadata: false,
    wrapInstructions: false,
  },
  gemini: {
    format: "xml",
    compactTags: false,
    maxLineLength: null,
    includeMetadata: true,
    wrapInstructions: true,
  },
  default: {
    format: "xml",
    compactTags: false,
    maxLineLength: null,
    includeMetadata: true,
    wrapInstructions: true,
  },
};

/**
 * File importance weights for relevance scoring
 */
const FILE_IMPORTANCE: Record<string, number> = {
  "readme.md": 100,
  "readme": 100,
  "package.json": 90,
  "requirements.txt": 90,
  "cargo.toml": 90,
  "go.mod": 90,
  "pyproject.toml": 90,
  "tsconfig.json": 80,
  "config": 70,
  ".env.example": 60,
};

/**
 * Calculate relevance score for a file
 */
function calculateRelevance(
  filePath: string,
  basePath: string,
  query?: string,
  seedFiles?: Set<string>
): { score: number; reasons: string[] } {
  const fullPath = join(basePath, filePath);
  const name = basename(filePath).toLowerCase();
  const ext = extname(filePath).toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  try {
    const stats = statSync(fullPath);

    // 1. Recency bonus
    const hoursSinceMod = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
    if (hoursSinceMod < 24) {
      score += 50;
      reasons.push("modified in last 24h (+50)");
    } else if (hoursSinceMod < 168) {
      score += 20;
      reasons.push("modified in last week (+20)");
    }

    // 2. File size penalty for very large files
    const sizeKB = stats.size / 1024;
    if (sizeKB > 100) {
      score -= 10;
      reasons.push("large file (-10)");
    }
  } catch {
    // Can't stat file, continue with other scoring
  }

  // 3. File type importance
  for (const [pattern, importance] of Object.entries(FILE_IMPORTANCE)) {
    if (name === pattern || name.includes(pattern)) {
      score += importance;
      reasons.push(`important file: ${pattern} (+${importance})`);
      break;
    }
  }

  // 4. Source code bonus
  if ([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java"].includes(ext)) {
    score += 40;
    reasons.push("source code (+40)");
  } else if ([".md", ".txt"].includes(ext)) {
    score += 20;
    reasons.push("documentation (+20)");
  }

  // 5. Test file penalty
  if (name.includes("test") || name.includes("spec") || filePath.includes("__tests__")) {
    score -= 30;
    reasons.push("test file (-30)");
  }

  // 6. Seed file proximity bonus
  if (seedFiles && seedFiles.size > 0) {
    if (seedFiles.has(filePath)) {
      score += 100;
      reasons.push("seed file (+100)");
    } else {
      // Check if in same directory as a seed file
      const fileDir = dirname(filePath);
      for (const seed of seedFiles) {
        if (dirname(seed) === fileDir) {
          score += 30;
          reasons.push("near seed file (+30)");
          break;
        }
      }
    }
  }

  // 7. Query match bonus (simple TF-IDF approximation)
  if (query) {
    const queryTerms = query.toLowerCase().split(/\s+/);
    const pathLower = filePath.toLowerCase();
    for (const term of queryTerms) {
      if (pathLower.includes(term)) {
        score += 25;
        reasons.push(`matches query "${term}" (+25)`);
      }
    }
  }

  return { score, reasons };
}

/**
 * Find related files by scanning imports/dependencies
 */
function findRelatedFiles(
  content: string,
  filePath: string,
  basePath: string
): string[] {
  const dir = dirname(filePath);
  const ext = extname(filePath);
  const related: string[] = [];

  // Import patterns for various languages
  const importPatterns = [
    /from\s+['"](\.[^'"]+)['"]/g,           // JS/TS/Py: from "./local"
    /import\s+['"](\.[^'"]+)['"]/g,         // JS/TS/Go: import "./local"
    /import\s*\(\s*['"](\.[^'"]+)['"]\)/g,  // JS/TS dynamic: import("./local")
    /require\s*\(\s*['"](\.[^'"]+)['"]\)/g, // JS/TS: require("./local")
    /from\s+(\.[^\s]+)\s+import/g,          // Python: from .local import
  ];

  for (const pattern of importPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const importPath = match[1];
      const absolutePath = join(basePath, dir, importPath);

      // Check for exact match or common extensions
      const candidates = [
        absolutePath,
        absolutePath + ext,
        absolutePath + ".ts",
        absolutePath + ".tsx",
        absolutePath + ".js",
        absolutePath + ".jsx",
        absolutePath + ".py",
        join(absolutePath, "index" + ext),
        join(absolutePath, "index.ts"),
        join(absolutePath, "index.js"),
      ];

      for (const cand of candidates) {
        if (existsSync(cand) && statSync(cand).isFile()) {
          const relativeCand = relative(basePath, cand);
          if (!related.includes(relativeCand)) {
            related.push(relativeCand);
          }
          break;
        }
      }
    }
  }

  return related;
}

/**
 * Strip comments and normalize whitespace
 */
function compressContent(
  content: string,
  language: string,
  opts: {
    stripComments?: boolean;
    normalizeWhitespace?: boolean;
    keepDocstrings?: boolean;
  } = {}
): { content: string; savings: number } {
  const original = content.length;
  let result = content;

  if (opts.stripComments !== false) {
    // Languages with C-style comments
    if (["typescript", "javascript", "java", "c", "cpp", "csharp", "go", "rust"].includes(language)) {
      // Block comments /* ... */
      result = result.replace(/\/\*[\s\S]*?\*\//g, "");
      // Line comments // ... (but not URLs)
      if (!opts.keepDocstrings) {
        result = result.replace(/^\s*\/\/[^/\n][^\n]*$/gm, "");
      }
    }
    // Python/Ruby/Shell comments
    else if (["python", "ruby", "bash", "shell", "yaml", "toml"].includes(language)) {
      // Hash comments # ... (but not shebangs)
      result = result.replace(/^(\s*)#(?!!)[^\n]*$/gm, "");
      // Python docstrings (triple quotes) - optionally keep
      if (!opts.keepDocstrings) {
        result = result.replace(/"""[\s\S]*?"""/g, "");
        result = result.replace(/'''[\s\S]*?'''/g, "");
      }
    }
    // HTML/XML comments
    else if (["html", "xml", "vue", "svelte"].includes(language)) {
      result = result.replace(/<!--[\s\S]*?-->/g, "");
    }
  }

  if (opts.normalizeWhitespace !== false) {
    // Collapse multiple blank lines to max 2
    result = result.replace(/\n{3,}/g, "\n\n");
    // Remove trailing whitespace
    result = result.replace(/[ \t]+$/gm, "");
    // Remove leading blank lines
    result = result.replace(/^\n+/, "");
  }

  const compressed = result.trim();
  const savings = Math.round((1 - compressed.length / original) * 100);

  return { content: compressed, savings };
}

// ============================================================================
// New Exported Tool Functions
// ============================================================================

/**
 * Score and rank files by relevance for LLM context
 * @param args.path - Path to repository
 * @param args.query - Natural language query to match against
 * @param args.seed_files - Starting files to prioritize proximity to
 * @param args.max_files - Maximum files to return (default: 50)
 */
export async function score_files(args: {
  path?: string;
  query?: string;
  seed_files?: string[];
  max_files?: number;
}): Promise<{
  success: boolean;
  files?: Array<{ path: string; score: number; reasons: string[] }>;
  error?: string;
}> {
  log.call("score_files", args);

  const basePath = args.path || process.cwd();
  const maxFiles = args.max_files || 50;
  const seedFiles = new Set(args.seed_files || []);

  if (!existsSync(basePath)) {
    return { success: false, error: `Path not found: ${basePath}` };
  }

  try {
    const gitignorePatterns = loadGitignore(basePath);
    const ignorePatterns = [...DEFAULT_IGNORES, ...gitignorePatterns];
    const filePaths = collectFiles(basePath, basePath, ignorePatterns, 500);

    const scored = filePaths.map((f) => {
      const relativePath = relative(basePath, f);
      const { score, reasons } = calculateRelevance(relativePath, basePath, args.query, seedFiles);
      return { path: relativePath, score, reasons };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    log.success("score_files", `Scored ${scored.length} files`);
    return {
      success: true,
      files: scored.slice(0, maxFiles),
    };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("score_files", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Expand seed files to include their dependencies
 * @param args.path - Path to repository
 * @param args.seed_files - Starting files to expand from
 * @param args.depth - How many levels of dependencies to follow (default: 2)
 */
export async function expand_dependencies(args: {
  path?: string;
  seed_files: string[];
  depth?: number;
}): Promise<{
  success: boolean;
  files?: string[];
  dependency_map?: Record<string, string[]>;
  error?: string;
}> {
  log.call("expand_dependencies", args);

  const basePath = args.path || process.cwd();
  const depth = args.depth || 2;
  const seedFiles = args.seed_files;

  if (!seedFiles || seedFiles.length === 0) {
    return { success: false, error: "seed_files is required" };
  }

  try {
    const allFiles = new Set<string>(seedFiles);
    const dependencyMap: Record<string, string[]> = {};
    let currentLevel = [...seedFiles];

    for (let d = 0; d < depth; d++) {
      const nextLevel: string[] = [];

      for (const file of currentLevel) {
        const fullPath = join(basePath, file);
        if (!existsSync(fullPath)) continue;

        try {
          const content = readFileSync(fullPath, "utf-8");
          const related = findRelatedFiles(content, file, basePath);
          dependencyMap[file] = related;

          for (const rel of related) {
            if (!allFiles.has(rel)) {
              allFiles.add(rel);
              nextLevel.push(rel);
            }
          }
        } catch {
          // Skip files we can't read
        }
      }

      currentLevel = nextLevel;
      if (currentLevel.length === 0) break;
    }

    log.success("expand_dependencies", `Expanded to ${allFiles.size} files`);
    return {
      success: true,
      files: Array.from(allFiles),
      dependency_map: dependencyMap,
    };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("expand_dependencies", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Compress file content by stripping comments and normalizing whitespace
 * @param args.content - Direct content to compress
 * @param args.file - File path to read and compress
 * @param args.path - Base path for relative file
 * @param args.keep_docstrings - Keep docstrings/JSDoc (default: true)
 */
export async function compress_content(args: {
  content?: string;
  file?: string;
  path?: string;
  keep_docstrings?: boolean;
}): Promise<{
  success: boolean;
  content?: string;
  original_tokens?: number;
  compressed_tokens?: number;
  savings_percent?: number;
  error?: string;
}> {
  log.call("compress_content", args);

  try {
    let content: string;
    let language: string;

    if (args.content) {
      content = args.content;
      language = "text";
    } else if (args.file) {
      const basePath = args.path || process.cwd();
      const fullPath = args.file.startsWith("/") ? args.file : join(basePath, args.file);
      if (!existsSync(fullPath)) {
        return { success: false, error: `File not found: ${fullPath}` };
      }
      content = readFileSync(fullPath, "utf-8");
      language = getLanguage(fullPath);
    } else {
      return { success: false, error: "Either content or file is required" };
    }

    const originalTokens = estimateTokens(content);
    const { content: compressed, savings } = compressContent(content, language, {
      keepDocstrings: args.keep_docstrings !== false,
    });
    const compressedTokens = estimateTokens(compressed);

    log.success("compress_content", `Saved ${savings}% tokens`);
    return {
      success: true,
      content: compressed,
      original_tokens: originalTokens,
      compressed_tokens: compressedTokens,
      savings_percent: savings,
    };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("compress_content", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Analyze repository to get stats and recommendations
 * @param args.path - Path to repository
 */
export async function analyze_repo(args: {
  path?: string;
}): Promise<{
  success: boolean;
  total_files?: number;
  total_tokens?: number;
  by_language?: Record<string, { files: number; tokens: number }>;
  largest_files?: Array<{ path: string; tokens: number; language: string }>;
  recommended_budget?: number;
  error?: string;
}> {
  log.call("analyze_repo", args);

  const basePath = args.path || process.cwd();

  if (!existsSync(basePath)) {
    return { success: false, error: `Path not found: ${basePath}` };
  }

  try {
    const gitignorePatterns = loadGitignore(basePath);
    const ignorePatterns = [...DEFAULT_IGNORES, ...gitignorePatterns];
    const filePaths = collectFiles(basePath, basePath, ignorePatterns, 1000);

    const byLanguage: Record<string, { files: number; tokens: number }> = {};
    const fileStats: Array<{ path: string; tokens: number; language: string }> = [];
    let totalTokens = 0;

    for (const filePath of filePaths) {
      try {
        const content = readFileSync(filePath, "utf-8");
        const tokens = estimateTokens(content);
        const language = getLanguage(filePath);
        const relativePath = relative(basePath, filePath);

        totalTokens += tokens;
        fileStats.push({ path: relativePath, tokens, language });

        if (!byLanguage[language]) {
          byLanguage[language] = { files: 0, tokens: 0 };
        }
        byLanguage[language].files++;
        byLanguage[language].tokens += tokens;
      } catch {
        // Skip unreadable files
      }
    }

    // Sort by tokens descending
    fileStats.sort((a, b) => b.tokens - a.tokens);

    // Calculate recommended budget (cover top 80% of important files)
    const sourceTokens = Object.entries(byLanguage)
      .filter(([lang]) => ["typescript", "javascript", "python", "go", "rust", "java"].includes(lang))
      .reduce((sum, [, stats]) => sum + stats.tokens, 0);

    const recommendedBudget = Math.min(
      Math.ceil(sourceTokens * 0.3), // 30% of source code
      100000 // Cap at 100k
    );

    log.success("analyze_repo", `Analyzed ${filePaths.length} files, ~${totalTokens} total tokens`);
    return {
      success: true,
      total_files: filePaths.length,
      total_tokens: totalTokens,
      by_language: byLanguage,
      largest_files: fileStats.slice(0, 20),
      recommended_budget: recommendedBudget,
    };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("analyze_repo", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Smart pack with budget allocation, relevance scoring, and compression
 * @param args.path - Path to repository
 * @param args.budget_tokens - Token budget (default: 50000)
 * @param args.query - Natural language query for relevance scoring
 * @param args.seed_files - Starting files to prioritize and expand
 * @param args.auto_deps - Auto-include dependencies (default: true)
 * @param args.compress - Strip comments/whitespace (default: true)
 * @param args.provider - LLM provider preset: anthropic, openai, gemini
 * @param args.instruction - Instruction to include in prompt
 */
export async function smart_pack(args: {
  path?: string;
  budget_tokens?: number;
  query?: string;
  seed_files?: string[];
  auto_deps?: boolean;
  compress?: boolean;
  provider?: "anthropic" | "openai" | "gemini";
  instruction?: string;
}): Promise<{
  success: boolean;
  output?: string;
  included_files?: Array<{ path: string; tokens: number; mode: "full" | "codemap" }>;
  excluded_files?: string[];
  total_tokens?: number;
  budget_tokens?: number;
  utilization_percent?: number;
  error?: string;
}> {
  log.call("smart_pack", args);

  const basePath = args.path || process.cwd();
  const budgetTokens = args.budget_tokens || 50000;
  const autoDeps = args.auto_deps !== false;
  const compress = args.compress !== false;
  const provider = args.provider || "default";
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.default;

  if (!existsSync(basePath)) {
    return { success: false, error: `Path not found: ${basePath}` };
  }

  try {
    // 1. Collect initial files
    let filePaths: string[];
    const seedFiles = new Set(args.seed_files || []);

    if (seedFiles.size > 0) {
      filePaths = Array.from(seedFiles);

      // 2. Expand dependencies if enabled
      if (autoDeps) {
        const expanded = await expand_dependencies({
          path: basePath,
          seed_files: Array.from(seedFiles),
          depth: 2,
        });
        if (expanded.success && expanded.files) {
          filePaths = expanded.files;
        }
      }
    } else {
      // No seeds - use all files
      const gitignorePatterns = loadGitignore(basePath);
      const ignorePatterns = [...DEFAULT_IGNORES, ...gitignorePatterns];
      const collected = collectFiles(basePath, basePath, ignorePatterns, 500);
      filePaths = collected.map((f) => relative(basePath, f));
    }

    // 3. Score and sort files
    const scored = filePaths.map((f) => {
      const { score } = calculateRelevance(f, basePath, args.query, seedFiles);
      return { path: f, score };
    });
    scored.sort((a, b) => b.score - a.score);

    // 4. Budget allocation with greedy packing
    let usedTokens = 0;
    const includedFiles: Array<{ path: string; tokens: number; mode: "full" | "codemap" }> = [];
    const excludedFiles: string[] = [];
    const packedFiles: Array<{ path: string; content: string; isCodemap?: boolean }> = [];

    for (const { path: filePath } of scored) {
      const fullPath = join(basePath, filePath);
      if (!existsSync(fullPath)) continue;

      try {
        let content = readFileSync(fullPath, "utf-8");
        const language = getLanguage(filePath);

        // Apply compression if enabled
        if (compress) {
          const { content: compressed } = compressContent(content, language, {
            keepDocstrings: true,
          });
          content = compressed;
        }

        const fileTokens = estimateTokens(content);

        // Try full content first
        if (usedTokens + fileTokens <= budgetTokens) {
          packedFiles.push({ path: filePath, content });
          includedFiles.push({ path: filePath, tokens: fileTokens, mode: "full" });
          usedTokens += fileTokens;
        } else {
          // Try codemap fallback
          const signatures = extractSignatures(content, language);
          const cmTokens = estimateTokens(signatures);

          if (signatures && cmTokens > 10 && usedTokens + cmTokens <= budgetTokens) {
            packedFiles.push({ path: filePath, content: signatures, isCodemap: true });
            includedFiles.push({ path: filePath, tokens: cmTokens, mode: "codemap" });
            usedTokens += cmTokens;
          } else {
            excludedFiles.push(filePath);
          }
        }
      } catch {
        excludedFiles.push(filePath);
      }
    }

    // 5. Format output based on provider preset
    const output = preset.format === "xml"
      ? formatAsXml(packedFiles, args.instruction)
      : formatAsMarkdown(packedFiles, args.instruction);

    const utilizationPercent = Math.round((usedTokens / budgetTokens) * 100);

    log.success("smart_pack", `Packed ${includedFiles.length} files, ${usedTokens}/${budgetTokens} tokens (${utilizationPercent}%)`);
    return {
      success: true,
      output,
      included_files: includedFiles,
      excluded_files: excludedFiles,
      total_tokens: usedTokens,
      budget_tokens: budgetTokens,
      utilization_percent: utilizationPercent,
    };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("smart_pack", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Get provider-specific format recommendations
 * @param args.provider - LLM provider: anthropic, openai, gemini
 */
export async function get_provider_preset(args: {
  provider: "anthropic" | "openai" | "gemini";
}): Promise<{
  success: boolean;
  preset?: typeof PROVIDER_PRESETS.default;
  tips?: string[];
  error?: string;
}> {
  log.call("get_provider_preset", args);

  const preset = PROVIDER_PRESETS[args.provider];
  if (!preset) {
    return { success: false, error: `Unknown provider: ${args.provider}` };
  }

  const tips: string[] = [];
  if (args.provider === "anthropic") {
    tips.push("Use XML format - Claude parses XML tags very reliably");
    tips.push("Include <instruction> tags for clear task separation");
    tips.push("Avoid deeply nested XML (keep to 2-3 levels)");
  } else if (args.provider === "openai") {
    tips.push("Markdown format often works better for GPT models");
    tips.push("Keep line lengths reasonable (~120 chars)");
    tips.push("Use code fences with language hints");
  } else if (args.provider === "gemini") {
    tips.push("Gemini handles both XML and Markdown well");
    tips.push("Include metadata - Gemini uses it for context");
    tips.push("Leverage the large context window (1M tokens)");
  }

  return { success: true, preset, tips };
}
