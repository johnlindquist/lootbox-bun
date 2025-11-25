// Shared database utilities for lootbox SQLite database
// Provides centralized connection management and schema initialization

import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdir } from "fs/promises";

/**
 * Get platform-specific data directory following XDG Base Directory spec
 */
function getDefaultDataDir(): string {
  const platform = process.platform;

  if (platform === "win32") {
    const appData = process.env.APPDATA || process.env.USERPROFILE;
    return appData
      ? join(appData, "lootbox")
      : join(process.cwd(), "lootbox-data");
  } else if (platform === "darwin") {
    const home = process.env.HOME;
    return home
      ? join(home, "Library", "Application Support", "lootbox")
      : join(process.cwd(), "lootbox-data");
  } else {
    // Linux/Unix - follow XDG spec
    const xdgDataHome = process.env.XDG_DATA_HOME;
    const home = process.env.HOME;
    if (xdgDataHome) {
      return join(xdgDataHome, "lootbox");
    } else if (home) {
      return join(home, ".local", "share", "lootbox");
    }
    return join(process.cwd(), "lootbox-data");
  }
}

/**
 * Get the database file path
 */
async function getDbPath(): Promise<string> {
  const { get_config } = await import("./get_config.ts");
  const config = await get_config();
  const baseDir = config.lootbox_data_dir || getDefaultDataDir();
  return join(baseDir, "lootbox.db");
}

/**
 * Ensure the database directory exists
 */
async function ensureDbDir(dbPath: string): Promise<void> {
  const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "EEXIST") {
      throw error;
    }
  }
}

let dbInstance: Database | null = null;
let schemaInitialized = false;

/**
 * Initialize all database schemas
 */
function initializeSchemas(db: Database): void {
  if (schemaInitialized) return;

  // Workflow events table
  db.run(`
    CREATE TABLE IF NOT EXISTS workflow_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      workflow_file TEXT NOT NULL,
      step_number INTEGER,
      loop_iteration INTEGER,
      reason TEXT,
      session_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_workflow_events_timestamp
    ON workflow_events(timestamp)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_workflow_events_workflow_file
    ON workflow_events(workflow_file)
  `);

  // Script runs table
  db.run(`
    CREATE TABLE IF NOT EXISTS script_runs (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      script TEXT NOT NULL,
      success INTEGER NOT NULL,
      output TEXT,
      error TEXT,
      duration_ms INTEGER,
      session_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_script_runs_timestamp
    ON script_runs(timestamp)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_script_runs_session_id
    ON script_runs(session_id)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_script_runs_success
    ON script_runs(success)
  `);

  schemaInitialized = true;
}

/**
 * Get or create database connection and initialize all schemas
 * This is a singleton - all modules share the same connection
 */
export async function getDb(): Promise<Database> {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = await getDbPath();
  await ensureDbDir(dbPath);

  dbInstance = new Database(dbPath);
  initializeSchemas(dbInstance);

  return dbInstance;
}

/**
 * Close the database connection
 * Should be called when shutting down the application
 */
export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    schemaInitialized = false;
  }
}
