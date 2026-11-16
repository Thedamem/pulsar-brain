/**
 * Session persistence and text normalisation helpers.
 * Only this module's own files and shared types are imported here.
 */

import Database from "better-sqlite3";
import type { LoggerLike, RunEndReason, SessionRecord } from "../shared/types.js";

export interface SessionStore {
  save(record: SessionRecord): void;
  list(limit: number): SessionRecord[];
  get(id: string): SessionRecord | undefined;
  close(): void;
}

interface SessionRow {
  id: string;
  started_at: number;
  ended_at: number | null;
  device_json: string;
  transcript: string;
  response: string;
  tool_calls_json: string;
  state: string;
  end_reason: string | null;
  timings_json: string;
}

export function createSessionStore(dbPath: string, log: LoggerLike): SessionStore {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      device_json TEXT NOT NULL,
      transcript TEXT NOT NULL,
      response TEXT NOT NULL,
      tool_calls_json TEXT NOT NULL,
      state TEXT NOT NULL,
      end_reason TEXT,
      timings_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_started_at ON sessions (started_at DESC);
  `);

  const upsert = db.prepare(`
    INSERT INTO sessions (id, started_at, ended_at, device_json, transcript, response,
                          tool_calls_json, state, end_reason, timings_json)
    VALUES (@id, @started_at, @ended_at, @device_json, @transcript, @response,
            @tool_calls_json, @state, @end_reason, @timings_json)
    ON CONFLICT(id) DO UPDATE SET
      ended_at = excluded.ended_at,
      transcript = excluded.transcript,
      response = excluded.response,
      tool_calls_json = excluded.tool_calls_json,
      state = excluded.state,
      end_reason = excluded.end_reason,
      timings_json = excluded.timings_json
  `);
  const selectOne = db.prepare("SELECT * FROM sessions WHERE id = ?");
  const selectLimit = db.prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?");

  const toRecord = (row: SessionRow): SessionRecord => {
    const record: SessionRecord = {
      id: row.id,
      startedAt: row.started_at,
      device: JSON.parse(row.device_json) as SessionRecord["device"],
      transcript: row.transcript,
      response: row.response,
      toolCalls: JSON.parse(row.tool_calls_json) as SessionRecord["toolCalls"],
      state: row.state as SessionRecord["state"],
      timings: JSON.parse(row.timings_json) as SessionRecord["timings"],
    };
    if (row.ended_at !== null) {
      record.endedAt = row.ended_at;
    }
    if (row.end_reason !== null) {
      record.endReason = row.end_reason as RunEndReason;
    }
    return record;
  };

  return {
    save(record) {
      try {
        upsert.run({
          id: record.id,
          started_at: record.startedAt,
          ended_at: record.endedAt ?? null,
          device_json: JSON.stringify(record.device),
          transcript: record.transcript,
          response: record.response,
          tool_calls_json: JSON.stringify(record.toolCalls),
          state: record.state,
          end_reason: record.endReason ?? null,
          timings_json: JSON.stringify(record.timings),
        });
      } catch (err) {
        log.error("session store: failed to save session", {
          id: record.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    list(limit) {
      return selectLimit.all(Math.max(1, Math.min(limit, 500))).map((row) => toRecord(row as SessionRow));
    },
    get(id) {
      const row = selectOne.get(id) as SessionRow | undefined;
      return row === undefined ? undefined : toRecord(row);
    },
    close() {
      db.close();
    },
  };
}

// JS `\b` only treats ASCII letters as word characters, so the lookahead is explicit.
const WAKE_PREFIX = /^(?:алиса|алис|alisa|яндекс|yandex)(?=$|[\s,.!?;:—-])[,.!?;:—\s-]*/iu;

/** Remove the wake word the satellite put into the transcript, plus stray punctuation. */
export function normalizeTranscript(text: string): string {
  let value = text.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = value.replace(WAKE_PREFIX, "").trim();
    if (next === value) {
      break;
    }
    value = next;
  }
  return value.replace(/\s+/g, " ").replace(/^[,.\-–—:;!?\s]+/, "").trim();
}
