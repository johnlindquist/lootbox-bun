// Script execution history storage for pattern extraction and library building
// Uses SQLite database for efficient querying and storage

import { getDb, closeDb as closeDatabase } from "./db.ts";

export interface ScriptRun {
  id: string; // Unique identifier (timestamp-randomId)
  timestamp: number; // Unix timestamp in milliseconds
  script: string; // The TypeScript code executed
  success: boolean; // Whether execution succeeded
  output?: unknown; // Success output (if any)
  error?: string; // Error message (if failed)
  durationMs?: number; // Execution duration in milliseconds
  sessionId?: string; // Optional session identifier for grouping related runs
}

/**
 * Generate a unique ID for a script run
 */
function generateRunId(): string {
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(2, 8);
  return `${timestamp}-${randomId}`;
}

/**
 * Save a script run to database (async, non-blocking)
 */
export async function saveScriptRun(run: Omit<ScriptRun, "id">): Promise<void> {
  const id = generateRunId();
  const scriptRun: ScriptRun = { id, ...run };

  // Don't await - fire and forget
  (async () => {
    try {
      const db = await getDb();

      // Serialize output to JSON if present
      const outputJson = scriptRun.output !== undefined
        ? JSON.stringify(scriptRun.output)
        : null;

      db.run(
        `INSERT INTO script_runs (
          id, timestamp, script, success, output, error, duration_ms, session_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          scriptRun.id,
          scriptRun.timestamp,
          scriptRun.script,
          scriptRun.success ? 1 : 0,
          outputJson,
          scriptRun.error || null,
          scriptRun.durationMs || null,
          scriptRun.sessionId || null,
        ]
      );

      console.error(`📝 Saved script run ${scriptRun.id}`);
    } catch (error) {
      console.error(`❌ Failed to save script run ${id}:`, error);
    }
  })();
}

interface ScriptRunRow {
  id: string;
  timestamp: number;
  script: string;
  success: number;
  output: string | null;
  error: string | null;
  duration_ms: number | null;
  session_id: string | null;
}

function rowToScriptRun(row: ScriptRunRow): ScriptRun {
  return {
    id: row.id,
    timestamp: row.timestamp,
    script: row.script,
    success: row.success === 1,
    output: row.output ? JSON.parse(row.output) : undefined,
    error: row.error || undefined,
    durationMs: row.duration_ms || undefined,
    sessionId: row.session_id || undefined,
  };
}

/**
 * Load all script runs from database
 * Returns sorted by timestamp (oldest first)
 */
export async function loadScriptHistory(): Promise<ScriptRun[]> {
  try {
    const db = await getDb();

    const results = db.query<ScriptRunRow, []>(
      `SELECT id, timestamp, script, success, output, error, duration_ms, session_id
       FROM script_runs
       ORDER BY timestamp ASC`
    ).all();

    return results.map(rowToScriptRun);
  } catch (error) {
    console.error("Failed to load script history:", error);
    return [];
  }
}

/**
 * Get recent script runs (last N runs)
 */
export async function getRecentRuns(count: number): Promise<ScriptRun[]> {
  try {
    const db = await getDb();

    const results = db.query<ScriptRunRow, [number]>(
      `SELECT id, timestamp, script, success, output, error, duration_ms, session_id
       FROM script_runs
       ORDER BY timestamp DESC
       LIMIT ?`
    ).all(count);

    return results.map(rowToScriptRun);
  } catch (error) {
    console.error("Failed to get recent runs:", error);
    return [];
  }
}

/**
 * Get script runs in a time range
 */
export async function getRunsInRange(
  startTime: number,
  endTime: number
): Promise<ScriptRun[]> {
  try {
    const db = await getDb();

    const results = db.query<ScriptRunRow, [number, number]>(
      `SELECT id, timestamp, script, success, output, error, duration_ms, session_id
       FROM script_runs
       WHERE timestamp >= ? AND timestamp <= ?
       ORDER BY timestamp ASC`
    ).all(startTime, endTime);

    return results.map(rowToScriptRun);
  } catch (error) {
    console.error("Failed to get runs in range:", error);
    return [];
  }
}

/**
 * Delete old script runs (keep only last N days)
 * Useful for preventing unlimited storage growth
 */
export async function cleanupOldRuns(keepDays: number): Promise<number> {
  try {
    const db = await getDb();
    const cutoffTime = Date.now() - keepDays * 24 * 60 * 60 * 1000;

    // Get count before deletion
    const countResult = db.query<{ count: number }, [number]>(
      `SELECT COUNT(*) as count FROM script_runs WHERE timestamp < ?`
    ).get(cutoffTime);

    const deletedCount = countResult?.count || 0;

    if (deletedCount > 0) {
      db.run(`DELETE FROM script_runs WHERE timestamp < ?`, [cutoffTime]);
      console.error(`🧹 Cleaned up ${deletedCount} old script run(s)`);
    }

    return deletedCount;
  } catch (error) {
    console.error("Failed to cleanup old runs:", error);
    return 0;
  }
}

/**
 * Load script runs for a specific date
 */
export async function loadRunsForDate(date: Date): Promise<ScriptRun[]> {
  try {
    const db = await getDb();

    // Get start and end of day in milliseconds
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const results = db.query<ScriptRunRow, [number, number]>(
      `SELECT id, timestamp, script, success, output, error, duration_ms, session_id
       FROM script_runs
       WHERE timestamp >= ? AND timestamp <= ?
       ORDER BY timestamp ASC`
    ).all(startOfDay.getTime(), endOfDay.getTime());

    return results.map(rowToScriptRun);
  } catch (error) {
    console.error(`Failed to load runs for ${date}:`, error);
    return [];
  }
}

/**
 * Get script runs by session ID
 */
export async function getRunsBySession(sessionId: string): Promise<ScriptRun[]> {
  try {
    const db = await getDb();

    const results = db.query<ScriptRunRow, [string]>(
      `SELECT id, timestamp, script, success, output, error, duration_ms, session_id
       FROM script_runs
       WHERE session_id = ?
       ORDER BY timestamp ASC`
    ).all(sessionId);

    return results.map(rowToScriptRun);
  } catch (error) {
    console.error(`Failed to get runs for session ${sessionId}:`, error);
    return [];
  }
}

/**
 * Close the database connection
 */
export const closeDb = closeDatabase;
