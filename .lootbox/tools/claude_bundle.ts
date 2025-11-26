/**
 * Claude Bundle Tool - Bundles CLAUDE.md and all @imports into a single gist
 *
 * Parses CLAUDE.md files for @filepath imports, recursively resolves them,
 * and creates a single bundled markdown file as a GitHub gist.
 * Also includes all skill files from ~/.claude/skills/
 */

import { $ } from "bun";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createLogger, extractErrorMessage } from "./shared/index.ts";

const log = createLogger("claude_bundle");

// Max recursion depth for imports (matching Claude Code's limit)
const MAX_DEPTH = 5;

// Regex to match @filepath imports (handles ~ for home, ./ for relative, and absolute paths)
const IMPORT_REGEX = /^@(~\/[^\s]+|\.\/[^\s]+|\/[^\s]+)$/gm;

// Default skills directory
const SKILLS_DIR = join(process.env.HOME || "", ".claude", "skills");

/**
 * Resolve a filepath, expanding ~ to home directory
 */
function resolvePath(filepath: string, baseDir: string): string {
  if (filepath.startsWith("~/")) {
    return join(process.env.HOME || "", filepath.slice(2));
  }
  if (filepath.startsWith("./") || !filepath.startsWith("/")) {
    return resolve(baseDir, filepath);
  }
  return filepath;
}

/**
 * Parse a file for @imports and return the list of imported paths
 */
function parseImports(content: string): string[] {
  const imports: string[] = [];
  const matches = content.matchAll(IMPORT_REGEX);
  for (const match of matches) {
    imports.push(match[1]);
  }
  return imports;
}

/**
 * Discover all skill.md files in the skills directory
 */
function discoverSkillFiles(skillsDir: string = SKILLS_DIR): string[] {
  const skillFiles: string[] = [];

  if (!existsSync(skillsDir)) {
    log.info(`Skills directory not found: ${skillsDir}`);
    return skillFiles;
  }

  try {
    const entries = readdirSync(skillsDir);
    for (const entry of entries) {
      const entryPath = join(skillsDir, entry);
      if (statSync(entryPath).isDirectory()) {
        const skillFile = join(entryPath, "skill.md");
        if (existsSync(skillFile)) {
          skillFiles.push(skillFile);
        }
      }
    }
  } catch (error) {
    log.error("discoverSkillFiles", extractErrorMessage(error));
  }

  return skillFiles;
}

/**
 * Recursively resolve all imports from a file
 */
function resolveImportsRecursively(
  filepath: string,
  depth: number = 0,
  visited: Set<string> = new Set()
): { path: string; content: string }[] {
  if (depth > MAX_DEPTH) {
    log.warn(`Max import depth (${MAX_DEPTH}) reached at: ${filepath}`);
    return [];
  }

  const resolvedPath = resolvePath(filepath, dirname(filepath));

  if (visited.has(resolvedPath)) {
    log.info(`Skipping already visited: ${resolvedPath}`);
    return [];
  }

  visited.add(resolvedPath);

  if (!existsSync(resolvedPath)) {
    log.warn(`File not found: ${resolvedPath}`);
    return [];
  }

  try {
    const content = readFileSync(resolvedPath, "utf-8");
    const results: { path: string; content: string }[] = [{ path: resolvedPath, content }];

    const imports = parseImports(content);
    const baseDir = dirname(resolvedPath);

    for (const importPath of imports) {
      const fullPath = resolvePath(importPath, baseDir);
      const nested = resolveImportsRecursively(fullPath, depth + 1, visited);
      results.push(...nested);
    }

    return results;
  } catch (error) {
    log.error("resolveImportsRecursively", extractErrorMessage(error));
    return [];
  }
}

/**
 * Build a file tree structure from paths
 */
function buildFileTree(
  files: { path: string; content: string }[],
  pathToAnchor: Map<string, string>
): string {
  const home = process.env.HOME || "";

  // Group files by directory structure
  interface TreeNode {
    name: string;
    children: Map<string, TreeNode>;
    files: { name: string; anchor: string }[];
  }

  const root: TreeNode = { name: "", children: new Map(), files: [] };

  for (const file of files) {
    const displayPath = file.path.replace(home, "~");
    const parts = displayPath.split("/").filter(Boolean);
    const fileName = parts.pop() || "";

    let current = root;
    for (const part of parts) {
      if (!current.children.has(part)) {
        current.children.set(part, { name: part, children: new Map(), files: [] });
      }
      current = current.children.get(part)!;
    }

    const anchor = pathToAnchor.get(file.path) || "";
    current.files.push({ name: fileName, anchor });
  }

  // Render tree as markdown
  const lines: string[] = [];

  function renderNode(node: TreeNode, indent: string, isRoot: boolean = false): void {
    // Sort children and files
    const sortedChildren = Array.from(node.children.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    );
    const sortedFiles = node.files.sort((a, b) => a.name.localeCompare(b.name));

    for (const [name, child] of sortedChildren) {
      lines.push(`${indent}- **${name}/**`);
      renderNode(child, indent + "  ");
    }

    for (const file of sortedFiles) {
      lines.push(`${indent}- [${file.name}](#${file.anchor})`);
    }
  }

  // Start from ~ level
  const claudeDir = root.children.get("~")?.children.get(".claude");
  if (claudeDir) {
    lines.push("```");
    lines.push("~/.claude/");
    lines.push("```");
    lines.push("");

    // Render main files first (non-skill files)
    const mainFiles = claudeDir.files;
    if (mainFiles.length > 0) {
      for (const file of mainFiles.sort((a, b) => a.name.localeCompare(b.name))) {
        lines.push(`- [${file.name}](#${file.anchor})`);
      }
    }

    // Render skills directory
    const skillsDir = claudeDir.children.get("skills");
    if (skillsDir) {
      lines.push("");
      lines.push("**skills/**");
      const sortedSkills = Array.from(skillsDir.children.entries()).sort((a, b) =>
        a[0].localeCompare(b[0])
      );
      for (const [skillName, skillNode] of sortedSkills) {
        const skillFile = skillNode.files.find(f => f.name === "skill.md");
        if (skillFile) {
          lines.push(`- [${skillName}](#${skillFile.anchor})`);
        }
      }
    }
  }

  return lines.join("\n");
}

/**
 * Create a bundled markdown from all resolved files
 */
function createBundle(files: { path: string; content: string }[]): string {
  const lines: string[] = [];
  const home = process.env.HOME || "";

  // Create simple anchors and map paths to them
  const pathToAnchor = new Map<string, string>();
  files.forEach((file, index) => {
    const parts = file.path.replace(home, "").split("/").filter(Boolean);
    const fileName = parts.pop() || `file-${index}`;
    const baseName = fileName.replace(/\.md$/, "").replace(/[^a-zA-Z0-9-]/g, "-");

    // For skill.md files, use the skill directory name as the anchor
    let anchor: string;
    if (baseName === "skill" && parts.length >= 1) {
      const skillName = parts[parts.length - 1];
      anchor = skillName;
    } else {
      anchor = baseName;
    }

    // Handle duplicates by adding parent dir or index
    const existing = Array.from(pathToAnchor.values());
    if (existing.includes(anchor)) {
      if (parts.length >= 1) {
        anchor = `${parts[parts.length - 1]}-${anchor}`;
      }
      // If still duplicate, add index
      if (existing.includes(anchor)) {
        anchor = `${anchor}-${index}`;
      }
    }
    pathToAnchor.set(file.path, anchor);
  });

  lines.push("# Bundled CLAUDE.md");
  lines.push("");
  lines.push(`> Generated on ${new Date().toISOString()}`);
  lines.push(`> Contains ${files.length} file(s)`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // File tree TOC
  lines.push("## File Tree");
  lines.push("");
  lines.push(buildFileTree(files, pathToAnchor));
  lines.push("");
  lines.push("---");
  lines.push("");

  // File contents
  for (const file of files) {
    const displayPath = file.path.replace(home, "~");
    const anchor = pathToAnchor.get(file.path)!;

    // Use <a name="anchor"></a> for reliable linking
    lines.push(`<a name="${anchor}"></a>`);
    lines.push("");
    lines.push(`## ${displayPath}`);
    lines.push("");

    // Replace @imports with links to the section
    let processedContent = file.content;
    const imports = parseImports(file.content);
    for (const importPath of imports) {
      const fullPath = resolvePath(importPath, dirname(file.path));
      const importAnchor = pathToAnchor.get(fullPath);
      if (importAnchor) {
        const displayImportPath = fullPath.replace(home, "~");
        // Get just the filename for cleaner display
        const importFileName = displayImportPath.split("/").pop() || displayImportPath;
        processedContent = processedContent.replace(
          `@${importPath}`,
          `[→ ${importFileName}](#${importAnchor})`
        );
      }
    }

    lines.push(processedContent);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Bundle CLAUDE.md and all imports into a single markdown string
 * @param args.source_path - Path to the CLAUDE.md file (defaults to ~/.claude/CLAUDE.md)
 * @param args.include_skills - Whether to include skill files (default: true)
 */
export async function bundle_claude_md(args: {
  source_path?: string;
  include_skills?: boolean;
}): Promise<{ success: boolean; bundle?: string; file_count?: number; error?: string }> {
  log.call("bundle_claude_md", args);

  const sourcePath = args.source_path || "~/.claude/CLAUDE.md";
  const resolvedSource = resolvePath(sourcePath, process.cwd());
  const includeSkills = args.include_skills !== false; // default true

  if (!existsSync(resolvedSource)) {
    const error = `CLAUDE.md not found at: ${resolvedSource}`;
    log.error("bundle_claude_md", error);
    return { success: false, error };
  }

  try {
    // Track all visited files across all resolution chains
    const visited = new Set<string>();

    // Resolve CLAUDE.md and its imports
    const files = resolveImportsRecursively(resolvedSource, 0, visited);

    // Also include skill files and their imports
    if (includeSkills) {
      const skillFiles = discoverSkillFiles();
      log.info(`Found ${skillFiles.length} skill files`);

      for (const skillFile of skillFiles) {
        const skillImports = resolveImportsRecursively(skillFile, 0, visited);
        files.push(...skillImports);
      }
    }

    if (files.length === 0) {
      return { success: false, error: "No files resolved" };
    }

    const bundle = createBundle(files);

    log.success("bundle_claude_md", `Bundled ${files.length} files`);
    return {
      success: true,
      bundle,
      file_count: files.length
    };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("bundle_claude_md", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Bundle CLAUDE.md and create a GitHub gist
 * @param args.source_path - Path to the CLAUDE.md file (defaults to ~/.claude/CLAUDE.md)
 * @param args.public - Whether the gist should be public (default: false)
 * @param args.description - Description for the gist
 * @param args.include_skills - Whether to include skill files (default: true)
 */
export async function create_claude_gist(args: {
  source_path?: string;
  public?: boolean;
  description?: string;
  include_skills?: boolean;
}): Promise<{ success: boolean; gist_url?: string; file_count?: number; error?: string }> {
  log.call("create_claude_gist", args);

  const bundleResult = await bundle_claude_md({
    source_path: args.source_path,
    include_skills: args.include_skills
  });

  if (!bundleResult.success || !bundleResult.bundle) {
    return { success: false, error: bundleResult.error || "Failed to create bundle" };
  }

  try {
    // Write bundle to temp file
    const tempFile = `/tmp/claude-bundle-${Date.now()}.md`;
    await Bun.write(tempFile, bundleResult.bundle);

    // Create gist using gh CLI
    const visibility = args.public ? "--public" : "";
    const description = args.description || "Bundled CLAUDE.md with all imports";

    const result = await $`gh gist create ${tempFile} --filename "CLAUDE-bundle.md" ${visibility} --desc ${description}`.text();

    // Extract gist URL from output
    const gistUrl = result.trim();

    // Clean up temp file
    await $`rm ${tempFile}`.quiet();

    log.success("create_claude_gist", gistUrl);
    return {
      success: true,
      gist_url: gistUrl,
      file_count: bundleResult.file_count
    };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("create_claude_gist", errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * List all files that would be included in the bundle (dry run)
 * @param args.source_path - Path to the CLAUDE.md file (defaults to ~/.claude/CLAUDE.md)
 * @param args.include_skills - Whether to include skill files (default: true)
 */
export async function list_claude_imports(args: {
  source_path?: string;
  include_skills?: boolean;
}): Promise<{ success: boolean; files?: string[]; error?: string }> {
  log.call("list_claude_imports", args);

  const sourcePath = args.source_path || "~/.claude/CLAUDE.md";
  const resolvedSource = resolvePath(sourcePath, process.cwd());
  const includeSkills = args.include_skills !== false; // default true

  if (!existsSync(resolvedSource)) {
    const error = `CLAUDE.md not found at: ${resolvedSource}`;
    log.error("list_claude_imports", error);
    return { success: false, error };
  }

  try {
    const visited = new Set<string>();
    const files = resolveImportsRecursively(resolvedSource, 0, visited);

    // Also include skill files and their imports
    if (includeSkills) {
      const skillFiles = discoverSkillFiles();
      for (const skillFile of skillFiles) {
        const skillImports = resolveImportsRecursively(skillFile, 0, visited);
        files.push(...skillImports);
      }
    }

    const filePaths = files.map(f => f.path.replace(process.env.HOME || "", "~"));

    log.success("list_claude_imports", `Found ${files.length} files`);
    return { success: true, files: filePaths };
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    log.error("list_claude_imports", errorMsg);
    return { success: false, error: errorMsg };
  }
}
