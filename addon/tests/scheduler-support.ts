/**
 * Shared fixtures for scheduler tests: fake logger, HA client, MCP proxy, scheduler API,
 * AppConfig and ToolContext. Tests import this instead of other modules.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { vi } from "vitest";

import type {
  AppConfig,
  HaArea,
  HaCallServiceRequest,
  HaClientLike,
  HaEntity,
  HaState,
  LogEntry,
  LoggerLike,
  LogLevel,
  McpToolProxyLike,
  SchedulerAction,
  SchedulerApiLike,
  SchedulerEntry,
  ToolContext,
  ToolResult,
} from "../src/shared/types.js";

// ──────────────────────────────────────────────────────────────── logger ──

export interface TestLoggerEntry {
  level: LogLevel;
  msg: string;
  data?: Record<string, unknown>;
}

export interface TestLogger extends LoggerLike {
  entries: TestLoggerEntry[];
  levelEntries(level: LogLevel): TestLoggerEntry[];
}

export function createTestLogger(): TestLogger {
  const entries: TestLoggerEntry[] = [];
  const record =
    (level: LogLevel) =>
    (msg: string, data?: Record<string, unknown>): void => {
      if (data === undefined) entries.push({ level, msg });
      else entries.push({ level, msg, data });
    };
  const logger: TestLogger = {
    entries,
    levelEntries: (level: LogLevel) => entries.filter((entry) => entry.level === level),
    trace: record("trace"),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    child: () => logger,
    since: (_afterSeq: number, _limit?: number): LogEntry[] => [],
    subscribe: (_listener: (entry: LogEntry) => void): (() => void) => () => {},
  };
  return logger;
}

// ─────────────────────────────────────────────────────────── temp files ──

export interface TempDir {
  path: string;
  cleanup(): void;
}

export function createTempDir(prefix = "pulsar-scheduler-"): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup: (): void => {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

// ─────────────────────────────────────────────────────────────── fixtures ──

export function makeEntry(
  id: string,
  at: number,
  action: SchedulerAction = { kind: "announce", text: id },
  label = `task ${id}`,
): SchedulerEntry {
  return { id, at, label, action, createdAt: at - 1_000 };
}

export function createTestHa() {
  return {
    callService: vi.fn(async (_request: HaCallServiceRequest): Promise<void> => undefined),
    getState: vi.fn(async (_entityId: string): Promise<HaState | null> => null),
    listStates: vi.fn(async (_domain?: string): Promise<HaState[]> => []),
    listEntities: vi.fn(
      async (_filter?: { domain?: string; query?: string; areaId?: string }): Promise<HaEntity[]> => [],
    ),
    listAreas: vi.fn(async (): Promise<HaArea[]> => []),
    listServices: vi.fn(async (): Promise<Array<{ domain: string; service: string }>> => []),
    available: vi.fn(async (): Promise<boolean> => true),
  } satisfies HaClientLike;
}

export function createTestMcp() {
  return {
    callTool: vi.fn(
      async (
        _namespacedName: string,
        _args: Record<string, unknown>,
        _signal?: AbortSignal,
      ): Promise<ToolResult> => ({ ok: true }),
    ),
  } satisfies McpToolProxyLike;
}

export function createTestSchedulerApi() {
  return {
    addOnce: vi.fn(
      async (input: Parameters<SchedulerApiLike["addOnce"]>[0]): Promise<{ id: string; at: number }> => ({
        id: "sched_test",
        at: input.at,
      }),
    ),
    cancel: vi.fn(async (_idOrAll: string): Promise<{ cancelled: number }> => ({ cancelled: 1 })),
    list: vi.fn(async (): Promise<SchedulerEntry[]> => []),
  } satisfies SchedulerApiLike;
}

export interface TestConfigOptions {
  schedulerEnabled?: boolean;
  maxActive?: number;
}

export function createTestConfig(options: TestConfigOptions = {}): AppConfig {
  return {
    version: 1,
    logLevel: "info",
    provider: {
      id: "mock",
      openai: {
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "test",
        model: "test-model",
        temperature: 0.2,
        maxTokens: 1024,
        extraHeaders: {},
      },
      openclaw: {
        baseUrl: "http://127.0.0.1:1",
        apiKey: "test",
        agentId: "test",
        model: "test-model",
      },
      geminiLive: {
        apiKey: "test",
        model: "test-model",
        voice: "test",
        responseModality: "TEXT",
      },
      mock: { mode: "smart", scriptFile: "" },
    },
    stt: {
      provider: "wyoming",
      host: "127.0.0.1",
      port: 10300,
      language: "ru",
      model: "auto",
      endpointing: {
        silenceThresholdDb: -45,
        sentenceSilenceMs: 700,
        minSpeechMs: 250,
        maxUtteranceMs: 15_000,
        preRollMs: 300,
      },
    },
    tts: {
      mode: "auto",
      piper: { host: "127.0.0.1", port: 10200, voice: "ru_RU-irina-medium" },
      provider: { model: "tts-1", voice: "alloy", format: "wav", language: "ru" },
      outputSampleRate: 16_000,
    },
    prompt: { system: "", language: "ru" },
    conversation: {
      maxHistoryTurns: 12,
      followUpTimeoutMs: 5_000,
      bargeIn: true,
      llmMaxToolIterations: 6,
      requestTimeoutMs: 30_000,
    },
    tools: {
      ha: { enabled: true, url: "", token: "" },
      scheduler: {
        enabled: options.schedulerEnabled ?? true,
        maxActive: options.maxActive ?? 8,
        confirmBeforeSchedule: true,
      },
      mcp: { servers: [] },
    },
    aliases: {},
  };
}

export interface TestContextOptions {
  scheduler?: ReturnType<typeof createTestSchedulerApi>;
  ha?: ReturnType<typeof createTestHa>;
  mcp?: ReturnType<typeof createTestMcp>;
  log?: TestLogger;
  config?: AppConfig;
  runId?: string;
}

export function createTestContext(options: TestContextOptions = {}): ToolContext {
  return {
    runId: options.runId ?? "run-test",
    ha: options.ha ?? createTestHa(),
    scheduler: options.scheduler ?? createTestSchedulerApi(),
    mcp: options.mcp ?? createTestMcp(),
    log: options.log ?? createTestLogger(),
    config: options.config ?? createTestConfig(),
  };
}
