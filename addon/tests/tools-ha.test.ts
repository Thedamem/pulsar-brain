/**
 * Unit tests for the Home Assistant tools module: HaClient REST behaviour,
 * the tool registry and the HA tool set. Everything runs against a local
 * node:http server that imitates HA Core REST.
 */

import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { HaError, createHaClient } from "../src/ha/client.js";
import { createHaTools, registerHaTools } from "../src/tools/ha.js";
import { createToolRegistry } from "../src/tools/registry.js";
import type {
  AppConfig,
  ConfigStoreLike,
  DeepPartial,
  HaClientLike,
  HaToolsConfig,
  LoggerLike,
  LogEntry,
  LogLevel,
  Tool,
  ToolContext,
  ToolRegistryLike,
  ToolResult,
} from "../src/shared/types.js";

// ─────────────────────────────────────────────────────── fake HA server ──

interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface FakeHaOptions {
  states?: unknown[];
  /** Number of initial GET /api/states responses answered with 500. */
  statesFailures?: number;
  /** Overrides the GET /api/states payload (for malformed-response tests). */
  statesBody?: unknown;
  services?: unknown[];
  areas?: { status: number; body?: unknown };
  rootStatus?: number;
  postStatus?: number;
}

interface FakeHa {
  baseUrl: string;
  requests: RecordedRequest[];
  posts(): RecordedRequest[];
  close(): Promise<void>;
}

const DEFAULT_STATES: unknown[] = [
  {
    entity_id: "light.kitchen",
    state: "on",
    attributes: { friendly_name: "Свет на кухне", brightness: 255 },
    last_changed: "2026-11-16T08:00:00+00:00",
  },
  { entity_id: "light.bedroom", state: "off", attributes: { friendly_name: "Свет в спальне" } },
  { entity_id: "switch.tv", state: "off", attributes: { friendly_name: "Телевизор" } },
  {
    entity_id: "sensor.temperature",
    state: "22.5",
    attributes: { friendly_name: "Температура", unit_of_measurement: "°C" },
  },
  {
    entity_id: "media_player.station",
    state: "idle",
    attributes: { friendly_name: "Станция", volume_level: 0.4 },
  },
];

const DEFAULT_SERVICES: unknown[] = [
  { domain: "light", services: { turn_on: { name: "Turn on" }, turn_off: { name: "Turn off" } } },
  { domain: "media_player", services: { play_media: { name: "Play media" } } },
];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (err) => reject(err));
  });
}

async function startFakeHa(options: FakeHaOptions = {}): Promise<FakeHa> {
  const requests: RecordedRequest[] = [];
  const states = options.states ?? DEFAULT_STATES;
  const services = options.services ?? DEFAULT_SERVICES;
  let statesFailuresLeft = options.statesFailures ?? 0;

  function send(res: ServerResponse, status: number, payload: unknown): void {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.setHeader("connection", "close");
    res.end(payload === undefined ? "" : JSON.stringify(payload));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake-ha");
    const body = req.method === "POST" ? await readBody(req) : "";
    requests.push({
      method: req.method ?? "GET",
      path: url.pathname,
      headers: req.headers,
      body,
    });

    if (url.pathname === "/api" || url.pathname === "/api/") {
      send(res, options.rootStatus ?? 200, { message: "API running." });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/states") {
      if (statesFailuresLeft > 0) {
        statesFailuresLeft -= 1;
        send(res, 500, { message: "boom" });
        return;
      }
      send(res, 200, options.statesBody ?? states);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/states/")) {
      const entityId = decodeURIComponent(url.pathname.slice("/api/states/".length));
      const match = states.find((item) => isRecord(item) && item.entity_id === entityId);
      send(res, match === undefined ? 404 : 200, match ?? { message: "Entity not found." });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/services") {
      send(res, 200, services);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/areas") {
      const areas = options.areas ?? { status: 404, body: { message: "Not found." } };
      send(res, areas.status, areas.body);
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/services/")) {
      send(res, options.postStatus ?? 200, []);
      return;
    }
    send(res, 404, { message: "Not found." });
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: err instanceof Error ? err.message : "fake HA failure" }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake HA server did not bind to a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    posts: () => requests.filter((request) => request.method === "POST"),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

// ─────────────────────────────────────────────────────── config / logger ──

function makeConfig(ha: Partial<HaToolsConfig> = {}): AppConfig {
  return {
    version: 1,
    logLevel: "info",
    provider: {
      id: "mock",
      openai: {
        baseUrl: "",
        apiKey: "",
        model: "",
        temperature: 0,
        maxTokens: 0,
        extraHeaders: {},
      },
      openclaw: { baseUrl: "", apiKey: "", agentId: "", model: "" },
      geminiLive: { apiKey: "", model: "", voice: "", responseModality: "TEXT" },
      mock: { mode: "smart", scriptFile: "" },
    },
    stt: {
      provider: "wyoming",
      host: "127.0.0.1",
      port: 10300,
      language: "ru",
      model: "auto",
      endpointing: {
        silenceThresholdDb: -40,
        sentenceSilenceMs: 700,
        minSpeechMs: 200,
        maxUtteranceMs: 15000,
        preRollMs: 300,
      },
    },
    tts: {
      mode: "piper",
      piper: { host: "127.0.0.1", port: 10200, voice: "ru_RU-irina-medium" },
      provider: { model: "gpt-4o-mini-tts", voice: "alloy", format: "wav", language: "ru" },
      outputSampleRate: 16000,
    },
    prompt: { system: "", language: "ru" },
    conversation: {
      maxHistoryTurns: 10,
      followUpTimeoutMs: 8000,
      bargeIn: true,
      llmMaxToolIterations: 6,
      requestTimeoutMs: 30000,
    },
    tools: {
      ha: { enabled: true, url: "", token: "", ...ha },
      scheduler: { enabled: false, maxActive: 0, confirmBeforeSchedule: false },
      mcp: { servers: [] },
    },
    aliases: {},
  };
}

function mergeValue(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (isRecord(base) && isRecord(patch)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      merged[key] = mergeValue(merged[key], value);
    }
    return merged;
  }
  return patch;
}

function createConfigStore(initial: AppConfig): ConfigStoreLike {
  let current = initial;
  const listeners = new Set<(config: AppConfig) => void>();
  return {
    get: () => current,
    update: async (patch: DeepPartial<AppConfig>) => {
      current = mergeValue(current, patch) as AppConfig;
      for (const listener of listeners) listener(current);
      return current;
    },
    masked: () => current,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    bridgeToken: () => "test-bridge-token",
  };
}

class TestLogger implements LoggerLike {
  readonly entries: LogEntry[];

  constructor(
    private readonly scope: string = "test",
    entries: LogEntry[] = [],
  ) {
    this.entries = entries;
  }

  trace(msg: string, data?: Record<string, unknown>): void {
    this.push("trace", msg, data);
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.push("debug", msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.push("info", msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.push("warn", msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.push("error", msg, data);
  }

  child(scope: string): LoggerLike {
    return new TestLogger(scope, this.entries);
  }

  since(afterSeq: number, limit = 200): LogEntry[] {
    return this.entries.filter((entry) => entry.seq > afterSeq).slice(0, limit);
  }

  subscribe(_listener: (entry: LogEntry) => void): () => void {
    return () => undefined;
  }

  private push(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    this.entries.push({
      seq: this.entries.length + 1,
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      msg,
      ...(data === undefined ? {} : { data }),
    });
  }
}

// ────────────────────────────────────────────────────────── helpers ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unusedHaClient(): HaClientLike {
  const notUsed = async (): Promise<never> => {
    throw new Error("HA client is not used in this test");
  };
  return {
    callService: notUsed,
    getState: notUsed,
    listStates: notUsed,
    listEntities: notUsed,
    listAreas: notUsed,
    listServices: notUsed,
    available: notUsed,
  };
}

function makeContext(config: AppConfig, ha: HaClientLike, log: LoggerLike): ToolContext {
  return {
    runId: "run-test",
    ha,
    scheduler: {
      addOnce: async () => ({ id: "schedule-1", at: 0 }),
      cancel: async () => ({ cancelled: 0 }),
      list: async () => [],
    },
    mcp: {
      callTool: async () => ({ ok: false, error: "MCP is not used in this test" }),
    },
    log,
    config,
  };
}

interface ClientFixture {
  fake: FakeHa;
  config: AppConfig;
  log: TestLogger;
  client: HaClientLike;
}

function makeClientFixture(
  fake: FakeHa,
  options: { token?: string; url?: string; log?: TestLogger } = {},
): ClientFixture {
  const config = makeConfig({
    enabled: true,
    url: options.url ?? fake.baseUrl,
    token: options.token ?? "test-token",
  });
  const store = createConfigStore(config);
  const log = options.log ?? new TestLogger();
  return { fake, config, log, client: createHaClient(store, log) };
}

interface RegistryFixture {
  registry: ToolRegistryLike;
  log: TestLogger;
  ctx: ToolContext;
}

const echoTool: Tool = {
  name: "test.echo",
  description: "Echo the text argument",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  async execute(args) {
    return { ok: true, data: { echoed: args.text } };
  },
};

function makeRegistryFixture(): RegistryFixture {
  const log = new TestLogger();
  const registry = createToolRegistry(log);
  registry.register(echoTool);
  const ctx = makeContext(makeConfig(), unusedHaClient(), log);
  return { registry, log, ctx };
}

interface HaToolsFixture {
  registry: ToolRegistryLike;
  log: TestLogger;
  ctx: ToolContext;
  token: string;
}

const HA_TOOL_NAMES = [
  "ha.call_service",
  "ha.get_state",
  "ha.list_entities",
  "media.play",
  "media.pause",
  "media.volume",
  "announce.say",
];

function makeHaToolsFixture(fake: FakeHa, options: { enabled?: boolean } = {}): HaToolsFixture {
  const token = "test-token";
  const config = makeConfig({ enabled: options.enabled ?? true, url: fake.baseUrl, token });
  const store = createConfigStore(config);
  const log = new TestLogger();
  const registry = createToolRegistry(log);
  registerHaTools(registry, store, log);
  const ctx = makeContext(config, createHaClient(store, log), log);
  return { registry, log, ctx, token };
}

function resultData(result: ToolResult): Record<string, unknown> {
  expect(result.ok).toBe(true);
  if (!isRecord(result.data)) {
    throw new Error(`unexpected tool result data: ${JSON.stringify(result.data)}`);
  }
  return result.data;
}

function resultEntities(result: ToolResult): Array<Record<string, unknown>> {
  const data = resultData(result);
  const entities = data.entities;
  if (!Array.isArray(entities)) {
    throw new Error("list_entities result has no entities array");
  }
  const resultEntities: Array<Record<string, unknown>> = [];
  for (const entity of entities) {
    if (!isRecord(entity)) throw new Error("list_entities returned a malformed entity");
    resultEntities.push(entity);
  }
  return resultEntities;
}

function lastPost(fake: FakeHa): RecordedRequest {
  const posts = fake.posts();
  const post = posts[posts.length - 1];
  if (post === undefined) throw new Error("expected an HA POST request");
  return post;
}

function postedBody(post: RecordedRequest): Record<string, unknown> {
  const parsed: unknown = JSON.parse(post.body);
  if (!isRecord(parsed)) throw new Error(`unexpected HA POST body: ${post.body}`);
  return parsed;
}

function executeTool(
  fixture: RegistryFixture | HaToolsFixture,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return fixture.registry.execute(
    { id: `call-${name}`, name, argumentsJson: JSON.stringify(args) },
    fixture.ctx,
  );
}

let fake: FakeHa | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (fake !== undefined) {
    await fake.close();
    fake = undefined;
  }
});

// ──────────────────────────────────────────────────────── HaClient tests ──

describe("ha client", () => {
  it("posts service target and data to /api/services/:domain/:service", async () => {
    fake = await startFakeHa();
    const { client } = makeClientFixture(fake);

    await client.callService({
      domain: "light",
      service: "turn_on",
      target: { entity_id: "light.kitchen" },
      data: { brightness: 128 },
    });

    expect(fake.posts()).toHaveLength(1);
    const post = lastPost(fake);
    expect(post.path).toBe("/api/services/light/turn_on");
    expect(post.headers.authorization).toBe("Bearer test-token");
    expect(postedBody(post)).toEqual({ brightness: 128, entity_id: "light.kitchen" });
  });

  it("keeps a list of entity ids in the service target", async () => {
    fake = await startFakeHa();
    const { client } = makeClientFixture(fake);

    await client.callService({
      domain: "light",
      service: "turn_on",
      target: { entity_id: ["light.kitchen", "light.bedroom"], area_id: "kitchen" },
    });

    expect(postedBody(lastPost(fake))).toEqual({
      entity_id: ["light.kitchen", "light.bedroom"],
      area_id: "kitchen",
    });
  });

  it("reads a state and maps 404 to null", async () => {
    fake = await startFakeHa();
    const { client } = makeClientFixture(fake);

    const state = await client.getState("light.kitchen");
    expect(state?.entity_id).toBe("light.kitchen");
    expect(state?.state).toBe("on");
    expect(state?.attributes.friendly_name).toBe("Свет на кухне");

    await expect(client.getState("light.missing")).resolves.toBeNull();
  });

  it("lists states filtered by domain", async () => {
    fake = await startFakeHa();
    const { client } = makeClientFixture(fake);

    const all = await client.listStates();
    expect(all).toHaveLength(5);

    const lights = await client.listStates("light");
    expect(lights.map((state) => state.entity_id)).toEqual(["light.kitchen", "light.bedroom"]);
  });

  it("lists entities filtered by domain, query and entity id", async () => {
    fake = await startFakeHa();
    const { client } = makeClientFixture(fake);

    const all = await client.listEntities();
    expect(all).toHaveLength(5);

    const lights = await client.listEntities({ domain: "light" });
    expect(lights.map((entity) => entity.entity_id)).toEqual(["light.kitchen", "light.bedroom"]);
    expect(lights[0]?.name).toBe("Свет на кухне");
    expect(lights[0]?.domain).toBe("light");

    const byName = await client.listEntities({ query: "кух" });
    expect(byName.map((entity) => entity.entity_id)).toEqual(["light.kitchen"]);

    const byEntityId = await client.listEntities({ query: "TEMPERATURE" });
    expect(byEntityId.map((entity) => entity.entity_id)).toEqual(["sensor.temperature"]);
  });

  it("returns an empty area list when HA REST has no area endpoint", async () => {
    fake = await startFakeHa();
    const { client } = makeClientFixture(fake);

    await expect(client.listAreas()).resolves.toEqual([]);
    expect(fake.requests.some((request) => request.path === "/api/areas")).toBe(true);
  });

  it("parses /api/areas when the endpoint exists", async () => {
    const areasFake = await startFakeHa({
      areas: {
        status: 200,
        body: [{ area_id: "kitchen", name: "Кухня" }],
      },
    });
    try {
      const { client } = makeClientFixture(areasFake);
      await expect(client.listAreas()).resolves.toEqual([{ area_id: "kitchen", name: "Кухня" }]);
    } finally {
      await areasFake.close();
    }
  });

  it("flattens services by domain", async () => {
    fake = await startFakeHa();
    const { client } = makeClientFixture(fake);

    const services = await client.listServices();
    expect(services).toHaveLength(3);
    expect(services).toContainEqual({ domain: "light", service: "turn_on" });
    expect(services).toContainEqual({ domain: "light", service: "turn_off" });
    expect(services).toContainEqual({ domain: "media_player", service: "play_media" });
  });

  it("retries a GET once on 5xx", async () => {
    fake = await startFakeHa({ statesFailures: 1 });
    const { client } = makeClientFixture(fake);

    await expect(client.listStates()).resolves.toHaveLength(5);
    const stateRequests = fake.requests.filter(
      (request) => request.method === "GET" && request.path === "/api/states",
    );
    expect(stateRequests).toHaveLength(2);
  });

  it("does not retry service POST calls", async () => {
    fake = await startFakeHa({ postStatus: 500 });
    const { client } = makeClientFixture(fake);

    await expect(
      client.callService({
        domain: "light",
        service: "turn_on",
        target: { entity_id: "light.kitchen" },
      }),
    ).rejects.toMatchObject({ name: "HaError", code: "http", status: 500 });
    expect(fake.posts()).toHaveLength(1);
  });

  it("fails with a clear error when the HA token is missing", async () => {
    vi.stubEnv("SUPERVISOR_TOKEN", "");
    fake = await startFakeHa();
    const { client } = makeClientFixture(fake, { token: "" });

    await expect(client.listStates()).rejects.toBeInstanceOf(HaError);
    await expect(client.listStates()).rejects.toThrow("HA token не настроен");
    await expect(client.available()).resolves.toBe(false);
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses to send SUPERVISOR_TOKEN to a custom HA URL", async () => {
    vi.stubEnv("SUPERVISOR_TOKEN", "supervisor-env-token");
    fake = await startFakeHa();
    const { client } = makeClientFixture(fake, { token: "" });

    await expect(client.listStates()).rejects.toMatchObject({ code: "unsafe_token_target" });
    expect(fake.requests).toHaveLength(0);
  });

  it("never writes the token to the logs", async () => {
    fake = await startFakeHa();
    const log = new TestLogger();
    const { client } = makeClientFixture(fake, { token: "secret-ha-token", log });

    await client.listStates();
    await client.callService({
      domain: "light",
      service: "turn_on",
      target: { entity_id: "light.kitchen" },
    });

    expect(JSON.stringify(log.entries)).not.toContain("secret-ha-token");
  });

  it("rejects a malformed /states payload", async () => {
    fake = await startFakeHa({ statesBody: {} });
    const { client } = makeClientFixture(fake);

    await expect(client.listStates()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("accepts a URL that already ends with /api", async () => {
    fake = await startFakeHa();
    const { client } = makeClientFixture(fake, { url: `${fake.baseUrl}/api` });

    await expect(client.listStates()).resolves.toHaveLength(5);
    expect(fake.requests[0]?.path).toBe("/api/states");
  });

  it("answers availability from GET /api/", async () => {
    fake = await startFakeHa();
    const { client } = makeClientFixture(fake);

    await expect(client.available()).resolves.toBe(true);
    expect(fake.requests[0]?.path).toBe("/api/");
  });
});

// ───────────────────────────────────────────────────── tool registry tests ──

describe("tool registry", () => {
  it("registers tools and exposes their specs", () => {
    const { registry } = makeRegistryFixture();

    expect(registry.get("test.echo")).toBe(echoTool);
    expect(registry.get("test.missing")).toBeUndefined();
    expect(registry.specs()).toEqual([
      {
        name: "test.echo",
        description: "Echo the text argument",
        parameters: echoTool.parameters,
      },
    ]);
  });

  it("rejects duplicate tool names", () => {
    const { registry } = makeRegistryFixture();
    expect(() => registry.register(echoTool)).toThrow("tool already registered: test.echo");
  });

  it("removes tools by name prefix", () => {
    const { registry } = makeRegistryFixture();
    const mcpOne: Tool = {
      name: "mcp.server.one",
      description: "MCP tool one",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { ok: true, data: { called: "one" } };
      },
    };
    const mcpTwo: Tool = {
      name: "mcp.server.two",
      description: "MCP tool two",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { ok: true, data: { called: "two" } };
      },
    };
    registry.register(mcpOne);
    registry.register(mcpTwo);

    expect(registry.removeByPrefix("mcp.")).toBe(2);
    expect(registry.get("mcp.server.one")).toBeUndefined();
    expect(registry.get("mcp.server.two")).toBeUndefined();
    expect(registry.get("test.echo")).toBe(echoTool);
    expect(registry.specs().map((spec) => spec.name)).toEqual(["test.echo"]);

    // MCP reload registers a fresh tool list into the same registry.
    expect(() => registry.register(mcpOne)).not.toThrow();
    expect(registry.removeByPrefix("mcp.")).toBe(1);
    expect(registry.removeByPrefix("mcp.")).toBe(0);
  });

  it("executes a tool with parsed arguments", async () => {
    const { registry, ctx } = makeRegistryFixture();

    const result = await registry.execute(
      { id: "call-1", name: "test.echo", argumentsJson: JSON.stringify({ text: "привет" }) },
      ctx,
    );

    expect(result).toEqual({ ok: true, data: { echoed: "привет" } });
  });

  it("returns ok:false for invalid JSON arguments", async () => {
    const { registry, ctx } = makeRegistryFixture();

    const result = await registry.execute(
      { id: "call-1", name: "test.echo", argumentsJson: "{oops" },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: "invalid json arguments" });
  });

  it("returns ok:false for JSON that is not an object", async () => {
    const { registry, ctx } = makeRegistryFixture();

    const result = await registry.execute(
      { id: "call-1", name: "test.echo", argumentsJson: "[]" },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: "invalid json arguments" });
  });

  it("returns ok:false for an unknown tool", async () => {
    const { registry, ctx } = makeRegistryFixture();

    const result = await registry.execute(
      { id: "call-1", name: "test.missing", argumentsJson: "{}" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown tool: test.missing");
  });

  it("returns ok:false when a required argument is missing", async () => {
    const { registry, ctx } = makeRegistryFixture();

    const result = await registry.execute(
      { id: "call-1", name: "test.echo", argumentsJson: "{}" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing required argument: text");
  });

  it("catches tool exceptions and converts them to ok:false", async () => {
    const { registry, ctx, log } = makeRegistryFixture();
    registry.register({
      name: "test.fail",
      description: "Always fails",
      parameters: { type: "object", properties: {} },
      async execute() {
        throw new Error("boom");
      },
    });

    const result = await registry.execute(
      { id: "call-1", name: "test.fail", argumentsJson: "{}" },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: "boom" });
    expect(log.entries.some((entry) => entry.level === "error" && entry.msg === "tool call failed")).toBe(
      true,
    );
  });

  it("passes tool results through unchanged", async () => {
    const { registry, ctx } = makeRegistryFixture();
    const failingTool: Tool = {
      name: "test.failing",
      description: "Semantic failure",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { ok: false, error: "domain error", speech: "Не получилось" };
      },
    };
    registry.register(failingTool);

    const result = await registry.execute(
      { id: "call-1", name: "test.failing", argumentsJson: "{}" },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: "domain error", speech: "Не получилось" });
  });

  it("logs tool duration", async () => {
    const { registry, ctx, log } = makeRegistryFixture();

    await registry.execute(
      { id: "call-1", name: "test.echo", argumentsJson: JSON.stringify({ text: "x" }) },
      ctx,
    );

    const finished = log.entries.find((entry) => entry.msg === "tool call finished");
    expect(finished).toBeDefined();
    expect(typeof finished?.data?.durationMs).toBe("number");
  });
});

// ──────────────────────────────────────────────────────── HA tool tests ──

describe("ha tools", () => {
  it("registers all HA tools when config.tools.ha.enabled is true", async () => {
    fake = await startFakeHa();
    const { registry } = makeHaToolsFixture(fake);

    expect(registry.specs().map((spec) => spec.name)).toEqual(HA_TOOL_NAMES);
    const callServiceSpec = registry.specs().find((spec) => spec.name === "ha.call_service");
    expect(callServiceSpec?.parameters.required).toEqual(["domain", "service"]);
    expect(callServiceSpec?.description).not.toBe("");
    expect(callServiceSpec?.parameters.properties?.entity_id?.description).toContain("список");
  });

  it("registers no tools when config.tools.ha.enabled is false", async () => {
    fake = await startFakeHa();
    const { registry } = makeHaToolsFixture(fake, { enabled: false });

    const config = makeConfig({ enabled: false, url: fake.baseUrl, token: "test-token" });
    const store = createConfigStore(config);
    const log = new TestLogger();
    expect(createHaTools(store, log)).toEqual([]);
    expect(registry.specs()).toEqual([]);
    expect(registry.get("ha.call_service")).toBeUndefined();
  });

  it("ha.call_service sends a flat service request", async () => {
    fake = await startFakeHa();
    const fixture = makeHaToolsFixture(fake);

    const result = await executeTool(fixture, "ha.call_service", {
      domain: "light",
      service: "turn_on",
      entity_id: "light.kitchen",
      data: { brightness: 128 },
    });

    expect(result).toEqual({ ok: true, data: { done: true } });
    const post = lastPost(fake);
    expect(post.path).toBe("/api/services/light/turn_on");
    expect(postedBody(post)).toEqual({ brightness: 128, entity_id: "light.kitchen" });
  });

  it("ha.call_service rejects domains that execute code or control the host", async () => {
    fake = await startFakeHa();
    const fixture = makeHaToolsFixture(fake);

    for (const domain of ["shell_command", "python_script", "hassio", "homeassistant"]) {
      const result = await executeTool(fixture, "ha.call_service", {
        domain,
        service: "restart",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("запрещён");
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("ha.call_service accepts entity id lists and target fields", async () => {
    fake = await startFakeHa();
    const fixture = makeHaToolsFixture(fake);

    await executeTool(fixture, "ha.call_service", {
      domain: "light",
      service: "turn_off",
      entity_id: ["light.kitchen", "light.bedroom"],
      area_id: "kitchen",
      device_id: "device-1",
    });

    expect(postedBody(lastPost(fake))).toEqual({
      entity_id: ["light.kitchen", "light.bedroom"],
      area_id: "kitchen",
      device_id: "device-1",
    });
  });

  it("ha.call_service rejects unusable target and data types", async () => {
    fake = await startFakeHa();
    const fixture = makeHaToolsFixture(fake);

    const badTarget = await executeTool(fixture, "ha.call_service", {
      domain: "light",
      service: "turn_on",
      entity_id: 123,
    });
    expect(badTarget.ok).toBe(false);
    expect(badTarget.error).toContain("entity_id");

    const badData = await executeTool(fixture, "ha.call_service", {
      domain: "light",
      service: "turn_on",
      entity_id: "light.kitchen",
      data: "brightness=128",
    });
    expect(badData.ok).toBe(false);
    expect(badData.error).toContain("data");

    expect(fake.posts()).toHaveLength(0);
  });

  it("ha.list_entities rejects a non-string filter", async () => {
    fake = await startFakeHa();
    const fixture = makeHaToolsFixture(fake);

    const result = await executeTool(fixture, "ha.list_entities", { domain: 42 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("domain");
  });

  it("ha.get_state returns entity id, state and attributes", async () => {
    fake = await startFakeHa();
    const fixture = makeHaToolsFixture(fake);

    const result = await executeTool(fixture, "ha.get_state", { entity_id: "light.kitchen" });
    expect(resultData(result)).toEqual({
      entity_id: "light.kitchen",
      state: "on",
      attributes: { friendly_name: "Свет на кухне", brightness: 255 },
    });
  });

  it("ha.get_state reports a missing entity", async () => {
    fake = await startFakeHa();
    const fixture = makeHaToolsFixture(fake);

    const result = await executeTool(fixture, "ha.get_state", { entity_id: "light.missing" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("сущность не найдена: light.missing");
  });

  it("ha.list_entities filters by domain and query", async () => {
    fake = await startFakeHa();
    const fixture = makeHaToolsFixture(fake);

    const lights = resultEntities(
      await executeTool(fixture, "ha.list_entities", { domain: "light" }),
    );
    expect(lights.map((entity) => entity.entity_id)).toEqual(["light.kitchen", "light.bedroom"]);

    const kitchen = resultEntities(
      await executeTool(fixture, "ha.list_entities", { query: "кух" }),
    );
    expect(kitchen.map((entity) => entity.entity_id)).toEqual(["light.kitchen"]);
  });

  it("ha.list_entities returns at most 50 entities", async () => {
    const manyStates = Array.from({ length: 55 }, (_, index) => ({
      entity_id: `light.lamp_${index}`,
      state: "on",
      attributes: { friendly_name: `Лампа ${index}` },
    }));
    const capFake = await startFakeHa({ states: manyStates });
    try {
      const fixture = makeHaToolsFixture(capFake);
      const entities = resultEntities(
        await executeTool(fixture, "ha.list_entities", { domain: "light" }),
      );
      expect(entities).toHaveLength(50);
    } finally {
      await capFake.close();
    }
  });

  it("media.play uses play_media when media_content_id is set", async () => {
    fake = await startFakeHa();
    const fixture = makeHaToolsFixture(fake);

    const result = await executeTool(fixture, "media.play", {
      entity_id: "media_player.station",
      media_content_id: "http://example.com/track.mp3",
    });

    expect(result).toEqual({ ok: true, data: { done: true } });
    const post = lastPost(fake);
    expect(post.path).toBe("/api/services/media_player/play_media");
    expect(postedBody(post)).toEqual({
      entity_id: "media_player.station",
      media_content_id: "http://example.com/track.mp3",
      media_content_type: "music",
    });
  });

  it("media.play forwards an explicit media_content_type", async () => {
    fake = await startFakeHa();
    const fixture = makeHaToolsFixture(fake);

    await executeTool(fixture, "media.play", {
      entity_id: "media_player.station",
      media_content_id: "http://example.com/movie.mp4",
      media_content_type: "video",
    });

    expect(postedBody(lastPost(fake)).media_content_type).toBe("video");
  });

  it("media.play turns the player on without media_content_id", async () => {
    fake = await startFakeHa();
    const fixture = makeHaToolsFixture(fake);

    await executeTool(fixture, "media.play", { entity_id: "media_player.station" });

    const post = lastPost(fake);
    expect(post.path).toBe("/api/services/media_player/turn_on");
    expect(postedBody(post)).toEqual({ entity_id: "media_player.station" });
  });

  it("media.pause calls media_player.media_pause", async () => {
    fake = await startFakeHa();
    const fixture = makeHaToolsFixture(fake);

    await executeTool(fixture, "media.pause", { entity_id: "media_player.station" });

    const post = lastPost(fake);
    expect(post.path).toBe("/api/services/media_player/media_pause");
    expect(postedBody(post)).toEqual({ entity_id: "media_player.station" });
  });

  it("media.volume calls media_player.volume_set with volume_level", async () => {
    fake = await startFakeHa();
    const fixture = makeHaToolsFixture(fake);

    await executeTool(fixture, "media.volume", {
      entity_id: "media_player.station",
      level: 0.3,
    });

    const post = lastPost(fake);
    expect(post.path).toBe("/api/services/media_player/volume_set");
    expect(postedBody(post)).toEqual({ entity_id: "media_player.station", volume_level: 0.3 });
  });

  it("media.volume rejects a level outside 0..1", async () => {
    fake = await startFakeHa();
    const fixture = makeHaToolsFixture(fake);

    const result = await executeTool(fixture, "media.volume", {
      entity_id: "media_player.station",
      level: 1.5,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("от 0 до 1");
    expect(fake.posts()).toHaveLength(0);
  });

  it("announce.say asks for a satellite entity_id", async () => {
    fake = await startFakeHa();
    const fixture = makeHaToolsFixture(fake);

    const result = await executeTool(fixture, "announce.say", { text: "Привет" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("entity_id");
    expect(result.error).toContain("Assist");
    expect(fake.posts()).toHaveLength(0);
  });

  it("announce.say calls assist_satellite.announce", async () => {
    fake = await startFakeHa();
    const fixture = makeHaToolsFixture(fake);

    const result = await executeTool(fixture, "announce.say", {
      entity_id: "assist_satellite.kitchen",
      text: "Привет",
    });

    expect(result).toEqual({ ok: true, data: { done: true } });
    const post = lastPost(fake);
    expect(post.path).toBe("/api/services/assist_satellite/announce");
    expect(postedBody(post)).toEqual({
      entity_id: "assist_satellite.kitchen",
      message: "Привет",
    });
  });

  it("returns ok:false when HA itself is unavailable", async () => {
    fake = await startFakeHa({ postStatus: 500 });
    const fixture = makeHaToolsFixture(fake);

    const result = await executeTool(fixture, "ha.call_service", {
      domain: "light",
      service: "turn_on",
      entity_id: "light.kitchen",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("500");
    expect(JSON.stringify(result)).not.toContain(fixture.token);
  });
});
