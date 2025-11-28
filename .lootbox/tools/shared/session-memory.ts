/**
 * Session Memory - In-memory context storage for tools
 *
 * Provides tools with session-scoped memory that persists across calls
 * but clears on server restart. Enables:
 * - Key-value storage per tool
 * - Conversation history tracking
 * - Automatic TTL and LRU eviction
 *
 * Memory is injected by WorkerManager via IPC and synchronized back
 * after each call.
 */

// ============== Types ==============

export interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryEntry<T = unknown> {
  value: T;
  timestamp: number;
  expiresAt?: number;
  accessCount: number;
}

export interface ToolMemory {
  kv: Map<string, MemoryEntry>;
  history: ConversationMessage[];
}

// ============== Configuration ==============

const MAX_KV_ENTRIES = 100;
const MAX_HISTORY_MESSAGES = 50;
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ============== Thread-Local Storage ==============

// Current tool's memory (set per-request)
let currentToolName: string | null = null;
let currentMemory: ToolMemory | null = null;

/**
 * Initialize session memory for a tool (called by worker)
 */
export function setSessionMemory(toolName: string, memory: ToolMemory): void {
  currentToolName = toolName;
  currentMemory = memory;
  cleanupExpired();
}

/**
 * Clear session memory (called after each request)
 */
export function clearSessionMemory(): void {
  currentToolName = null;
  currentMemory = null;
}

/**
 * Get a snapshot of current memory for IPC
 */
export function getMemorySnapshot(): {
  kv: Record<string, MemoryEntry>;
  history: ConversationMessage[];
} | null {
  if (!currentMemory) return null;

  return {
    kv: Object.fromEntries(currentMemory.kv.entries()),
    history: currentMemory.history,
  };
}

// ============== Key-Value Operations ==============

/**
 * Get a value from session memory
 *
 * @param key - Key to retrieve
 * @returns The value or undefined if not found/expired
 */
export function getMemory<T = unknown>(key: string): T | undefined {
  if (!currentMemory) return undefined;

  const entry = currentMemory.kv.get(key);
  if (!entry) return undefined;

  // Check expiration
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    currentMemory.kv.delete(key);
    return undefined;
  }

  // Update access count for LRU
  entry.accessCount++;
  return entry.value as T;
}

/**
 * Set a value in session memory
 *
 * @param key - Key to store
 * @param value - Value to store
 * @param ttlMs - Optional TTL in milliseconds
 */
export function setMemory<T = unknown>(key: string, value: T, ttlMs?: number): void {
  if (!currentMemory) return;

  // Enforce max entries with LRU eviction
  if (currentMemory.kv.size >= MAX_KV_ENTRIES && !currentMemory.kv.has(key)) {
    evictLRU();
  }

  currentMemory.kv.set(key, {
    value,
    timestamp: Date.now(),
    expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
    accessCount: 0,
  });
}

/**
 * Delete a value from session memory
 */
export function deleteMemory(key: string): boolean {
  if (!currentMemory) return false;
  return currentMemory.kv.delete(key);
}

/**
 * Check if a key exists in session memory
 */
export function hasMemory(key: string): boolean {
  if (!currentMemory) return false;

  const entry = currentMemory.kv.get(key);
  if (!entry) return false;

  // Check expiration
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    currentMemory.kv.delete(key);
    return false;
  }

  return true;
}

/**
 * Get all keys in session memory
 */
export function getMemoryKeys(): string[] {
  if (!currentMemory) return [];
  cleanupExpired();
  return Array.from(currentMemory.kv.keys());
}

// ============== Conversation History ==============

/**
 * Add a message to conversation history
 */
export function addToConversationHistory(message: Omit<ConversationMessage, "timestamp">): void {
  if (!currentMemory) return;

  currentMemory.history.push({
    ...message,
    timestamp: Date.now(),
  });

  // Enforce max history size
  while (currentMemory.history.length > MAX_HISTORY_MESSAGES) {
    currentMemory.history.shift();
  }
}

/**
 * Get recent conversation history
 *
 * @param limit - Max messages to return (default: 10)
 */
export function getConversationHistory(limit = 10): ConversationMessage[] {
  if (!currentMemory) return [];

  return currentMemory.history.slice(-limit);
}

/**
 * Get conversation history formatted for AI prompts
 */
export function getFormattedHistory(limit = 10): string {
  const history = getConversationHistory(limit);

  return history
    .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
    .join("\n\n");
}

/**
 * Clear conversation history
 */
export function clearConversationHistory(): void {
  if (!currentMemory) return;
  currentMemory.history = [];
}

// ============== Context Helpers ==============

/**
 * Get full context for AI tools
 * Combines key-value memory with conversation history
 */
export function getContext(): {
  toolName: string;
  memory: Record<string, unknown>;
  recentHistory: ConversationMessage[];
  historyFormatted: string;
} | null {
  if (!currentMemory || !currentToolName) return null;

  const memory: Record<string, unknown> = {};
  for (const [key, entry] of currentMemory.kv) {
    if (!entry.expiresAt || Date.now() <= entry.expiresAt) {
      memory[key] = entry.value;
    }
  }

  return {
    toolName: currentToolName,
    memory,
    recentHistory: getConversationHistory(10),
    historyFormatted: getFormattedHistory(10),
  };
}

/**
 * Check if session memory is available
 */
export function hasSessionMemory(): boolean {
  return currentMemory !== null;
}

// ============== Internal Utilities ==============

/**
 * Remove expired entries
 */
function cleanupExpired(): void {
  if (!currentMemory) return;

  const now = Date.now();
  for (const [key, entry] of currentMemory.kv) {
    if (entry.expiresAt && now > entry.expiresAt) {
      currentMemory.kv.delete(key);
    }
  }
}

/**
 * Evict least recently used entry
 */
function evictLRU(): void {
  if (!currentMemory || currentMemory.kv.size === 0) return;

  let lruKey: string | null = null;
  let lruAccessCount = Infinity;
  let lruTimestamp = Infinity;

  for (const [key, entry] of currentMemory.kv) {
    // Prioritize by access count, then by timestamp
    if (
      entry.accessCount < lruAccessCount ||
      (entry.accessCount === lruAccessCount && entry.timestamp < lruTimestamp)
    ) {
      lruKey = key;
      lruAccessCount = entry.accessCount;
      lruTimestamp = entry.timestamp;
    }
  }

  if (lruKey) {
    currentMemory.kv.delete(lruKey);
  }
}
