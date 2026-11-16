/**
 * One-shot scheduler runner.
 *
 * The runner owns the single timer, restart recovery and the executed/consumed bookkeeping.
 * Action semantics are injected as an executor: index.ts decides how ha.call_service,
 * announce and mcp.tool are performed (the announce satellite target is not part of
 * SchedulerAction, so the scheduler cannot guess it).
 */

import type {
  HaCallServiceRequest,
  HaClientLike,
  LoggerLike,
  McpToolProxyLike,
  SchedulerEntry,
} from "../shared/types.js";
import type { SchedulerStore } from "./store.js";
import { DEFAULT_RECOVERY_GRACE_MS } from "./store.js";

export type SchedulerActionExecutor = (entry: SchedulerEntry) => Promise<void>;

/** setTimeout overflows above this and fires immediately. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const DEFAULT_HA_RETRY_DELAY_MS = 2_000;

export interface SchedulerRunnerDeps {
  store: SchedulerStore;
  execute: SchedulerActionExecutor;
  log: LoggerLike;
  now?: () => number;
  graceMs?: number;
}

export interface StartupRecoveryReport {
  due: number;
  missed: number;
}

export interface SchedulerRunner {
  /** Recover overdue entries, execute the ones inside the grace window and arm the timer. */
  start(): Promise<StartupRecoveryReport>;
  /** Clear the timer; pending entries stay in SQLite for the next start. */
  stop(): void;
  /** Recompute the single timer after the store changed. */
  refresh(): void;
  /** Timestamp of the next pending entry, null when the queue is empty. */
  nextAt(): number | null;
  running(): boolean;
  /** Run a pending entry immediately (admin run-now). False when it is absent or done. */
  runNow(id: string): Promise<boolean>;
  /** Called after an entry was executed and marked done. Returns an unsubscribe function. */
  onExecuted(listener: (entry: SchedulerEntry) => void): () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function unrefTimer(target: ReturnType<typeof setTimeout>): void {
  // Fake timers in tests may return an object without unref; Node timers have it.
  const holder: { unref?: () => void } = target;
  holder.unref?.();
}

export function createSchedulerRunner(deps: SchedulerRunnerDeps): SchedulerRunner {
  const { store, execute, log } = deps;
  const now = deps.now ?? Date.now;
  const graceMs = deps.graceMs ?? DEFAULT_RECOVERY_GRACE_MS;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let firing = false;
  let nextAtValue: number | null = null;
  const executing = new Set<string>();
  const listeners = new Set<(entry: SchedulerEntry) => void>();

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function notifyExecuted(entry: SchedulerEntry): void {
    for (const listener of [...listeners]) {
      try {
        listener(entry);
      } catch (error) {
        log.error("scheduler: executed listener failed", {
          id: entry.id,
          error: errorMessage(error),
        });
      }
    }
  }

  async function runEntry(entry: SchedulerEntry): Promise<void> {
    const current = store.get(entry.id);
    if (current === null || current.status !== "pending") {
      log.debug("scheduler: entry already handled", { id: entry.id });
      return;
    }
    if (executing.has(entry.id)) {
      log.debug("scheduler: entry is already executing", { id: entry.id });
      return;
    }
    executing.add(entry.id);
    log.info("scheduler: executing entry", { id: entry.id, label: entry.label, at: iso(entry.at) });
    try {
      await execute(entry);
    } catch (error) {
      // The injected executor logs action details; consume the entry anyway so one
      // permanently failing action cannot block the rest of the queue.
      log.error("scheduler: action failed", {
        id: entry.id,
        label: entry.label,
        error: errorMessage(error),
      });
    } finally {
      executing.delete(entry.id);
    }
    if (!store.markExecuted(entry.id, now())) {
      log.warn("scheduler: entry disappeared while executing", { id: entry.id });
    }
    notifyExecuted(entry);
  }

  async function fire(): Promise<void> {
    if (!started || firing) return;
    firing = true;
    try {
      const nowMs = now();
      const due = store.listActive().filter((entry) => entry.at <= nowMs);
      for (const entry of due) {
        if (!started) break;
        await runEntry(entry);
      }
    } catch (error) {
      log.error("scheduler: timer loop failed", { error: errorMessage(error) });
    } finally {
      firing = false;
      try {
        refresh();
      } catch (error) {
        log.error("scheduler: reschedule failed", { error: errorMessage(error) });
      }
    }
  }

  function refresh(): void {
    if (!started) return;
    if (firing) return;
    clearTimer();
    const next = store.listActive()[0];
    if (next === undefined) {
      nextAtValue = null;
      return;
    }
    nextAtValue = next.at;
    const delay = Math.max(0, next.at - now());
    timer = setTimeout(() => {
      timer = null;
      void fire();
    }, Math.min(delay, MAX_TIMER_DELAY_MS));
    unrefTimer(timer);
  }

  async function start(): Promise<StartupRecoveryReport> {
    if (started) {
      log.warn("scheduler: runner already started");
      return { due: 0, missed: 0 };
    }
    let recovery;
    try {
      recovery = store.recoverAfterRestart(now(), graceMs);
    } catch (error) {
      log.error("scheduler: restart recovery failed", { error: errorMessage(error) });
      throw error;
    }
    started = true;
    for (const entry of recovery.missed) {
      log.warn("scheduler: missed entry outside the grace window", {
        id: entry.id,
        label: entry.label,
        at: iso(entry.at),
      });
    }
    if (recovery.due.length > 0) {
      log.info("scheduler: executing overdue entries after restart", {
        count: recovery.due.length,
      });
    }
    for (const entry of recovery.due) {
      await runEntry(entry);
    }
    refresh();
    return { due: recovery.due.length, missed: recovery.missed.length };
  }

  function stop(): void {
    if (!started) {
      clearTimer();
      return;
    }
    started = false;
    clearTimer();
    nextAtValue = null;
    log.debug("scheduler: runner stopped");
  }

  async function runNow(id: string): Promise<boolean> {
    const entry = store.get(id);
    if (entry === null || entry.status !== "pending") return false;
    await runEntry(entry);
    refresh();
    return true;
  }

  function onExecuted(listener: (entry: SchedulerEntry) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return {
    start,
    stop,
    refresh,
    nextAt: () => nextAtValue,
    running: () => started,
    runNow,
    onExecuted,
  };
}

// ─────────────────────────────────────────────────────── action executor ──

export interface ActionExecutorDeps {
  ha: HaClientLike;
  mcp: McpToolProxyLike;
  /**
   * Speak a text on the satellite. The satellite entity is wiring, not protocol:
   * SchedulerAction.announce carries only the text, so index.ts supplies this callback.
   */
  announce: (text: string) => Promise<void>;
  log: LoggerLike;
  retryDelayMs?: number;
  /** Injection point for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function callHaServiceWithRetry(
  ha: HaClientLike,
  request: HaCallServiceRequest,
  entry: SchedulerEntry,
  log: LoggerLike,
  retryDelayMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const details = { id: entry.id, domain: request.domain, service: request.service };
  try {
    await ha.callService(request);
    return;
  } catch (error) {
    log.warn("scheduler: HA call failed, retrying once", {
      ...details,
      error: errorMessage(error),
    });
  }
  await sleep(retryDelayMs);
  try {
    await ha.callService(request);
  } catch (error) {
    log.error("scheduler: HA call failed after retry", {
      ...details,
      error: errorMessage(error),
    });
    throw error;
  }
}

/** Build the executor index.ts injects into the runner/service. */
export function createActionExecutor(deps: ActionExecutorDeps): SchedulerActionExecutor {
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_HA_RETRY_DELAY_MS;
  const sleep = deps.sleep ?? defaultSleep;

  return async (entry: SchedulerEntry): Promise<void> => {
    const action = entry.action;
    switch (action.kind) {
      case "ha.call_service":
        await callHaServiceWithRetry(
          deps.ha,
          action.request,
          entry,
          deps.log,
          retryDelayMs,
          sleep,
        );
        return;
      case "announce":
        try {
          await deps.announce(action.text);
        } catch (error) {
          deps.log.error("scheduler: announce failed", {
            id: entry.id,
            error: errorMessage(error),
          });
          throw error;
        }
        return;
      case "mcp.tool":
        try {
          const result = await deps.mcp.callTool(action.name, action.args);
          if (!result.ok) {
            throw new Error(result.error ?? "MCP tool returned ok=false");
          }
        } catch (error) {
          deps.log.error("scheduler: MCP tool failed", {
            id: entry.id,
            tool: action.name,
            error: errorMessage(error),
          });
          throw error;
        }
        return;
    }
  };
}
