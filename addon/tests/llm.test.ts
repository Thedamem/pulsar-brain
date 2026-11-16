/**
 * Unit tests for addon-llm: mock scenarios, prompt assembly, brain tool loop, OpenAI-compatible
 * HTTP client (local server), OpenClaw adapter and the Gemini Live message parser.
 * No external network and no API keys are used.
 */

import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

import type {
  AppConfig,
  BrainLike,
  BrainRequest,
  ChatMessage,
  ConfigStoreLike,
  HaClientLike,
  LoggerLike,
  McpToolProxyLike,
  ProviderContext,
  ProviderLike,
  ProviderRegistryLike,
  ProviderReply,
  SchedulerApiLike,
  ToolCall,
  ToolRegistryLike,
  ToolResult,
  ToolSpec,
} from "../src/shared/types.js";
import { createBrain } from "../src/brain/orchestrator.js";
import { buildSystemPrompt } from "../src/brain/prompt.js";
import {
  GEMINI_LIVE_CAPABILITIES,
  buildLiveTurns,
  buildRealtimeAudioInput,
  buildSetupMessage,
  createGeminiLiveProvider,
  parseGeminiServerMessage,
  resamplePcm16,
  type GeminiServerEvent,
  type LiveTurn,
} from "../src/llm/gemini-live.js";
import { createMockProvider, planMockTurn, type MockTurnPlan } from "../src/llm/mock.js";
import { createOpenAiProvider } from "../src/llm/openai.js";
import { createOpenClawProvider } from "../src/llm/openclaw.js";
import { createProviderRegistry } from "../src/llm/registry.js";

// ───────────────────────────────────────────────────────────────────── config ──

interface ConfigPatch {
  providerId?: AppConfig["provider"]["id"];
  aliases?: Record<string, string>;
  promptSystem?: string;
  promptLanguage?: string;
  maxHistoryTurns?: number;
  llmMaxToolIterations?: number;
  requestTimeoutMs?: number;
  mockMode?: AppConfig["provider"]["mock"]["mode"];
  mockScriptFile?: string;
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  openaiExtraHeaders?: Record<string, string>;
  openclawBaseUrl?: string;
  openclawApiKey?: string;
  openclawAgentId?: string;
  openclawModel?: string;
  geminiApiKey?: string;
  geminiModel?: string;
}

function makeConfig(patch: ConfigPatch = {}): AppConfig {
  return {
    version: 1,
    logLevel: "error",
    provider: {
      id: patch.providerId ?? "mock",
      openai: {
        baseUrl: patch.openaiBaseUrl ?? "http://127.0.0.1:1/v1",
        apiKey: patch.openaiApiKey ?? "",
        model: patch.openaiModel ?? "test-model",
        temperature: 0.2,
        maxTokens: 256,
        extraHeaders: patch.openaiExtraHeaders ?? {},
      },
      openclaw: {
        baseUrl: patch.openclawBaseUrl ?? "http://127.0.0.1:1",
        apiKey: patch.openclawApiKey ?? "",
        agentId: patch.openclawAgentId ?? "",
        model: patch.openclawModel ?? "openclaw/default",
      },
      geminiLive: {
        apiKey: patch.geminiApiKey ?? "",
        model: patch.geminiModel ?? "gemini-3.8-live",
        voice: "Puck",
        responseModality: "AUDIO",
      },
      mock: {
        mode: patch.mockMode ?? "smart",
        scriptFile: patch.mockScriptFile ?? "",
      },
    },
    stt: {
      provider: "wyoming",
      host: "127.0.0.1",
      port: 10_300,
      language: "ru",
      model: "auto",
      endpointing: {
        silenceThresholdDb: -40,
        sentenceSilenceMs: 700,
        minSpeechMs: 300,
        maxUtteranceMs: 15_000,
        preRollMs: 300,
      },
    },
    tts: {
      mode: "piper",
      piper: { host: "127.0.0.1", port: 10_200, voice: "ru_RU-irina-medium" },
      provider: { model: "gpt-4o-mini-tts", voice: "alloy", format: "wav", language: "ru" },
      outputSampleRate: 16_000,
    },
    prompt: { system: patch.promptSystem ?? "", language: patch.promptLanguage ?? "ru" },
    conversation: {
      maxHistoryTurns: patch.maxHistoryTurns ?? 6,
      followUpTimeoutMs: 5_000,
      bargeIn: true,
      llmMaxToolIterations: patch.llmMaxToolIterations ?? 3,
      requestTimeoutMs: patch.requestTimeoutMs ?? 5_000,
    },
    tools: {
      ha: { enabled: true, url: "", token: "" },
      scheduler: { enabled: true, maxActive: 50, confirmBeforeSchedule: false },
      mcp: { servers: [] },
    },
    aliases: patch.aliases ?? {},
  };
}

// ──────────────────────────────────────────────────────────────────── fakes ──

function createSilentLogger(): LoggerLike {
  const logger: LoggerLike = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
    since: () => [],
    subscribe: () => () => {},
  };
  return logger;
}

function createFakeConfigStore(config: AppConfig): ConfigStoreLike {
  return {
    get: () => config,
    update: async () => config,
    masked: () => config,
    onChange: () => () => {},
    bridgeToken: () => "test-bridge-token",
  };
}

const fakeHa: HaClientLike = {
  callService: async () => {},
  getState: async () => null,
  listStates: async () => [],
  listEntities: async () => [],
  listAreas: async () => [],
  listServices: async () => [],
  available: async () => true,
};

const fakeScheduler: SchedulerApiLike = {
  addOnce: async (input) => ({ id: "schedule-1", at: input.at }),
  cancel: async () => ({ cancelled: 0 }),
  list: async () => [],
};

const fakeMcp: McpToolProxyLike = {
  callTool: async () => ({ ok: true }),
};

function allToolSpecs(): ToolSpec[] {
  return [
    "ha.call_service",
    "ha.get_state",
    "ha.list_entities",
    "scheduler.add_once",
    "scheduler.cancel",
    "scheduler.add_recurring",
  ].map((name) => ({ name, description: name, parameters: { type: "object", properties: {} } }));
}

function makeRequest(text: string, signal: AbortSignal = new AbortController().signal): BrainRequest {
  return { text, runId: "run-test-1", signal };
}

function createFakeProvider(registry: ProviderLike): ProviderRegistryLike {
  return {
    list: () => [{ id: registry.id, label: registry.label, capabilities: registry.capabilities }],
    get: () => registry,
  };
}

function createTestProvider(generate: (ctx: ProviderContext) => Promise<ProviderReply>): ProviderLike {
  return {
    id: "mock",
    label: "Test provider",
    capabilities: { streaming: true, tools: true, nativeAudio: false, tts: false, models: false },
    health: async () => ({ ok: true, detail: "test provider" }),
    listModels: async () => [],
    generate,
  };
}

function createBrainWith(
  provider: ProviderLike,
  config: AppConfig,
  specs: readonly ToolSpec[] = allToolSpecs(),
  executeTool: (call: ToolCall) => ToolResult | Promise<ToolResult> = () => ({ ok: true }),
): BrainLike {
  const tools: ToolRegistryLike = {
    specs: () => [...specs],
    get: () => undefined,
    execute: async (call) => executeTool(call),
    register: () => {},
    removeByPrefix: () => 0,
  };
  return createBrain({
    configStore: createFakeConfigStore(config),
    providers: createFakeProvider(provider),
    tools,
    ha: fakeHa,
    scheduler: fakeScheduler,
    mcp: fakeMcp,
    log: createSilentLogger(),
  });
}

interface BrainFixtureOptions {
  replies: readonly ProviderReply[];
  config?: AppConfig;
  specs?: readonly ToolSpec[];
  executeTool?: (call: ToolCall) => ToolResult | Promise<ToolResult>;
}

interface BrainFixture {
  brain: BrainLike;
  contexts: ProviderContext[];
  executedCalls: ToolCall[];
}

function createBrainFixture(options: BrainFixtureOptions): BrainFixture {
  const contexts: ProviderContext[] = [];
  const executedCalls: ToolCall[] = [];
  let replyIndex = 0;
  const provider = createTestProvider(async (ctx) => {
    contexts.push(ctx);
    ctx.onDelta?.("rx");
    const reply = options.replies[Math.min(replyIndex, options.replies.length - 1)];
    replyIndex += 1;
    if (reply === undefined) throw new Error("test fixture has no provider replies");
    return reply;
  });
  const config = options.config ?? makeConfig();
  const specs = options.specs ?? allToolSpecs();
  const executeTool = options.executeTool;
  const brain = createBrainWith(provider, config, specs, (call) => {
    executedCalls.push(call);
    return executeTool === undefined ? { ok: true } : executeTool(call);
  });
  return { brain, contexts, executedCalls };
}

function toolCallReply(name: string, id = "call_1"): ProviderReply {
  return { text: "", speech: "", toolCalls: [{ id, name, argumentsJson: "{}" }], finish: "tool_calls" };
}

function stopReply(text: string): ProviderReply {
  return { text, speech: text, toolCalls: [], finish: "stop" };
}

function toolMessage(name: string, content: Record<string, unknown>, id = `call_${name}`): ChatMessage {
  return { role: "tool", content: JSON.stringify(content), toolName: name, toolCallId: id };
}

// ───────────────────────────────────────────────────────────────── json access ──

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected a JSON object");
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected a JSON array");
  return value;
}

function parseJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

function parseArguments(call: ToolCall): Record<string, unknown> {
  return asRecord(parseJson(call.argumentsJson));
}

function firstToolCall(plan: MockTurnPlan): ToolCall {
  const call = plan.toolCalls[0];
  if (call === undefined) throw new Error("expected a tool call in the mock plan");
  return call;
}

const FIXED_NOW = Date.UTC(2026, 10, 16, 8, 36); // 11:36 Europe/Moscow, Monday

// ══════════════════════════════════════════════════════════════════ mock provider ══

describe("mock provider: smart scenarios", () => {
  it("turns the light on with a canonical ha.call_service tool call", () => {
    const plan = planMockTurn([{ role: "user", content: "включи свет" }], allToolSpecs(), { now: FIXED_NOW });
    expect(plan.finish).toBe("tool_calls");
    expect(plan.toolCalls).toHaveLength(1);
    const call = firstToolCall(plan);
    expect(call.name).toBe("ha.call_service");
    expect(parseArguments(call)).toEqual({ domain: "light", service: "turn_on", entity_id: "light.kitchen" });
  });

  it("resolves the entity from aliases (longest phrase wins) and turns it off", () => {
    const aliases = { свет: "light.living_room", "свет на кухне": "light.kitchen" };
    const plan = planMockTurn([{ role: "user", content: "выключи свет на кухне" }], allToolSpecs(), {
      now: FIXED_NOW,
      aliases,
    });
    expect(parseArguments(firstToolCall(plan))).toEqual({
      domain: "light",
      service: "turn_off",
      entity_id: "light.kitchen",
    });
  });

  it("returns two tool calls for two actions in one phrase", () => {
    const plan = planMockTurn([{ role: "user", content: "включи свет и телевизор" }], allToolSpecs(), { now: FIXED_NOW });
    expect(plan.toolCalls).toHaveLength(2);
    const [lightCall, tvCall] = plan.toolCalls;
    if (lightCall === undefined || tvCall === undefined) throw new Error("expected two tool calls");
    expect(parseArguments(lightCall)).toEqual({ domain: "light", service: "turn_on", entity_id: "light.kitchen" });
    expect(parseArguments(tvCall)).toEqual({ domain: "switch", service: "turn_on", entity_id: "switch.tv" });
    expect(lightCall.id).not.toBe(tvCall.id);
  });

  it("schedules turn-off 10 minutes later after the turn-on tool result", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "включи свет на 10 минут" }];
    const first = planMockTurn(messages, allToolSpecs(), { now: FIXED_NOW });
    expect(parseArguments(firstToolCall(first)).service).toBe("turn_on");
    messages.push({ role: "assistant", content: "", toolCalls: first.toolCalls });
    messages.push(toolMessage("ha.call_service", { ok: true }));

    const second = planMockTurn(messages, allToolSpecs(), { now: FIXED_NOW });
    const scheduleCall = firstToolCall(second);
    expect(scheduleCall.name).toBe("scheduler.add_once");
    const args = parseArguments(scheduleCall);
    expect(args.in_seconds).toBe(600);
    expect(args.at).toBeUndefined();
    expect(args.action).toEqual({
      kind: "ha.call_service",
      request: { domain: "light", service: "turn_off", entity_id: "light.kitchen" },
    });

    messages.push({ role: "assistant", content: "", toolCalls: second.toolCalls });
    messages.push(toolMessage("scheduler.add_once", { ok: true }));
    const final = planMockTurn(messages, allToolSpecs(), { now: FIXED_NOW });
    expect(final.toolCalls).toHaveLength(0);
    expect(final.finish).toBe("stop");
    expect(final.text).toContain("10 минут");
  });

  it("schedules an absolute action for the next 22:00", () => {
    const plan = planMockTurn([{ role: "user", content: "выключи свет в 22:00" }], allToolSpecs(), { now: FIXED_NOW });
    const args = parseArguments(firstToolCall(plan));
    expect(args.at).toBe("2026-11-16T22:00:00+03:00");
    expect(args.in_seconds).toBeUndefined();
    expect(args.action).toEqual({
      kind: "ha.call_service",
      request: { domain: "light", service: "turn_off", entity_id: "light.kitchen" },
    });
  });

  it("rolls the absolute time to tomorrow when 22:00 already passed", () => {
    const now = Date.UTC(2026, 10, 16, 20, 0); // 23:00 Europe/Moscow
    const plan = planMockTurn([{ role: "user", content: "выключи свет в 22:00" }], allToolSpecs(), { now });
    expect(parseArguments(firstToolCall(plan)).at).toBe("2026-11-17T22:00:00+03:00");
  });

  it("cancels all scheduled actions on 'отмени'", () => {
    const plan = planMockTurn([{ role: "user", content: "отмени" }], allToolSpecs(), { now: FIXED_NOW });
    const call = firstToolCall(plan);
    expect(call.name).toBe("scheduler.cancel");
    expect(parseArguments(call)).toEqual({ id: "all" });
  });

  it("creates a recurring action for 'каждый день в 8 включи свет'", () => {
    const userText = "каждый день в 8 включи свет";
    const plan = planMockTurn([{ role: "user", content: userText }], allToolSpecs(), { now: FIXED_NOW });
    const call = firstToolCall(plan);
    expect(call.name).toBe("scheduler.add_recurring");
    const args = parseArguments(call);
    expect(args.phrase).toBe(userText);
    expect(args.action).toEqual({
      kind: "ha.call_service",
      request: { domain: "light", service: "turn_on", entity_id: "light.kitchen" },
    });
    const afterOk = planMockTurn(
      [{ role: "user", content: userText }, toolMessage("scheduler.add_recurring", { ok: true })],
      allToolSpecs(),
      { now: FIXED_NOW },
    );
    expect(afterOk.text.toLocaleLowerCase("ru")).toContain("создано");
    const afterFailure = planMockTurn(
      [{ role: "user", content: userText }, toolMessage("scheduler.add_recurring", { ok: false, error: "bad schedule" })],
      allToolSpecs(),
      { now: FIXED_NOW },
    );
    expect(afterFailure.text).toContain("Скажите точнее");
  });

  it("answers questions without tool calls", () => {
    const time = planMockTurn([{ role: "user", content: "который час" }], allToolSpecs(), { now: FIXED_NOW });
    expect(time.toolCalls).toHaveLength(0);
    expect(time.finish).toBe("stop");
    expect(time.text).toBe("Сейчас 11:36.");

    for (const question of ["что ты умеешь", "погода", "привет", "свари кофе"]) {
      const plan = planMockTurn([{ role: "user", content: question }], allToolSpecs(), { now: FIXED_NOW });
      expect(plan.toolCalls).toHaveLength(0);
      expect(plan.finish).toBe("stop");
      expect(plan.text.length).toBeGreaterThan(0);
    }
  });

  it("confirms a successful tool result and reports failures", () => {
    const ok = planMockTurn(
      [{ role: "user", content: "включи свет" }, toolMessage("ha.call_service", { ok: true })],
      allToolSpecs(),
      { now: FIXED_NOW },
    );
    expect(ok.toolCalls).toHaveLength(0);
    expect(ok.text).toMatch(/Готово|Включила/);

    const failed = planMockTurn(
      [{ role: "user", content: "включи свет" }, toolMessage("ha.call_service", { ok: false, error: "Свет не отвечает" })],
      allToolSpecs(),
      { now: FIXED_NOW },
    );
    expect(failed.text.startsWith("Не получилось:")).toBe(true);
    expect(failed.text).toContain("Свет не отвечает");
  });

  it("does not call tools that the registry does not provide", () => {
    const plan = planMockTurn([{ role: "user", content: "включи свет" }], [], { now: FIXED_NOW });
    expect(plan.toolCalls).toHaveLength(0);
    expect(plan.text.length).toBeGreaterThan(0);
  });

  it("resolves a follow-up verb to the light from the previous turn", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "Алиса, включи свет" },
      { role: "assistant", content: "Включила свет." },
      { role: "user", content: "А теперь выключи" },
    ];
    const plan = planMockTurn(history, allToolSpecs(), { now: FIXED_NOW });
    const call = firstToolCall(plan);
    expect(call.name).toBe("ha.call_service");
    expect(parseArguments(call)).toEqual({ domain: "light", service: "turn_off", entity_id: "light.kitchen" });
  });

  it("resolves a follow-up verb to the TV from the previous turn", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "включи телевизор" },
      { role: "assistant", content: "Включила телевизор." },
      { role: "user", content: "а теперь выключи" },
    ];
    const plan = planMockTurn(history, allToolSpecs(), { now: FIXED_NOW });
    expect(parseArguments(firstToolCall(plan))).toEqual({
      domain: "switch",
      service: "turn_off",
      entity_id: "switch.tv",
    });
  });

  it("prefers a recorded successful ha.call_service tool call for the follow-up device", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "включи свет" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: "ha.call_service",
            argumentsJson: '{"domain":"light","service":"turn_on","entity_id":"light.kitchen"}',
          },
        ],
      },
      toolMessage("ha.call_service", { ok: true }, "call_1"),
      { role: "user", content: "а теперь выключи" },
    ];
    const plan = planMockTurn(history, allToolSpecs(), { now: FIXED_NOW });
    expect(parseArguments(firstToolCall(plan))).toEqual({
      domain: "light",
      service: "turn_off",
      entity_id: "light.kitchen",
    });
  });

  it("keeps the clarifying question when the history has no device", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "привет" },
      { role: "assistant", content: "Здравствуйте. Слушаю." },
      { role: "user", content: "а теперь выключи" },
    ];
    const plan = planMockTurn(history, allToolSpecs(), { now: FIXED_NOW });
    expect(plan.toolCalls).toHaveLength(0);
    expect(plan.text).toContain("Уточните");
  });

  it("does not reuse a device whose previous action failed", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "включи свет" },
      { role: "assistant", content: "Не получилось: Свет не отвечает." },
      { role: "user", content: "а теперь выключи" },
    ];
    const plan = planMockTurn(history, allToolSpecs(), { now: FIXED_NOW });
    expect(plan.toolCalls).toHaveLength(0);
    expect(plan.text).toContain("Уточните");
  });
});

describe("mock provider: modes and registry", () => {
  it("echo mode returns the input text", async () => {
    const provider = createMockProvider({ log: createSilentLogger() });
    const reply = await provider.generate({
      systemPrompt: "",
      history: [{ role: "user", content: "привет" }],
      tools: [],
      config: makeConfig({ mockMode: "echo" }),
      signal: new AbortController().signal,
    });
    expect(reply.text).toBe("привет");
    expect(reply.toolCalls).toHaveLength(0);
  });

  it("scripted mode replays steps from the data dir file", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulsar-llm-"));
    tempDirs.push(dataDir);
    await fs.writeFile(
      path.join(dataDir, "script.json"),
      JSON.stringify([
        {
          match: "^привет",
          reply: "Здравствуйте!",
          toolCalls: [
            { name: "ha.call_service", arguments: { domain: "light", service: "turn_on", entity_id: "light.kitchen" } },
          ],
        },
      ]),
    );
    const provider = createMockProvider({ log: createSilentLogger(), dataDir });
    const config = makeConfig({ mockMode: "scripted", mockScriptFile: "script.json" });
    const reply = await provider.generate({
      systemPrompt: "",
      history: [{ role: "user", content: "привет" }],
      tools: allToolSpecs(),
      config,
      signal: new AbortController().signal,
    });
    expect(reply.text).toBe("Здравствуйте!");
    expect(reply.finish).toBe("tool_calls");
    expect(parseArguments(firstToolCall({ ...reply, text: reply.text, speech: reply.speech }))).toEqual({
      domain: "light",
      service: "turn_on",
      entity_id: "light.kitchen",
    });

    const afterTools = await provider.generate({
      systemPrompt: "",
      history: [{ role: "user", content: "привет" }, toolMessage("ha.call_service", { ok: true })],
      tools: allToolSpecs(),
      config,
      signal: new AbortController().signal,
    });
    expect(afterTools.text).toBe("Готово.");
  });

  it("registry lists all providers and creates them lazily", () => {
    const registry = createProviderRegistry(makeConfig(), createSilentLogger());
    const listed = registry.list();
    expect(listed.map((provider) => provider.id).sort()).toEqual(["gemini-live", "mock", "openai", "openclaw"]);
    expect(listed.find((provider) => provider.id === "mock")?.capabilities.tools).toBe(true);
    const first = registry.get("mock");
    const second = registry.get("mock");
    expect(first.id).toBe("mock");
    expect(first).toBe(second);
    expect(registry.get("openai").capabilities.models).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════ system prompt ══

describe("system prompt", () => {
  it("contains the role, rules, aliases and current Moscow time", () => {
    const prompt = buildSystemPrompt(
      makeConfig({ aliases: { "свет на кухне": "light.kitchen" }, promptSystem: "Не шути." }),
      FIXED_NOW,
    );
    expect(prompt).toContain("голосовой ассистент умного дома");
    expect(prompt).toContain("«свет на кухне» → light.kitchen");
    expect(prompt).toContain("Текущие дата и время");
    expect(prompt).toContain("16 ноября 2026");
    expect(prompt).toContain("11:36");
    expect(prompt).toContain("Europe/Moscow");
    expect(prompt).toContain("Не шути.");
    expect(prompt).toContain("одно-два предложения");
  });

  it("explains that no aliases are configured", () => {
    const prompt = buildSystemPrompt(makeConfig(), FIXED_NOW);
    expect(prompt).toContain("Алиасы не настроены");
  });
});

// ════════════════════════════════════════════════════════════════════ brain loop ══

describe("brain orchestrator", () => {
  it("runs provider → tool → provider and keeps the turn in history", async () => {
    const fixture = createBrainFixture({
      replies: [toolCallReply("ha.call_service"), stopReply("Включила свет")],
      config: makeConfig({ aliases: { "свет на кухне": "light.kitchen" } }),
    });
    const deltas: string[] = [];
    const reply = await fixture.brain.respond({
      ...makeRequest("включи свет"),
      onDelta: (delta) => deltas.push(delta),
    });

    expect(fixture.executedCalls).toHaveLength(1);
    expect(fixture.executedCalls[0]?.name).toBe("ha.call_service");
    expect(fixture.contexts).toHaveLength(2);
    expect(reply.text).toBe("Включила свет");
    expect(reply.finish).toBe("stop");
    expect(reply.toolTraces).toHaveLength(1);
    expect(reply.toolTraces[0]?.call.id).toBe("call_1");
    expect(reply.toolTraces[0]?.result.ok).toBe(true);
    expect(deltas).toEqual(["rx", "rx"]);

    const firstPrompt = fixture.contexts[0]?.systemPrompt ?? "";
    expect(firstPrompt).toContain("«свет на кухне» → light.kitchen");
    const firstHistory = fixture.contexts[0]?.history ?? [];
    expect(firstHistory.at(-1)).toMatchObject({ role: "user", content: "включи свет" });
    const secondHistory = fixture.contexts[1]?.history ?? [];
    expect(secondHistory.some((message) => message.role === "tool" && message.toolName === "ha.call_service")).toBe(true);
    expect(
      secondHistory.some((message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) === 1),
    ).toBe(true);
    expect(fixture.brain.history().length).toBe(2);
  });

  it("stops at the tool iteration limit", async () => {
    const fixture = createBrainFixture({
      replies: [toolCallReply("ha.call_service")],
      config: makeConfig({ llmMaxToolIterations: 2 }),
    });
    const reply = await fixture.brain.respond(makeRequest("включи свет"));
    expect(fixture.contexts).toHaveLength(3);
    expect(fixture.executedCalls).toHaveLength(2);
    expect(reply.finish).toBe("stop");
    expect(reply.text.length).toBeGreaterThan(0);
  });

  it("survives a tool error and shows the reason to the model", async () => {
    const fixture = createBrainFixture({
      replies: [toolCallReply("ha.call_service"), stopReply("Не получилось: boom")],
      executeTool: () => ({ ok: false, error: "boom" }),
    });
    const reply = await fixture.brain.respond(makeRequest("включи свет"));
    expect(reply.finish).toBe("stop");
    expect(reply.text).toBe("Не получилось: boom");
    expect(reply.toolTraces[0]?.result.ok).toBe(false);
    expect(reply.toolTraces[0]?.result.error).toBe("boom");
    const secondHistory = fixture.contexts[1]?.history ?? [];
    const toolMessageInHistory = secondHistory.find((message) => message.role === "tool");
    expect(toolMessageInHistory).toBeDefined();
    expect(asRecord(parseJson(toolMessageInHistory?.content ?? "{}")).error).toBe("boom");
  });

  it("returns an error reply when the provider throws", async () => {
    const provider = createTestProvider(async () => {
      throw new Error("provider is down");
    });
    const brain = createBrainWith(provider, makeConfig());
    const reply = await brain.respond(makeRequest("включи свет"));
    expect(reply.finish).toBe("error");
    expect(reply.text).toBe("Не получилось получить ответ.");
  });

  it("aborts on request timeout", async () => {
    const provider = createTestProvider(
      (ctx) =>
        new Promise<ProviderReply>((_resolve, reject) => {
          const onAbort = (): void => reject(new Error("aborted"));
          if (ctx.signal.aborted) {
            onAbort();
            return;
          }
          ctx.signal.addEventListener("abort", onAbort, { once: true });
        }),
    );
    const brain = createBrainWith(provider, makeConfig({ requestTimeoutMs: 30 }));
    const reply = await brain.respond(makeRequest("включи свет"));
    expect(reply.finish).toBe("error");
    expect(reply.text).toBe("Не успела обработать запрос.");
  });

  it("reports cancellation when the caller aborts", async () => {
    const provider = createTestProvider(
      (ctx) =>
        new Promise<ProviderReply>((_resolve, reject) => {
          const onAbort = (): void => reject(new Error("aborted"));
          if (ctx.signal.aborted) {
            onAbort();
            return;
          }
          ctx.signal.addEventListener("abort", onAbort, { once: true });
        }),
    );
    const brain = createBrainWith(provider, makeConfig());
    const controller = new AbortController();
    const pending = brain.respond(makeRequest("включи свет", controller.signal));
    setTimeout(() => controller.abort(), 10);
    const reply = await pending;
    expect(reply.finish).toBe("cancelled");
  });

  it("trims history to maxHistoryTurns and resets the conversation", async () => {
    const fixture = createBrainFixture({
      replies: [stopReply("ответ раз"), stopReply("ответ два"), stopReply("ответ три"), stopReply("ответ четыре")],
      config: makeConfig({ maxHistoryTurns: 2 }),
    });
    await fixture.brain.respond(makeRequest("вопрос 1"));
    await fixture.brain.respond(makeRequest("вопрос 2"));
    await fixture.brain.respond(makeRequest("вопрос 3"));
    const trimmed = fixture.brain.history();
    expect(trimmed).toHaveLength(4);
    expect(trimmed[0]?.content).toBe("вопрос 2");
    expect(trimmed[3]?.content).toBe("ответ три");
    fixture.brain.newConversation();
    expect(fixture.brain.history()).toHaveLength(0);
    await fixture.brain.respond(makeRequest("вопрос 4"));
    expect(fixture.brain.history()).toHaveLength(2);
    fixture.brain.resetHistory();
    expect(fixture.brain.history()).toHaveLength(0);
  });

  it("falls back to the spoken text when the provider returns speech without text", async () => {
    const fixture = createBrainFixture({
      replies: [{ text: "", speech: "Скажу коротко", toolCalls: [], finish: "stop" }],
    });
    const reply = await fixture.brain.respond(makeRequest("вопрос"));
    expect(reply.text).toBe("Скажу коротко");
  });

  it("collects native audio exactly once (callback or reply.audio)", async () => {
    let audioCallback: Int16Array | undefined;
    const withCallback = createTestProvider(async (ctx) => {
      audioCallback = new Int16Array([1, 2]);
      ctx.onSpeechAudio?.(audioCallback);
      return { text: "Голосом", speech: "Голосом", toolCalls: [], finish: "stop", audio: [new Int16Array([3])] };
    });
    const callbackReply = await createBrainWith(withCallback, makeConfig()).respond(makeRequest("привет"));
    expect(callbackReply.audio).toHaveLength(1);
    expect(Array.from(callbackReply.audio[0] ?? [])).toEqual([1, 2]);

    const replyOnly = createTestProvider(async () => ({
      text: "Голосом",
      speech: "Голосом",
      toolCalls: [],
      finish: "stop",
      audio: [new Int16Array([3, 4])],
    }));
    const audioReply = await createBrainWith(replyOnly, makeConfig()).respond(makeRequest("привет"));
    expect(audioReply.audio).toHaveLength(1);
    expect(Array.from(audioReply.audio[0] ?? [])).toEqual([3, 4]);
  });

  it("runs the full mock → tool loop for an action and a timer", async () => {
    const provider = createMockProvider({ log: createSilentLogger() });
    const executed: ToolCall[] = [];
    const brain = createBrainWith(provider, makeConfig({ llmMaxToolIterations: 4 }), allToolSpecs(), (call) => {
      executed.push(call);
      return { ok: true };
    });
    const actionReply = await brain.respond(makeRequest("включи свет"));
    expect(actionReply.text).toBe("Включила свет.");
    expect(executed).toHaveLength(1);
    expect(parseArguments(executed[0] as ToolCall).service).toBe("turn_on");

    executed.length = 0;
    const timerReply = await brain.respond(makeRequest("включи свет на 10 минут"));
    expect(timerReply.text).toContain("10 минут");
    expect(executed.map((call) => call.name)).toEqual(["ha.call_service", "scheduler.add_once"]);
    expect(parseArguments(executed[1] as ToolCall).in_seconds).toBe(600);
  });
});

// ═══════════════════════════════════════════════════════════════ http test server ══

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface TestHttpServer {
  baseUrl: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

const openServers: TestHttpServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function startTestHttpServer(
  handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
): Promise<TestHttpServer> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
      handler(request, response, body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not get a port");
  const instance: TestHttpServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
  openServers.push(instance);
  return instance;
}

function writeSse(response: ServerResponse, events: readonly Record<string, unknown>[]): void {
  response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end("data: [DONE]\n\n");
}

const STREAM_EVENTS: ReadonlyArray<Record<string, unknown>> = [
  { choices: [{ delta: { role: "assistant", content: "При" } }] },
  { choices: [{ delta: { content: "вет" } }] },
  {
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: "call_1", type: "function", function: { name: "ha.call_service", arguments: '{"domain":' } },
          ],
        },
      },
    ],
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '"light","service":"turn_on"}' } }],
        },
      },
    ],
  },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
];

function requestBody(request: CapturedRequest | undefined): Record<string, unknown> {
  if (request === undefined) throw new Error("request was not captured");
  return asRecord(parseJson(request.body));
}

function makeOpenAiContext(config: AppConfig, history: ChatMessage[] = [{ role: "user", content: "включи свет" }]): ProviderContext {
  return {
    systemPrompt: "SYS",
    history,
    tools: [{ name: "ha.call_service", description: "Call a service", parameters: { type: "object", properties: {} } }],
    config,
    signal: new AbortController().signal,
  };
}

// ══════════════════════════════════════════════════════════════ openai provider ══

describe("openai provider", () => {
  it("streams text and tool calls, reports usage and sends a proper request", async () => {
    const server = await startTestHttpServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "test-model" }, { id: "other-model" }] }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        writeSse(response, STREAM_EVENTS);
        return;
      }
      response.writeHead(404);
      response.end("not found");
    });
    const provider = createOpenAiProvider({ log: createSilentLogger() });
    const config = makeConfig({
      openaiBaseUrl: `${server.baseUrl}/v1`,
      openaiApiKey: "sk-test-secret",
      openaiModel: "test-model",
      openaiExtraHeaders: { "X-Test-Extra": "yes" },
    });
    const deltas: string[] = [];
    const reply = await provider.generate({
      ...makeOpenAiContext(config),
      onDelta: (delta) => deltas.push(delta),
    });

    expect(reply.text).toBe("Привет");
    expect(reply.finish).toBe("tool_calls");
    expect(reply.toolCalls).toHaveLength(1);
    const call = reply.toolCalls[0];
    if (call === undefined) throw new Error("expected a tool call");
    expect(call.id).toBe("call_1");
    expect(call.name).toBe("ha.call_service");
    expect(parseArguments(call)).toEqual({ domain: "light", service: "turn_on" });
    expect(reply.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(deltas).toEqual(["При", "вет"]);

    const post = server.requests.find((request) => request.method === "POST");
    if (post === undefined) throw new Error("chat request was not captured");
    expect(post.headers.authorization).toBe("Bearer sk-test-secret");
    expect(post.headers["x-test-extra"]).toBe("yes");
    const body = requestBody(post);
    expect(body.model).toBe("test-model");
    expect(body.stream).toBe(true);
    expect(body.tool_choice).toBe("auto");
    expect(asRecord(body.stream_options).include_usage).toBe(true);
    const messages = asArray(body.messages);
    expect(asRecord(messages[0])).toMatchObject({ role: "system", content: "SYS" });
    expect(asRecord(messages[1])).toMatchObject({ role: "user", content: "включи свет" });
    const tools = asArray(body.tools);
    expect(asRecord(asRecord(tools[0]).function)).toMatchObject({ name: "ha.call_service" });

    const health = await provider.health(config);
    expect(health.ok).toBe(true);
    expect(health.detail).toContain("test-model");
    expect(await provider.listModels(config)).toEqual(["test-model", "other-model"]);
  });

  it("replays assistant tool calls and tool results in the OpenAI message format", async () => {
    const server = await startTestHttpServer((request, response) => {
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        writeSse(response, [{ choices: [{ delta: { content: "Готово" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);
        return;
      }
      response.writeHead(404);
      response.end("not found");
    });
    const provider = createOpenAiProvider({ log: createSilentLogger() });
    const history: ChatMessage[] = [
      { role: "user", content: "включи свет" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "ha.call_service", argumentsJson: '{"domain":"light"}' }],
      },
      { role: "tool", content: '{"ok":true}', toolCallId: "call_1", toolName: "ha.call_service" },
    ];
    const config = makeConfig({ openaiBaseUrl: `${server.baseUrl}/v1`, openaiApiKey: "sk-test", openaiModel: "test-model" });
    const reply = await provider.generate(makeOpenAiContext(config, history));
    expect(reply.text).toBe("Готово");
    expect(reply.finish).toBe("stop");
    const body = requestBody(server.requests[0]);
    const messages = asArray(body.messages);
    const assistant = messages.map(asRecord).find((message) => message.role === "assistant");
    expect(assistant?.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "ha.call_service", arguments: '{"domain":"light"}' } },
    ]);
    const tool = messages.map(asRecord).find((message) => message.role === "tool");
    expect(tool?.tool_call_id).toBe("call_1");
  });

  it("reports a readable 401 error without leaking the key", async () => {
    const server = await startTestHttpServer((_request, response) => {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Invalid API key" } }));
    });
    const provider = createOpenAiProvider({ log: createSilentLogger() });
    const config = makeConfig({
      openaiBaseUrl: `${server.baseUrl}/v1`,
      openaiApiKey: "sk-secret-401",
      openaiModel: "test-model",
    });
    const health = await provider.health(config);
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("401");
    expect(health.detail).not.toContain("sk-secret-401");
    const error = await provider.generate(makeOpenAiContext(config)).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("401");
    expect(message).toContain("Invalid API key");
    expect(message).not.toContain("sk-secret-401");
  });

  it("times out a hanging request", async () => {
    const server = await startTestHttpServer(() => {
      // Intentionally never respond: the client must abort by requestTimeoutMs.
    });
    const provider = createOpenAiProvider({ log: createSilentLogger() });
    const config = makeConfig({
      openaiBaseUrl: `${server.baseUrl}/v1`,
      openaiApiKey: "",
      openaiModel: "test-model",
      requestTimeoutMs: 40,
    });
    await expect(provider.generate(makeOpenAiContext(config))).rejects.toThrow(/timed out/i);
  });
});

// ═════════════════════════════════════════════════════════════ openclaw provider ══

describe("openclaw provider", () => {
  it("uses the /v1 OpenAI-compatible endpoint, bearer token and agent header", async () => {
    const server = await startTestHttpServer((request, response) => {
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        writeSse(response, [{ choices: [{ delta: { content: "ok" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);
        return;
      }
      response.writeHead(404);
      response.end("not found");
    });
    const provider = createOpenClawProvider({ log: createSilentLogger() });
    const rootConfig = makeConfig({
      openclawBaseUrl: server.baseUrl,
      openclawApiKey: "gateway-token",
      openclawAgentId: "agent-7",
      openclawModel: "openclaw/agent-7",
    });
    await provider.generate(makeOpenAiContext(rootConfig));
    await provider.generate(
      makeOpenAiContext(
        makeConfig({
          openclawBaseUrl: `${server.baseUrl}/v1`,
          openclawApiKey: "gateway-token",
          openclawAgentId: "agent-7",
          openclawModel: "openclaw/agent-7",
        }),
      ),
    );
    expect(server.requests.map((request) => request.url)).toEqual(["/v1/chat/completions", "/v1/chat/completions"]);
    const first = server.requests[0];
    if (first === undefined) throw new Error("chat request was not captured");
    expect(first.headers.authorization).toBe("Bearer gateway-token");
    expect(first.headers["x-openclaw-agent-id"]).toBe("agent-7");
    expect(requestBody(first).model).toBe("openclaw/agent-7");
  });

  it("reports an unconfigured base URL in health", async () => {
    const provider = createOpenClawProvider({ log: createSilentLogger() });
    const health = await provider.health(makeConfig({ openclawBaseUrl: "", openclawApiKey: "token" }));
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("base URL");
  });
});

// ═══════════════════════════════════════════════════════════════ gemini live ══

function encodePcm16(samples: readonly number[]): string {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => {
    buffer.writeInt16LE(sample, index * 2);
  });
  return buffer.toString("base64");
}

function findEvent<T extends GeminiServerEvent["type"]>(
  events: readonly GeminiServerEvent[],
  type: T,
): Extract<GeminiServerEvent, { type: T }> | undefined {
  return events.find((event): event is Extract<GeminiServerEvent, { type: T }> => event.type === type);
}

function turnPart(turns: readonly LiveTurn[], turnIndex: number, partIndex = 0): Record<string, unknown> {
  const turn = turns[turnIndex];
  if (turn === undefined) throw new Error(`turn ${turnIndex} is missing`);
  const part = turn.parts[partIndex];
  if (part === undefined) throw new Error(`turn ${turnIndex} has no part ${partIndex}`);
  return asRecord(part);
}

describe("gemini live", () => {
  it("parses serverContent with 24 kHz audio, transcription and interruption", () => {
    const pcm = encodePcm16([100, -100, 1000, -32_768]);
    const raw = JSON.stringify({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm } }, { text: "Привет" }],
        },
        outputTranscription: { text: "При" },
        interrupted: true,
        turnComplete: true,
      },
    });
    const events = parseGeminiServerMessage(raw);
    expect(events).not.toBeNull();
    const contentEvent = findEvent(events ?? [], "content");
    expect(contentEvent).toBeDefined();
    const content = contentEvent?.content;
    expect(content?.modelText).toBe("Привет");
    expect(content?.outputTranscription).toBe("При");
    expect(content?.interrupted).toBe(true);
    expect(content?.turnComplete).toBe(true);
    expect(content?.audio).toHaveLength(1);
    expect(content?.audio[0]?.sampleRate).toBe(24_000);
    expect(Array.from(content?.audio[0]?.data ?? [])).toEqual([100, -100, 1000, -32_768]);
    expect(resamplePcm16(content?.audio[0]?.data ?? new Int16Array(), 24_000, 16_000).length).toBe(2);
  });

  it("parses toolCall, setupComplete and usage messages", () => {
    const setup = parseGeminiServerMessage(JSON.stringify({ setupComplete: {} }));
    expect(setup).toEqual([{ type: "setupComplete" }]);

    const toolEvents = parseGeminiServerMessage(
      JSON.stringify({
        toolCall: { functionCalls: [{ id: "fc1", name: "ha.call_service", args: { domain: "light" } }] },
      }),
    );
    const toolEvent = findEvent(toolEvents ?? [], "toolCall");
    expect(toolEvent?.toolCalls).toHaveLength(1);
    const call = toolEvent?.toolCalls[0];
    if (call === undefined) throw new Error("expected a parsed tool call");
    expect(call.id).toBe("fc1");
    expect(call.name).toBe("ha.call_service");
    expect(parseArguments(call)).toEqual({ domain: "light" });

    const usageEvents = parseGeminiServerMessage(
      JSON.stringify({ usageMetadata: { promptTokenCount: 12, responseTokenCount: 7 } }),
    );
    const usage = findEvent(usageEvents ?? [], "usage");
    expect(usage?.inputTokens).toBe(12);
    expect(usage?.outputTokens).toBe(7);
  });

  it("returns null for non-JSON and an empty list for unknown JSON", () => {
    expect(parseGeminiServerMessage("not json")).toBeNull();
    expect(parseGeminiServerMessage(JSON.stringify({ unknownField: true }))).toEqual([]);
  });

  it("builds the setup frame with model prefix, voice and tool declarations", () => {
    const message = buildSetupMessage({
      model: "gemini-3.8-live",
      systemPrompt: "SYS",
      tools: [{ name: "ha.call_service", description: "Call", parameters: { type: "object", properties: {} } }],
      responseModality: "AUDIO",
      voice: "Puck",
    });
    const setup = asRecord(message.setup);
    expect(setup.model).toBe("models/gemini-3.8-live");
    expect(asRecord(setup.generationConfig).responseModalities).toEqual(["AUDIO"]);
    expect(
      asRecord(asRecord(asRecord(asRecord(asRecord(setup.generationConfig).speechConfig).voiceConfig).prebuiltVoiceConfig)).voiceName,
    ).toBe("Puck");
    expect(setup.outputAudioTranscription).toEqual({});
    const instructionParts = asArray(asRecord(setup.systemInstruction).parts);
    expect(asRecord(instructionParts[0]).text).toBe("SYS");
    const declarations = asArray(asRecord(asArray(setup.tools)[0]).functionDeclarations);
    expect(asRecord(declarations[0]).name).toBe("ha.call_service");

    const textMessage = buildSetupMessage({
      model: "models/gemini-3.8-live",
      systemPrompt: "SYS",
      tools: [],
      responseModality: "TEXT",
      voice: "Puck",
    });
    const textSetup = asRecord(textMessage.setup);
    expect(asRecord(textSetup.generationConfig).responseModalities).toEqual(["TEXT"]);
    expect(textSetup.outputAudioTranscription).toBeUndefined();
    expect(textSetup.tools).toBeUndefined();
  });

  it("maps history with tool calls and tool results to Live turns", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "включи свет" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "ha.call_service", argumentsJson: '{"domain":"light"}' }],
      },
      { role: "tool", content: '{"ok":true}', toolCallId: "call_1", toolName: "ha.call_service" },
    ];
    const turns = buildLiveTurns(history);
    expect(turns).toHaveLength(3);
    expect(turns[0]?.role).toBe("user");
    expect(turnPart(turns, 0).text).toBe("включи свет");
    expect(turns[1]?.role).toBe("model");
    const functionCall = asRecord(turnPart(turns, 1).functionCall);
    expect(functionCall.name).toBe("ha.call_service");
    expect(functionCall.args).toEqual({ domain: "light" });
    expect(turns[2]?.role).toBe("user");
    const functionResponse = asRecord(turnPart(turns, 2).functionResponse);
    expect(functionResponse.name).toBe("ha.call_service");
    expect(functionResponse.response).toEqual({ ok: true });
  });

  it("resamples 24 kHz PCM to 16 kHz and keeps the identity case", () => {
    const input = new Int16Array(2400);
    for (let index = 0; index < input.length; index += 1) input[index] = (index % 200) - 100;
    const resampled = resamplePcm16(input, 24_000, 16_000);
    expect(resampled.length).toBe(1600);
    expect(resamplePcm16(input, 16_000, 16_000)).toBe(input);
    const encoded = buildRealtimeAudioInput(new Int16Array([1, -1]));
    const audio = asRecord(asRecord(encoded.realtimeInput).audio);
    expect(audio.mimeType).toBe("audio/pcm;rate=16000");
    expect(Buffer.from(String(audio.data), "base64").length).toBe(4);
  });

  it("reports a missing API key in health without opening a session", async () => {
    const provider = createGeminiLiveProvider({ log: createSilentLogger() });
    const health = await provider.health(makeConfig({ geminiApiKey: "" }));
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("API key");
    expect(provider.capabilities).toEqual(GEMINI_LIVE_CAPABILITIES);
    await expect(provider.listModels(makeConfig({ geminiApiKey: "" }))).rejects.toThrow(/API key/);
  });
});
