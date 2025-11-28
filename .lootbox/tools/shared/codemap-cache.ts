/**
 * Code Map Cache - Smart caching for codebase structure awareness
 *
 * Provides code map context to all thinking/research tools automatically.
 *
 * Conventions:
 * - Cache location: ~/.lootbox/cache/codemaps/
 * - Filename pattern: codemap-{sanitized-repo-name}-{path-hash}.json
 * - Invalidation: >3 days old AND new commits since cache creation
 *
 * Usage:
 * ```ts
 * import { getCodeMapContext } from './shared/codemap-cache';
 *
 * // In your tool function:
 * const codeMapContext = await getCodeMapContext();
 * if (codeMapContext) {
 *   prompt = `<codebase-structure>\n${codeMapContext}\n</codebase-structure>\n\n${prompt}`;
 * }
 * ```
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { $ } from "bun";
import { createLogger } from "./logging.ts";
import { getClientCwd } from "./client-context.ts";

const log = createLogger("codemap_cache");

// ============================================================================
// CONFIGURATION
// ============================================================================

/** Cache directory location */
const CACHE_DIR = join(process.env.HOME || "~", ".lootbox", "cache", "codemaps");

/** How long before checking for new commits (3 days in ms) */
const STALE_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;

/** Lock file timeout (2 minutes) */
const LOCK_TIMEOUT_MS = 2 * 60 * 1000;

/** Maximum codemap size to include in context (100KB) */
const MAX_CODEMAP_SIZE = 100 * 1024;

// ============================================================================
// TYPES
// ============================================================================

interface CodeMapCache {
  version: 1;
  repoPath: string;
  repoName: string;
  createdAt: string;        // ISO timestamp when map was generated
  lastValidatedAt: string;  // ISO timestamp when freshness was confirmed
  gitCommitHash: string;    // HEAD at generation time
  codemap: string;          // The actual code map content
}

interface CodeMapMetadata {
  repoPath: string;
  repoName: string;
  createdAt: Date;
  lastValidatedAt: Date;
  gitCommitHash: string;
  isStale: boolean;
  cacheFile: string;
}

// ============================================================================
// GIT UTILITIES
// ============================================================================

/**
 * Get the current HEAD commit hash
 */
async function getGitHead(repoPath: string): Promise<string | null> {
  try {
    const result = await $`cd ${repoPath} && git rev-parse HEAD 2>/dev/null`.text();
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get the repository root path
 */
async function getGitRoot(startPath: string): Promise<string | null> {
  try {
    const result = await $`cd ${startPath} && git rev-parse --show-toplevel 2>/dev/null`.text();
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get repository name from git remote or folder name
 */
async function getRepoName(repoPath: string): Promise<string> {
  try {
    // Try to get name from remote origin
    const remote = await $`cd ${repoPath} && git remote get-url origin 2>/dev/null`.text();
    const trimmed = remote.trim();
    if (trimmed) {
      // Extract repo name from URL (github.com/user/repo.git -> repo)
      const match = trimmed.match(/\/([^/]+?)(?:\.git)?$/);
      if (match) return match[1];
    }
  } catch {
    // Fall back to directory name
  }
  return basename(repoPath);
}

/**
 * Count commits since a specific commit hash
 */
async function countCommitsSince(repoPath: string, sinceCommit: string): Promise<number> {
  try {
    const result = await $`cd ${repoPath} && git rev-list ${sinceCommit}..HEAD --count 2>/dev/null`.text();
    return parseInt(result.trim(), 10) || 0;
  } catch {
    // If the commit is not in history (shallow clone), return -1 to force regeneration
    return -1;
  }
}

// ============================================================================
// CACHE FILE UTILITIES
// ============================================================================

/**
 * Generate cache file path for a repository
 */
function getCacheFilePath(repoPath: string, repoName: string): string {
  // Sanitize repo name for filename
  const sanitizedName = repoName.replace(/[^a-zA-Z0-9-_]/g, "_").substring(0, 50);
  // Create path hash for uniqueness (handles same-named repos in different locations)
  const pathHash = createHash("md5").update(repoPath).digest("hex").substring(0, 8);
  return join(CACHE_DIR, `codemap-${sanitizedName}-${pathHash}.json`);
}

/**
 * Get lock file path for a cache file
 */
function getLockFilePath(cacheFilePath: string): string {
  return `${cacheFilePath}.lock`;
}

/**
 * Ensure cache directory exists
 */
function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    log.info(`Created cache directory: ${CACHE_DIR}`);
  }
}

/**
 * Acquire a lock for cache operations
 * Returns true if lock acquired, false if another process holds it
 */
function acquireLock(lockFile: string): boolean {
  try {
    // Ensure cache directory exists before trying to create lock
    ensureCacheDir();

    // Check if lock exists and is recent
    if (existsSync(lockFile)) {
      const lockStat = statSync(lockFile);
      const lockAge = Date.now() - lockStat.mtimeMs;
      if (lockAge < LOCK_TIMEOUT_MS) {
        // Lock is still valid, don't acquire
        log.info("Lock held by another process, skipping cache update");
        return false;
      }
      // Lock is stale, remove it
      unlinkSync(lockFile);
    }
    // Create lock file with PID and timestamp
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
    return true;
  } catch (error) {
    log.warn("Failed to acquire lock", error);
    return false;
  }
}

/**
 * Release a lock
 */
function releaseLock(lockFile: string): void {
  try {
    if (existsSync(lockFile)) {
      unlinkSync(lockFile);
    }
  } catch {
    // Ignore release errors
  }
}

/**
 * Read cache file
 */
function readCache(cacheFile: string): CodeMapCache | null {
  try {
    if (!existsSync(cacheFile)) {
      return null;
    }
    const content = readFileSync(cacheFile, "utf-8");
    const cache = JSON.parse(content) as CodeMapCache;
    // Validate cache structure
    if (cache.version !== 1 || !cache.codemap || !cache.gitCommitHash) {
      log.warn("Invalid cache structure, will regenerate");
      return null;
    }
    return cache;
  } catch (error) {
    log.warn("Failed to read cache", error);
    return null;
  }
}

/**
 * Write cache file atomically
 */
function writeCache(cacheFile: string, cache: CodeMapCache): void {
  ensureCacheDir();
  const tmpFile = `${cacheFile}.tmp.${process.pid}`;
  try {
    writeFileSync(tmpFile, JSON.stringify(cache, null, 2));
    // Atomic rename
    const fs = require("fs");
    fs.renameSync(tmpFile, cacheFile);
    log.info(`Cache written: ${cacheFile}`);
  } catch (error) {
    // Clean up temp file if rename failed
    try {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    } catch { /* ignore */ }
    throw error;
  }
}

/**
 * Update only the lastValidatedAt timestamp
 */
function touchCache(cacheFile: string, cache: CodeMapCache): void {
  cache.lastValidatedAt = new Date().toISOString();
  writeCache(cacheFile, cache);
}

// ============================================================================
// CODEMAP GENERATION
// ============================================================================

/**
 * Generate a code map for the repository
 * Uses the existing generate_codemap functionality from repo_prompt.ts
 */
async function generateCodeMap(repoPath: string): Promise<string> {
  log.info(`Generating code map for: ${repoPath}`);

  // Import and use the existing generate_codemap function
  const { generate_codemap } = await import("../repo_prompt.ts");

  const result = await generate_codemap({ path: repoPath });

  if (!result.success || !result.output) {
    throw new Error(result.error || "Failed to generate code map");
  }

  // If the output is too large, try to get just the structure
  if (result.output.length > MAX_CODEMAP_SIZE) {
    log.info("Code map too large, generating structure only");
    const { get_repo_structure } = await import("../repo_prompt.ts");
    const structResult = await get_repo_structure({ path: repoPath });
    if (structResult.success && structResult.tree) {
      return `Repository Structure:\n${structResult.tree}`;
    }
  }

  return result.output;
}

// ============================================================================
// MAIN API
// ============================================================================

/**
 * Get code map context for a repository
 *
 * This is the main function tools should call. It:
 * 1. Returns cached code map if fresh
 * 2. Validates cache if >3 days old (checks for new commits)
 * 3. Regenerates if stale or missing
 * 4. Saves to file automatically
 *
 * @param repoPath - Path to repository (defaults to cwd)
 * @param force - Force regeneration even if cache is valid
 * @returns Code map string or null if not a git repo
 */
export async function getCodeMapContext(
  repoPath?: string,
  force = false
): Promise<string | null> {
  // Use client cwd if available, otherwise fall back to process.cwd()
  const startPath = repoPath || getClientCwd();
  log.call("getCodeMapContext", { path: startPath, force });

  // Find git root
  const gitRoot = await getGitRoot(startPath);
  if (!gitRoot) {
    log.info("Not a git repository, skipping code map");
    return null;
  }

  const repoName = await getRepoName(gitRoot);
  const cacheFile = getCacheFilePath(gitRoot, repoName);
  const lockFile = getLockFilePath(cacheFile);

  // Try to read existing cache
  const cache = readCache(cacheFile);

  // Force regeneration requested
  if (force) {
    log.info("Force regeneration requested");
    return await regenerateAndCache(gitRoot, repoName, cacheFile, lockFile);
  }

  // No cache exists, generate fresh
  if (!cache) {
    log.info("No cache exists, generating fresh code map");
    return await regenerateAndCache(gitRoot, repoName, cacheFile, lockFile);
  }

  // Check cache freshness
  const lastValidatedAt = new Date(cache.lastValidatedAt).getTime();
  const ageMs = Date.now() - lastValidatedAt;

  // Fast path: cache is recent (< 3 days)
  if (ageMs < STALE_THRESHOLD_MS) {
    const ageHours = Math.round(ageMs / (1000 * 60 * 60));
    log.info(`Cache is fresh (${ageHours}h old), using cached`);
    log.info(`Cache file: ${cacheFile}`);
    log.info(`Cached codemap size: ${cache.codemap.length} chars`);
    return cache.codemap;
  }

  // Cache is old, check for new commits
  log.info("Cache is stale, checking for new commits...");
  const currentHead = await getGitHead(gitRoot);

  if (!currentHead) {
    // Can't get HEAD, trust the cache
    log.warn("Can't get current HEAD, using cached code map");
    return cache.codemap;
  }

  // Same commit, just update validation timestamp
  if (currentHead === cache.gitCommitHash) {
    log.info("No new commits since cache creation, refreshing validation timestamp");
    log.info(`Cached codemap size: ${cache.codemap.length} chars`);
    touchCache(cacheFile, cache);
    return cache.codemap;
  }

  // Check how many commits since cache was generated
  const commitCount = await countCommitsSince(gitRoot, cache.gitCommitHash);
  log.info(`${commitCount} new commits since cache creation`);

  if (commitCount === 0) {
    // Edge case: HEAD changed but no new commits (branch switch to same commit)
    touchCache(cacheFile, cache);
    return cache.codemap;
  }

  // New commits exist, regenerate
  log.info("New commits detected, regenerating code map");
  return await regenerateAndCache(gitRoot, repoName, cacheFile, lockFile);
}

/**
 * Regenerate code map and save to cache
 */
async function regenerateAndCache(
  repoPath: string,
  repoName: string,
  cacheFile: string,
  lockFile: string
): Promise<string | null> {
  // Try to acquire lock
  if (!acquireLock(lockFile)) {
    // Another process is generating, try to use existing cache
    const existingCache = readCache(cacheFile);
    if (existingCache) {
      log.info("Using existing cache while another process regenerates");
      return existingCache.codemap;
    }
    // No cache and can't acquire lock, wait briefly and retry
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const retryCache = readCache(cacheFile);
    return retryCache?.codemap || null;
  }

  try {
    const codemap = await generateCodeMap(repoPath);
    const currentHead = await getGitHead(repoPath);

    const cache: CodeMapCache = {
      version: 1,
      repoPath,
      repoName,
      createdAt: new Date().toISOString(),
      lastValidatedAt: new Date().toISOString(),
      gitCommitHash: currentHead || "unknown",
      codemap,
    };

    writeCache(cacheFile, cache);
    log.success("getCodeMapContext", `Generated and cached code map (${codemap.length} chars)`);
    return codemap;
  } catch (error) {
    log.error("getCodeMapContext", `Failed to generate code map: ${error}`);
    return null;
  } finally {
    releaseLock(lockFile);
  }
}

/**
 * Force invalidate the code map cache for a repository
 *
 * @param repoPath - Path to repository (defaults to cwd)
 */
export async function invalidateCodeMapCache(repoPath?: string): Promise<void> {
  const startPath = repoPath || getClientCwd();
  log.call("invalidateCodeMapCache", { path: startPath });

  const gitRoot = await getGitRoot(startPath);
  if (!gitRoot) {
    log.info("Not a git repository");
    return;
  }

  const repoName = await getRepoName(gitRoot);
  const cacheFile = getCacheFilePath(gitRoot, repoName);

  if (existsSync(cacheFile)) {
    unlinkSync(cacheFile);
    log.info(`Cache invalidated: ${cacheFile}`);
  } else {
    log.info("No cache file to invalidate");
  }
}

/**
 * Get metadata about the current code map cache without loading the full map
 *
 * @param repoPath - Path to repository (defaults to cwd)
 * @returns Cache metadata or null if not cached/not a git repo
 */
export async function getCodeMapMetadata(repoPath?: string): Promise<CodeMapMetadata | null> {
  const startPath = repoPath || getClientCwd();
  log.call("getCodeMapMetadata", { path: startPath });

  const gitRoot = await getGitRoot(startPath);
  if (!gitRoot) {
    return null;
  }

  const repoName = await getRepoName(gitRoot);
  const cacheFile = getCacheFilePath(gitRoot, repoName);
  const cache = readCache(cacheFile);

  if (!cache) {
    return null;
  }

  const lastValidatedAt = new Date(cache.lastValidatedAt);
  const ageMs = Date.now() - lastValidatedAt.getTime();

  return {
    repoPath: cache.repoPath,
    repoName: cache.repoName,
    createdAt: new Date(cache.createdAt),
    lastValidatedAt,
    gitCommitHash: cache.gitCommitHash,
    isStale: ageMs > STALE_THRESHOLD_MS,
    cacheFile,
  };
}

/**
 * Wrap a prompt with code map context if available
 *
 * This is a convenience function for tools to easily add code map context.
 *
 * @param prompt - The original prompt
 * @param repoPath - Path to repository (defaults to cwd)
 * @returns Prompt with code map context prepended if available
 */
export async function withCodeMapContext(prompt: string, repoPath?: string): Promise<string> {
  const codemap = await getCodeMapContext(repoPath);
  if (!codemap) {
    return prompt;
  }

  return `<codebase-structure>
${codemap}
</codebase-structure>

${prompt}`;
}

/**
 * List all cached code maps
 */
export function listCachedCodeMaps(): Array<{ file: string; repoName: string; modifiedAt: Date }> {
  if (!existsSync(CACHE_DIR)) {
    return [];
  }

  const fs = require("fs");
  const files = fs.readdirSync(CACHE_DIR) as string[];

  return files
    .filter((f: string) => f.startsWith("codemap-") && f.endsWith(".json") && !f.includes(".lock") && !f.includes(".tmp"))
    .map((f: string) => {
      const fullPath = join(CACHE_DIR, f);
      const stat = statSync(fullPath);
      // Extract repo name from filename: codemap-{name}-{hash}.json
      const match = f.match(/^codemap-(.+)-[a-f0-9]{8}\.json$/);
      const repoName = match ? match[1] : f;
      return {
        file: fullPath,
        repoName,
        modifiedAt: stat.mtime,
      };
    });
}

/**
 * Clear all cached code maps
 */
export function clearAllCodeMapCaches(): number {
  const caches = listCachedCodeMaps();
  for (const cache of caches) {
    try {
      unlinkSync(cache.file);
    } catch { /* ignore */ }
  }
  log.info(`Cleared ${caches.length} cached code maps`);
  return caches.length;
}
