/**
 * SQLite persistence for the hybrid scheduler.
 *
 * Two tables:
 * - entries: one-shot tasks; the runner owns firing, the store owns durable state.
 * - recurring: internal fallback rules for repeated actions when a native HA automation
 *   cannot be created. The fallback schedules the next occurrence as a one-shot entry.
 *
 * The schema is created idempotently on open, WAL keeps a single writer cheap.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import type {
  HaCallServiceRequest,
  HaServiceTarget,
  LoggerLike,
  SchedulerAction,
  SchedulerEntry,
} from "../shared/types.js";

export type SchedulerEntryStatus = "pending" | "executed" | "cancelled" | "missed";

/** Entry as stored: the public SchedulerEntry plus the bookkeeping columns. */
export interface StoredSchedulerEntry extends SchedulerEntry {
  status: SchedulerEntryStatus;
  executedAt: number | null;
}

/** Internal recurring rule: exact spec/action payloads live as JSON like entries do. */
export interface RecurringRecord {
  id: string;
  label: string;
  specJson: string;
  action: SchedulerAction;
  nextAt: number;
  createdAt: number;
}

export interface RecurringInsertInput {
  id: string;
  label: string;
  specJson: string;
  action: SchedulerAction;
  nextAt: number;
  createdAt: number;
}

export interface StartupRecovery {
  /** Overdue by no more than graceMs: run them right away. */
  due: SchedulerEntry[];
  /** Overdue by more than graceMs: marked as missed and never executed. */
  missed: SchedulerEntry[];
}

export interface SchedulerStore {
  insert(entry: SchedulerEntry): void;
  get(id: string): StoredSchedulerEntry | null;
  /** Remove a pending entry; returns false when it is absent or already fired. */
  remove(id: string): boolean;
  /**
   * Remove every pending entry; returns the number removed. When excludeIdPrefix is given,
   * entries whose id starts with it are kept (used to protect internal recurring chains).
   */
  cancelAll(excludeIdPrefix?: string): number;
  /** Pending entries, earliest first. */
  listActive(): StoredSchedulerEntry[];
  /** Every entry, newest created first. */
  listAll(limit?: number): StoredSchedulerEntry[];
  markExecuted(id: string, at?: number): boolean;
  markMissed(id: string): boolean;
  recoverAfterRestart(nowMs: number, graceMs?: number): StartupRecovery;
  insertRecurring(record: RecurringInsertInput): void;
  getRecurring(id: string): RecurringRecord | null;
  listRecurring(): RecurringRecord[];
  updateRecurringNext(id: string, nextAt: number): boolean;
  removeRecurring(id: string): boolean;
  close(): void;
}

export const SCHEDULER_DB_FILENAME = "scheduler.db";

/**
 * Entry-id prefix reserved for internal recurring-fallback chain entries.
 * Those rows are implementation details of schedule/recurring-runner.ts: the user API
 * hides them, maxActive does not count them and "cancel all" must not remove them.
 */
export const RECURRING_CHAIN_ENTRY_PREFIX = "recurring:";

/** Overdue entries older than this are not replayed after a restart. */
export const DEFAULT_RECOVERY_GRACE_MS = 5 * 60_000;

/** `$PULSAR_BRAIN_DATA_DIR` (default ./data) + scheduler.db. */
export function defaultSchedulerDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PULSAR_BRAIN_DATA_DIR?.trim();
  const dataDir = configured !== undefined && configured.length > 0 ? configured : "./data";
  return join(dataDir, SCHEDULER_DB_FILENAME);
}

// ──────────────────────────────────────────────────────────────── rows ──

interface EntryRow {
  id: string;
  at: number;
  label: string;
  action_json: string;
  run_id: string | null;
  created_at: number;
  executed_at: number | null;
  status: string;
}

interface RecurringRow {
  id: string;
  label: string;
  spec_json: string;
  action_json: string;
  next_at: number;
  created_at: number;
}

const ENTRY_COLUMNS =
  "id, at, label, action_json, run_id, created_at, executed_at, status";
const RECURRING_COLUMNS = "id, label, spec_json, action_json, next_at, created_at";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  label TEXT NOT NULL,
  action_json TEXT NOT NULL,
  run_id TEXT,
  created_at INTEGER NOT NULL,
  executed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS entries_status_at ON entries (status, at);
CREATE TABLE IF NOT EXISTS recurring (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  action_json TEXT NOT NULL,
  next_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS recurring_next_at ON recurring (next_at);
`;

const STATUS_BY_NAME: Readonly<Record<string, SchedulerEntryStatus>> = {
  pending: "pending",
  executed: "executed",
  cancelled: "cancelled",
  missed: "missed",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readStatus(raw: string, entryId: string): SchedulerEntryStatus {
  const status = STATUS_BY_NAME[raw];
  if (status === undefined) {
    throw new Error(`scheduler entry ${entryId}: unknown status "${raw}"`);
  }
  return status;
}

function requireString(value: unknown, field: string, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${where}: field "${field}" must be a non-empty string`);
  }
  return value;
}

function readIdList(value: unknown, field: string, where: string): string | string[] {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && value.length > 0) {
    const ids: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || item.length === 0) {
        throw new Error(`${where}: field "${field}" must contain non-empty strings`);
      }
      ids.push(item);
    }
    return ids;
  }
  throw new Error(`${where}: field "${field}" must be a string or a non-empty string array`);
}

function readTarget(value: unknown, where: string): HaServiceTarget {
  if (!isRecord(value)) throw new Error(`${where}: target must be an object`);
  const target: HaServiceTarget = {};
  if (value.entity_id !== undefined) target.entity_id = readIdList(value.entity_id, "entity_id", where);
  if (value.area_id !== undefined) target.area_id = readIdList(value.area_id, "area_id", where);
  if (value.device_id !== undefined) target.device_id = readIdList(value.device_id, "device_id", where);
  return target;
}

function readHaRequest(value: unknown, where: string): HaCallServiceRequest {
  if (!isRecord(value)) throw new Error(`${where}: ha.call_service request must be an object`);
  const request: HaCallServiceRequest = {
    domain: requireString(value.domain, "domain", where),
    service: requireString(value.service, "service", where),
  };
  if (value.target !== undefined) request.target = readTarget(value.target, where);
  if (value.data !== undefined) {
    if (!isRecord(value.data)) throw new Error(`${where}: request.data must be an object`);
    request.data = value.data;
  }
  return request;
}

function readActionJson(raw: string, owner: string): SchedulerAction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${owner}: invalid action JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) throw new Error(`${owner}: action must be an object`);
  switch (parsed.kind) {
    case "ha.call_service":
      return { kind: "ha.call_service", request: readHaRequest(parsed.request, owner) };
    case "announce":
      return { kind: "announce", text: requireString(parsed.text, "text", owner) };
    case "mcp.tool": {
      const name = requireString(parsed.name, "name", owner);
      const args = parsed.args;
      if (!isRecord(args)) throw new Error(`${owner}: mcp.tool args must be an object`);
      return { kind: "mcp.tool", name, args };
    }
    default:
      throw new Error(`${owner}: unknown action kind "${String(parsed.kind)}"`);
  }
}

function rowToEntry(row: EntryRow): StoredSchedulerEntry {
  const entry: StoredSchedulerEntry = {
    id: row.id,
    at: row.at,
    label: row.label,
    action: readActionJson(row.action_json, `scheduler entry ${row.id}`),
    createdAt: row.created_at,
    status: readStatus(row.status, row.id),
    executedAt: row.executed_at,
  };
  if (row.run_id !== null) entry.runId = row.run_id;
  return entry;
}

function rowToRecurring(row: RecurringRow): RecurringRecord {
  return {
    id: row.id,
    label: row.label,
    specJson: row.spec_json,
    action: readActionJson(row.action_json, `recurring rule ${row.id}`),
    nextAt: row.next_at,
    createdAt: row.created_at,
  };
}

// ─────────────────────────────────────────────────────────────── store ──

export function createSchedulerStore(dbPath: string, log: LoggerLike): SchedulerStore {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);

  const insertStmt = db.prepare<[string, number, string, string, string | null, number], unknown>(
    `INSERT INTO entries (${ENTRY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending')`,
  );
  const getStmt = db.prepare<[string], EntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM entries WHERE id = ?`,
  );
  const deletePendingStmt = db.prepare<[string], unknown>(
    `DELETE FROM entries WHERE id = ? AND status = 'pending'`,
  );
  const deleteAllPendingStmt = db.prepare<[], unknown>(
    `DELETE FROM entries WHERE status = 'pending'`,
  );
  const deletePendingExceptPrefixStmt = db.prepare<[string], unknown>(
    `DELETE FROM entries WHERE status = 'pending' AND id NOT LIKE ?`,
  );
  const listPendingStmt = db.prepare<[], EntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM entries WHERE status = 'pending' ORDER BY at ASC, id ASC`,
  );
  const listAllStmt = db.prepare<[number], EntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM entries ORDER BY created_at DESC, id DESC LIMIT ?`,
  );
  const markExecutedStmt = db.prepare<[number, string], unknown>(
    `UPDATE entries SET status = 'executed', executed_at = ? WHERE id = ? AND status = 'pending'`,
  );
  const markMissedStmt = db.prepare<[string], unknown>(
    `UPDATE entries SET status = 'missed' WHERE id = ? AND status = 'pending'`,
  );

  const insertRecurringStmt = db.prepare<[string, string, string, string, number, number], unknown>(
    `INSERT INTO recurring (${RECURRING_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const getRecurringStmt = db.prepare<[string], RecurringRow>(
    `SELECT ${RECURRING_COLUMNS} FROM recurring WHERE id = ?`,
  );
  const listRecurringStmt = db.prepare<[], RecurringRow>(
    `SELECT ${RECURRING_COLUMNS} FROM recurring ORDER BY next_at ASC, id ASC`,
  );
  const updateRecurringNextStmt = db.prepare<[number, string], unknown>(
    `UPDATE recurring SET next_at = ? WHERE id = ?`,
  );
  const removeRecurringStmt = db.prepare<[string], unknown>(
    `DELETE FROM recurring WHERE id = ?`,
  );

  const recoverTx = db.transaction((nowMs: number, graceMs: number): StartupRecovery => {
    const due: SchedulerEntry[] = [];
    const missed: SchedulerEntry[] = [];
    for (const row of listPendingStmt.all()) {
      if (row.at > nowMs) continue;
      const entry = rowToEntry(row);
      if (nowMs - row.at <= graceMs) {
        due.push(entry);
      } else {
        markMissedStmt.run(row.id);
        missed.push(entry);
      }
    }
    return { due, missed };
  });

  log.debug("scheduler store opened", { path: dbPath });

  let closed = false;

  return {
    insert(entry: SchedulerEntry): void {
      insertStmt.run(
        entry.id,
        entry.at,
        entry.label,
        JSON.stringify(entry.action),
        entry.runId ?? null,
        entry.createdAt,
      );
    },

    get(id: string): StoredSchedulerEntry | null {
      const row = getStmt.get(id);
      return row === undefined ? null : rowToEntry(row);
    },

    remove(id: string): boolean {
      return deletePendingStmt.run(id).changes > 0;
    },

    cancelAll(excludeIdPrefix?: string): number {
      if (excludeIdPrefix === undefined) return deleteAllPendingStmt.run().changes;
      return deletePendingExceptPrefixStmt.run(`${excludeIdPrefix}%`).changes;
    },

    listActive(): StoredSchedulerEntry[] {
      return listPendingStmt.all().map(rowToEntry);
    },

    listAll(limit = 200): StoredSchedulerEntry[] {
      return listAllStmt.all(limit).map(rowToEntry);
    },

    markExecuted(id: string, at = Date.now()): boolean {
      return markExecutedStmt.run(at, id).changes > 0;
    },

    markMissed(id: string): boolean {
      return markMissedStmt.run(id).changes > 0;
    },

    recoverAfterRestart(nowMs: number, graceMs = DEFAULT_RECOVERY_GRACE_MS): StartupRecovery {
      return recoverTx(nowMs, graceMs);
    },

    insertRecurring(record: RecurringInsertInput): void {
      insertRecurringStmt.run(
        record.id,
        record.label,
        record.specJson,
        JSON.stringify(record.action),
        record.nextAt,
        record.createdAt,
      );
    },

    getRecurring(id: string): RecurringRecord | null {
      const row = getRecurringStmt.get(id);
      return row === undefined ? null : rowToRecurring(row);
    },

    listRecurring(): RecurringRecord[] {
      return listRecurringStmt.all().map(rowToRecurring);
    },

    updateRecurringNext(id: string, nextAt: number): boolean {
      return updateRecurringNextStmt.run(nextAt, id).changes > 0;
    },

    removeRecurring(id: string): boolean {
      return removeRecurringStmt.run(id).changes > 0;
    },

    close(): void {
      if (closed) return;
      closed = true;
      db.close();
      log.debug("scheduler store closed", { path: dbPath });
    },
  };
}
