/**
 * Shared fakes and helpers for addon-core tests.
 *
 * Fakes implement the interfaces from shared/types.ts only: tests never import other
 * module implementations, so core stays testable before the composition root exists.
 */

import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { WebSocket, type RawData } from "ws";
import { createConfigStore, type ConfigStore } from "../src/config/store.js";
import { createLogger, type Logger } from "../src/log/logger.js";
import { createHttpServer, type HttpServerOptions } from "../src/server/http.js";
import { BRIDGE_WS_PATH } from "../src/server/bridge.js";
import type {
  AppConfig,
  AppServices,
  BrainLike,
  BrainReply,
  BrainRequest,
  ChatMessage,
  HaArea,
  HaCallServiceRequest,
  HaClientLike,
  HaEntity,
  HaState,
  McpManagerLike,
  McpServerConfig,
  McpServerState,
  McpToolInfo,
  PcmFormat,
  ProviderCapabilities,
  ProviderContext,
  ProviderHealth,
  ProviderLike,
  ProviderRegistryLike,
  ProviderReply,
  RunEndReason,
  RunHandleLike,
  RunRequest,
  SchedulerAction,
  SchedulerEntry,
  SchedulerServiceLike,
  SessionManagerLike,
  SessionRecord,
  SttLike,
  SttResult,
  SttSession,
  Tool,
  ToolCall,
  ToolContext,
  ToolRegistryLike,
  ToolResult,
  ToolSpec,
  TtsLike,
  Voice,
  WavEncoder,
} from "../src/shared/types.js";

// ───────────────────────────────────────────────────────────────── wav helper ──

/** Minimal RIFF/WAVE encoder used by tests (the audio module owns the real one). */
export function encodeWavPcm16(pcm: Int16Array, sampleRate = 16_000): Uint8Array {
  const dataBytes = pcm.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < pcm.length; index += 1) {
    buffer.writeInt16LE(pcm[index] ?? 0, 44 + index * 2);
  }
  return new Uint8Array(buffer);
}

// ─────────────────────────────────────────────────────────────── test context ──

export interface FakeCalls {
  haCallService: HaCallServiceRequest[];
  haListEntities: Array<{ domain?: string; query?: string; areaId?: string } | undefined>;
  providerHealth: number;
  providerModels: number;
  mcpTest: McpServerConfig[];
  mcpRefresh: number;
  schedulerAdd: Array<{ at: number; action: SchedulerAction; label: string; runId?: string }>;
  schedulerCancel: string[];
  schedulerRunNow: string[];
  brainRequests: BrainRequest[];
  brainNewConversation: number;
  ttsSynthesize: Array<{ text: string; voice?: string }>;
  sttTranscribe: Array<{ format: PcmFormat; samples: number }>;
  encodeWav: number;
}

export interface TestContextOptions {
  env?: NodeJS.ProcessEnv;
  sessions?: FakeSessions;
  schedulerRunNow?: boolean;
  brainReply?: Partial<BrainReply>;
}

export interface TestContext {
  services: AppServices;
  store: ConfigStore;
  logger: Logger;
  calls: FakeCalls;
  dataDir: string;
  cleanup(): Promise<void>;
}

export async function createTestContext(options: TestContextOptions = {}): Promise<TestContext> {
  const dataDir = await mkdtemp(join(tmpdir(), "pulsar-brain-core-"));
  const store = await createConfigStore({ dataDir, env: options.env ?? {} });
  const logger = createLogger({ level: "trace", write: () => undefined });
  const calls: FakeCalls = {
    haCallService: [],
    haListEntities: [],
    providerHealth: 0,
    providerModels: 0,
    mcpTest: [],
    mcpRefresh: 0,
    schedulerAdd: [],
    schedulerCancel: [],
    schedulerRunNow: [],
    brainRequests: [],
    brainNewConversation: 0,
    ttsSynthesize: [],
    sttTranscribe: [],
    encodeWav: 0,
  };
  const sessions = options.sessions ?? new FakeSessions([]);
  const services = buildFakeServices({ store, logger, calls, sessions, options });
  return {
    services,
    store,
    logger,
    calls,
    dataDir,
    async cleanup(): Promise<void> {
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function buildFakeServices(args: {
  store: ConfigStore;
  logger: Logger;
  calls: FakeCalls;
  sessions: FakeSessions;
  options: TestContextOptions;
}): AppServices {
  const { store, logger, calls, sessions, options } = args;
  const scheduler = new FakeScheduler(calls, options.schedulerRunNow === true);
  return {
    config: store,
    log: logger,
    ha: new FakeHa(calls),
    stt: new FakeStt(calls),
    tts: new FakeTts(calls),
    brain: new FakeBrain(calls, options.brainReply),
    providers: new FakeProviders(calls),
    tools: new FakeToolRegistry(),
    mcp: new FakeMcp(calls),
    refreshMcpTools: async (): Promise<void> => {
      calls.mcpRefresh += 1;
      await Promise.resolve();
    },
    scheduler,
    sessions,
    status: async () => {
      const entries = await scheduler.list();
      return {
        version: "0.1.0-test",
        uptimeSec: 1,
        bridge: { connected: false, lastRunAt: null },
        activeRuns: sessions.active(),
        health: {
          stt: { ok: true, detail: "fake stt" },
          tts: { ok: true, detail: "fake tts" },
          ha: { ok: true, detail: "fake ha" },
          provider: { ok: true, detail: "fake provider" },
          mcp: [],
        },
        scheduler: { active: entries.length, nextAt: null },
        configWarnings: [],
      };
    },
    encodeWav: ((pcm: Int16Array, format: PcmFormat): Uint8Array => {
      calls.encodeWav += 1;
      return encodeWavPcm16(pcm, format.sampleRate);
    }) satisfies WavEncoder,
    version: "0.1.0-test",
  };
}

// ───────────────────────────────────────────────────────────────────── ha fake ──

class FakeHa implements HaClientLike {
  constructor(private readonly calls: FakeCalls) {}

  async callService(request: HaCallServiceRequest): Promise<void> {
    this.calls.haCallService.push(request);
    await Promise.resolve();
  }

  async getState(_entityId: string): Promise<HaState | null> {
    await Promise.resolve();
    return null;
  }

  async listStates(_domain?: string): Promise<HaState[]> {
    await Promise.resolve();
    return [];
  }

  async listEntities(filter?: { domain?: string; query?: string; areaId?: string }): Promise<HaEntity[]> {
    this.calls.haListEntities.push(filter);
    const entities: HaEntity[] = [
      { entity_id: "light.kitchen", name: "Свет на кухне", domain: "light", state: "off", area_id: "kitchen" },
      { entity_id: "media_player.tv", name: "Телевизор", domain: "media_player", state: "idle" },
    ];
    await Promise.resolve();
    return entities.filter((entity) => filter?.domain === undefined || entity.domain === filter.domain);
  }

  async listAreas(): Promise<HaArea[]> {
    await Promise.resolve();
    return [{ area_id: "kitchen", name: "Кухня" }];
  }

  async listServices(): Promise<Array<{ domain: string; service: string }>> {
    await Promise.resolve();
    return [{ domain: "light", service: "turn_on" }];
  }

  async available(): Promise<boolean> {
    await Promise.resolve();
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────── stt fake ──

class FakeSttSession implements SttSession {
  write(_chunk: Int16Array): void {
    // Fake session accepts audio and ignores it.
  }

  async finish(): Promise<SttResult> {
    await Promise.resolve();
    return { text: "включи свет", language: "ru" };
  }

  cancel(): void {
    // Nothing to release in the fake session.
  }
}

class FakeStt implements SttLike {
  constructor(private readonly calls: FakeCalls) {}

  async transcribeStream(_format: PcmFormat, _language: string): Promise<SttSession> {
    await Promise.resolve();
    return new FakeSttSession();
  }

  async transcribe(format: PcmFormat, pcm: Int16Array): Promise<SttResult> {
    this.calls.sttTranscribe.push({ format, samples: pcm.length });
    await Promise.resolve();
    return { text: "включи свет", language: "ru" };
  }

  async health(): Promise<ProviderHealth> {
    await Promise.resolve();
    return { ok: true, detail: "fake wyoming whisper" };
  }
}

// ─────────────────────────────────────────────────────────────────── tts fake ──

class FakeTts implements TtsLike {
  constructor(private readonly calls: FakeCalls) {}

  async *synthesize(text: string, _signal: AbortSignal, voice?: string): AsyncIterable<Int16Array> {
    this.calls.ttsSynthesize.push({ text, ...(voice !== undefined ? { voice } : {}) });
    const samples = new Int16Array(320);
    for (let index = 0; index < samples.length; index += 1) samples[index] = (index % 64) * 100;
    yield samples.slice(0, 160);
    yield samples.slice(160);
    await Promise.resolve();
  }

  async listVoices(): Promise<Voice[]> {
    await Promise.resolve();
    return [{ id: "ru_RU-irina-medium", name: "Ирина (средний)", language: "ru" }];
  }

  async health(): Promise<ProviderHealth> {
    await Promise.resolve();
    return { ok: true, detail: "fake piper" };
  }
}

// ─────────────────────────────────────────────────────────────────── brain fake ──

class FakeBrain implements BrainLike {
  constructor(
    private readonly calls: FakeCalls,
    private readonly reply: Partial<BrainReply> = {},
  ) {}

  async respond(request: BrainRequest): Promise<BrainReply> {
    this.calls.brainRequests.push(request);
    await Promise.resolve();
    return {
      text: "Готово",
      speech: "Готово",
      toolTraces: [
        {
          call: { id: "call-1", name: "ha.call_service", argumentsJson: '{"domain":"light"}' },
          result: { ok: true, data: { service: "turn_on" } },
          durationMs: 1,
        },
      ],
      audio: [],
      finish: "stop",
      durationMs: 2,
      ...this.reply,
    };
  }

  newConversation(): void {
    this.calls.brainNewConversation += 1;
  }

  history(): ChatMessage[] {
    return [];
  }

  resetHistory(): void {
    this.calls.brainNewConversation = this.calls.brainNewConversation;
  }
}

// ─────────────────────────────────────────────────────────────── providers fake ──

class FakeProviders implements ProviderRegistryLike {
  constructor(private readonly calls: FakeCalls) {}

  list(): Array<{ id: ProviderLike["id"]; label: string; capabilities: ProviderCapabilities }> {
    return [
      {
        id: "mock",
        label: "Mock",
        capabilities: { streaming: false, tools: true, nativeAudio: false, tts: false, models: true },
      },
      {
        id: "openai",
        label: "OpenAI-совместимый",
        capabilities: { streaming: true, tools: true, nativeAudio: false, tts: true, models: true },
      },
    ];
  }

  get(id: ProviderLike["id"]): ProviderLike {
    const entry = this.list().find((provider) => provider.id === id);
    if (entry === undefined) throw new Error(`unknown provider ${id}`);
    return new FakeProvider(entry.id, entry.label, entry.capabilities, this.calls);
  }
}

class FakeProvider implements ProviderLike {
  constructor(
    readonly id: ProviderLike["id"],
    readonly label: string,
    readonly capabilities: ProviderCapabilities,
    private readonly calls: FakeCalls,
  ) {}

  async health(_config: AppConfig): Promise<ProviderHealth> {
    this.calls.providerHealth += 1;
    await Promise.resolve();
    return { ok: true, detail: "fake provider ok" };
  }

  async listModels(_config: AppConfig): Promise<string[]> {
    this.calls.providerModels += 1;
    await Promise.resolve();
    return ["gpt-4o-mini", "gpt-4o"];
  }

  async generate(_context: ProviderContext): Promise<ProviderReply> {
    await Promise.resolve();
    return { text: "", speech: "", toolCalls: [], finish: "stop" };
  }
}

// ───────────────────────────────────────────────────────────── tool registry fake ──

class FakeToolRegistry implements ToolRegistryLike {
  private readonly tools = new Map<string, Tool>();

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  async execute(_call: ToolCall, _ctx: ToolContext): Promise<ToolResult> {
    await Promise.resolve();
    return { ok: true, data: {} };
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  removeByPrefix(prefix: string): number {
    let removed = 0;
    for (const name of [...this.tools.keys()]) {
      if (name.startsWith(prefix)) {
        this.tools.delete(name);
        removed += 1;
      }
    }
    return removed;
  }
}

// ─────────────────────────────────────────────────────────────────── mcp fake ──

class FakeMcp implements McpManagerLike {
  private serverStates: McpServerState[] = [];

  constructor(private readonly calls: FakeCalls) {}

  async start(config: AppConfig): Promise<void> {
    this.syncStates(config);
    await Promise.resolve();
  }

  async reload(config: AppConfig): Promise<void> {
    this.syncStates(config);
    await Promise.resolve();
  }

  async stop(): Promise<void> {
    this.serverStates = [];
    await Promise.resolve();
  }

  states(): McpServerState[] {
    return this.serverStates;
  }

  tools(): McpToolInfo[] {
    return [];
  }

  async callTool(_name: string, _args: Record<string, unknown>, _signal?: AbortSignal): Promise<ToolResult> {
    await Promise.resolve();
    return { ok: true, data: {} };
  }

  async test(server: McpServerConfig): Promise<ProviderHealth> {
    this.calls.mcpTest.push(server);
    await Promise.resolve();
    return { ok: true, detail: "fake mcp ok" };
  }

  private syncStates(config: AppConfig): void {
    this.serverStates = config.tools.mcp.servers.map((server) => ({
      id: server.id,
      enabled: server.enabled,
      connected: true,
      error: "",
      tools: [],
    }));
  }
}

// ───────────────────────────────────────────────────────────── scheduler fake ──

class FakeScheduler implements SchedulerServiceLike {
  private entries: SchedulerEntry[] = [];
  private counter = 0;
  runNow?: (id: string) => Promise<{ ok: boolean; error?: string }>;

  constructor(
    private readonly calls: FakeCalls,
    withRunNow: boolean,
  ) {
    if (withRunNow) {
      this.runNow = async (id: string) => {
        this.calls.schedulerRunNow.push(id);
        await Promise.resolve();
        return { ok: true };
      };
    }
  }

  async start(): Promise<void> {
    await Promise.resolve();
  }

  async stop(): Promise<void> {
    this.entries = [];
    await Promise.resolve();
  }

  async addOnce(input: {
    at: number;
    action: SchedulerAction;
    label: string;
    runId?: string;
  }): Promise<{ id: string; at: number }> {
    this.counter += 1;
    const entry: SchedulerEntry = {
      id: `sched-${this.counter}`,
      at: input.at,
      label: input.label,
      action: input.action,
      createdAt: Date.now(),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
    };
    this.entries.push(entry);
    this.calls.schedulerAdd.push({
      at: input.at,
      action: input.action,
      label: input.label,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
    });
    await Promise.resolve();
    return { id: entry.id, at: entry.at };
  }

  async cancel(idOrAll: string): Promise<{ cancelled: number }> {
    this.calls.schedulerCancel.push(idOrAll);
    if (idOrAll === "all") {
      const count = this.entries.length;
      this.entries = [];
      await Promise.resolve();
      return { cancelled: count };
    }
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.id !== idOrAll);
    await Promise.resolve();
    return { cancelled: before - this.entries.length };
  }

  async list(): Promise<SchedulerEntry[]> {
    await Promise.resolve();
    return [...this.entries];
  }
}

// ───────────────────────────────────────────────────────────────── sessions fake ──

export class FakeRunHandle implements RunHandleLike {
  readonly audio: Int16Array[] = [];
  readonly texts: string[] = [];
  readonly vadHints: Array<"start" | "end"> = [];
  readonly cancels: RunEndReason[] = [];
  deviceStoppedCount = 0;

  constructor(readonly request: RunRequest) {}

  onAudio(chunk: Int16Array): void {
    this.audio.push(chunk);
  }

  onText(text: string): void {
    this.texts.push(text);
  }

  onVadHint(kind: "start" | "end"): void {
    this.vadHints.push(kind);
  }

  cancel(reason: RunEndReason): void {
    this.cancels.push(reason);
  }

  deviceStopped(): void {
    this.deviceStoppedCount += 1;
  }
}

export class FakeSessions implements SessionManagerLike {
  readonly runs: Array<{ request: RunRequest; handle: FakeRunHandle }> = [];
  private readonly records = new Map<string, SessionRecord>();

  constructor(fixtures: SessionRecord[] = []) {
    for (const record of fixtures) this.records.set(record.id, record);
  }

  startRun(request: RunRequest): RunHandleLike {
    const handle = new FakeRunHandle(request);
    this.runs.push({ request, handle });
    return handle;
  }

  active(): Array<{ runId: string; startedAt: number; state: string }> {
    return this.runs.map(({ request }) => ({
      runId: request.runId,
      startedAt: Date.now(),
      state: "running",
    }));
  }

  recent(limit: number): SessionRecord[] {
    return [...this.records.values()].slice(0, limit);
  }

  get(runId: string): SessionRecord | undefined {
    return this.records.get(runId);
  }

  addRecord(record: SessionRecord): void {
    this.records.set(record.id, record);
  }
}

export function makeSessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "run-fixture",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    device: { name: "Яндекс Станция Лайт 2", mac: "02:00:00:00:00:01", firmware: "pulsar 0.5.3" },
    transcript: "включи свет",
    response: "Готово",
    toolCalls: [{ name: "ha.call_service", args: "{}", ok: true }],
    state: "finished",
    endReason: "done",
    timings: { sttMs: 10, llmMs: 20, ttsMs: 30, totalMs: 60 },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────── http helpers ──

export interface TestHttpServer {
  app: FastifyInstance;
  baseUrl: string;
  /** ws:// URL of the bridge endpoint on this server. */
  bridgeUrl: string;
  token: string;
  close(): Promise<void>;
}

export async function startTestHttpServer(
  context: TestContext,
  options: HttpServerOptions = {},
): Promise<TestHttpServer> {
  const app = await createHttpServer({ services: context.services }, options);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo | null;
  if (address === null) throw new Error("HTTP server did not bind a port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    app,
    baseUrl,
    bridgeUrl: `ws://127.0.0.1:${address.port}${BRIDGE_WS_PATH}`,
    token: context.store.bridgeToken(),
    async close(): Promise<void> {
      await app.close();
    },
  };
}

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Defaults to the bridge token; pass null for anonymous requests. */
  token?: string | null;
}

export async function apiRequest(
  server: TestHttpServer,
  path: string,
  options: ApiRequestOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  const token = options.token === undefined ? server.token : options.token;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  let body: string | FormData | undefined;
  if (options.body !== undefined) {
    if (options.body instanceof FormData) {
      body = options.body;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
  }
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
    ...(body !== undefined ? { body } : {}),
  };
  return fetch(`${server.baseUrl}${path}`, init);
}

// ──────────────────────────────────────────────────────────────── ws helpers ──

export interface TrackedSocket {
  ws: WebSocket;
  /** JSON messages in arrival order. */
  json: unknown[];
  /** Binary frames in arrival order. */
  binary: Buffer[];
  until(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  waitForJson<T>(predicate: (message: unknown) => boolean, timeoutMs?: number): Promise<T>;
  closed: Promise<void>;
}

export function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(String(data));
}

export function trackSocket(ws: WebSocket): TrackedSocket {
  const json: unknown[] = [];
  const binary: Buffer[] = [];
  const waiters: Array<() => void> = [];
  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) binary.push(toBuffer(data));
    else json.push(JSON.parse(toBuffer(data).toString("utf8")) as unknown);
    for (const waiter of [...waiters]) waiter();
  });
  const until = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        const index = waiters.indexOf(attempt);
        if (index >= 0) waiters.splice(index, 1);
      };
      const attempt = (): void => {
        if (!predicate()) return;
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout waiting for WS condition; json=${JSON.stringify(json)}`));
      }, timeoutMs);
      waiters.push(attempt);
    });
  };
  const closed = new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
  });
  return {
    ws,
    json,
    binary,
    until,
    async waitForJson<T>(predicate: (message: unknown) => boolean, timeoutMs = 3000): Promise<T> {
      await until(() => json.some(predicate), timeoutMs);
      const found = json.find(predicate);
      if (found === undefined) throw new Error("message not found after wait");
      return found as T;
    },
    closed,
  };
}

export async function connectBridge(url: string, token: string | null): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    let settled = false;
    const headers: Record<string, string> = {};
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => {
      if (settled) return;
      settled = true;
      resolve(ws);
    });
    ws.once("unexpected-response", (_request, response) => {
      response.resume();
      if (settled) return;
      settled = true;
      const error = new Error(`bridge upgrade rejected: ${response.statusCode ?? 0}`);
      Object.assign(error, { statusCode: response.statusCode });
      reject(error);
    });
    ws.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

export function closeWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      ws.terminate();
      resolve();
    }, 500);
    timer.unref();
    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.close();
  });
}

export function jsonMessageType(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null || !("type" in message)) return undefined;
  const type = (message as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}
