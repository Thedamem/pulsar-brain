/**
 * Internal recurring fallback.
 *
 * When a native HA automation cannot be created, the rule lives in the recurring table and
 * the next occurrence is materialised as a normal one-shot entry in the same store. The
 * shared SchedulerRunner executes it through the same executor as any other scheduled task;
 * after execution this module computes the next occurrence, updates the rule and queues the
 * next entry. Restart recovery therefore falls out of the one-shot queue for free.
 */

import { randomUUID } from "node:crypto";

import type { LoggerLike, SchedulerAction, SchedulerEntry } from "../shared/types.js";
import type { SchedulerRunner } from "../scheduler/runner.js";
import { RECURRING_CHAIN_ENTRY_PREFIX } from "../scheduler/store.js";
import type { RecurringInsertInput, RecurringRecord, SchedulerStore } from "../scheduler/store.js";
import type { RecurringSpec } from "./recurring.js";
import { nextOccurrence, parseRecurringSpecJson } from "./recurring.js";


export interface RecurringRule {
  id: string;
  label: string;
  spec: RecurringSpec;
  action: SchedulerAction;
  nextAt: number;
  createdAt: number;
}

export interface RecurringAddInput {
  label: string;
  spec: RecurringSpec;
  action: SchedulerAction;
}

export interface RecurringRunnerDeps {
  store: SchedulerStore;
  /** The one-shot runner; recurring rules are executed as generated one-shot entries. */
  runner: SchedulerRunner;
  log: LoggerLike;
  now?: () => number;
  idFactory?: () => string;
}

export interface RecurringStartReport {
  rules: number;
  /** Rules whose stored next_at was in the past and got recalculated for the future. */
  rescheduled: number;
}

export interface RecurringRunner {
  start(): Promise<RecurringStartReport>;
  stop(): void;
  add(input: RecurringAddInput): Promise<RecurringRule>;
  remove(id: string): Promise<boolean>;
  list(): Promise<RecurringRule[]>;
  nextAt(): number | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function createRecurringRunner(deps: RecurringRunnerDeps): RecurringRunner {
  const { store, runner, log } = deps;
  const now = deps.now ?? Date.now;
  const idFactory = deps.idFactory ?? (() => `rec_${randomUUID()}`);

  let unsubscribe: (() => void) | null = null;
  let started = false;

  function chainPrefix(ruleId: string): string {
    return `${RECURRING_CHAIN_ENTRY_PREFIX}${ruleId}:`;
  }

  function removeChainEntries(ruleId: string): void {
    const prefix = chainPrefix(ruleId);
    for (const entry of store.listActive()) {
      if (entry.id.startsWith(prefix)) store.remove(entry.id);
    }
  }

  function insertChainEntry(
    ruleId: string,
    label: string,
    action: SchedulerAction,
    occurrenceAt: number,
  ): void {
    const entry: SchedulerEntry = {
      id: `${chainPrefix(ruleId)}${occurrenceAt}`,
      at: occurrenceAt,
      label,
      action,
      createdAt: now(),
    };
    store.insert(entry);
  }

  function ruleFromRecord(record: RecurringRecord): RecurringRule {
    return {
      id: record.id,
      label: record.label,
      spec: parseRecurringSpecJson(record.specJson, `recurring rule ${record.id}`),
      action: record.action,
      nextAt: record.nextAt,
      createdAt: record.createdAt,
    };
  }

  function scheduleNext(record: RecurringRecord): void {
    let spec: RecurringSpec;
    try {
      spec = parseRecurringSpecJson(record.specJson, `recurring rule ${record.id}`);
    } catch (error) {
      log.error("recurring: invalid stored spec, rule is disabled", {
        id: record.id,
        error: errorMessage(error),
      });
      return;
    }
    let nextAt: number;
    try {
      nextAt = nextOccurrence(spec, now());
    } catch (error) {
      log.error("recurring: cannot compute the next occurrence", {
        id: record.id,
        error: errorMessage(error),
      });
      return;
    }
    try {
      if (!store.updateRecurringNext(record.id, nextAt)) {
        log.warn("recurring: rule disappeared before rescheduling", { id: record.id });
        return;
      }
      insertChainEntry(record.id, record.label, record.action, nextAt);
    } catch (error) {
      log.error("recurring: failed to queue the next occurrence", {
        id: record.id,
        error: errorMessage(error),
      });
      return;
    }
    log.info("recurring: next occurrence queued", { id: record.id, nextAt: iso(nextAt) });
  }

  function handleExecuted(entry: SchedulerEntry): void {
    if (!entry.id.startsWith(RECURRING_CHAIN_ENTRY_PREFIX)) return;
    const rest = entry.id.slice(RECURRING_CHAIN_ENTRY_PREFIX.length);
    const separator = rest.lastIndexOf(":");
    if (separator <= 0) {
      log.warn("recurring: malformed chain entry id", { id: entry.id });
      return;
    }
    const ruleId = rest.slice(0, separator);
    const record = store.getRecurring(ruleId);
    if (record === null) {
      // The rule was deleted while its occurrence was executing; nothing to reschedule.
      log.debug("recurring: occurrence finished for a deleted rule", { id: ruleId });
      return;
    }
    scheduleNext(record);
  }

  async function start(): Promise<RecurringStartReport> {
    const records = store.listRecurring();
    if (started) return { rules: records.length, rescheduled: 0 };
    started = true;
    unsubscribe = runner.onExecuted(handleExecuted);
    const nowMs = now();
    let rescheduled = 0;
    for (const record of records) {
      try {
        const rule = ruleFromRecord(record);
        removeChainEntries(rule.id);
        let nextAt = rule.nextAt;
        if (nextAt <= nowMs) {
          nextAt = nextOccurrence(rule.spec, nowMs);
          rescheduled += 1;
          log.warn("recurring: missed occurrence recalculated after restart", {
            id: rule.id,
            missedAt: iso(rule.nextAt),
            nextAt: iso(nextAt),
          });
        }
        if (!store.updateRecurringNext(rule.id, nextAt)) {
          log.warn("recurring: rule disappeared while restoring", { id: rule.id });
          continue;
        }
        insertChainEntry(rule.id, rule.label, rule.action, nextAt);
      } catch (error) {
        log.error("recurring: failed to restore the rule", {
          id: record.id,
          error: errorMessage(error),
        });
      }
    }
    runner.refresh();
    log.info("recurring: internal fallback started", { rules: records.length, rescheduled });
    return { rules: records.length, rescheduled };
  }

  function stop(): void {
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
    if (!started) return;
    started = false;
    log.debug("recurring: internal fallback stopped");
  }

  async function add(input: RecurringAddInput): Promise<RecurringRule> {
    const id = idFactory();
    const createdAt = now();
    const nextAt = nextOccurrence(input.spec, createdAt);
    const record: RecurringInsertInput = {
      id,
      label: input.label,
      specJson: JSON.stringify(input.spec),
      action: input.action,
      nextAt,
      createdAt,
    };
    store.insertRecurring(record);
    insertChainEntry(id, input.label, input.action, nextAt);
    runner.refresh();
    log.info("recurring: internal rule added", {
      id,
      label: input.label,
      kind: input.spec.kind,
      time: input.spec.time,
      nextAt: iso(nextAt),
    });
    return {
      id,
      label: input.label,
      spec: input.spec,
      action: input.action,
      nextAt,
      createdAt,
    };
  }

  async function remove(id: string): Promise<boolean> {
    removeChainEntries(id);
    const removed = store.removeRecurring(id);
    runner.refresh();
    log.info("recurring: internal rule removed", { id, removed });
    return removed;
  }

  async function list(): Promise<RecurringRule[]> {
    const rules: RecurringRule[] = [];
    for (const record of store.listRecurring()) {
      try {
        rules.push(ruleFromRecord(record));
      } catch (error) {
        log.error("recurring: skipping an invalid rule", {
          id: record.id,
          error: errorMessage(error),
        });
      }
    }
    return rules;
  }

  function nextAt(): number | null {
    const first = store.listRecurring()[0];
    return first === undefined ? null : first.nextAt;
  }

  return { start, stop, add, remove, list, nextAt };
}
