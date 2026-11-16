/**
 * MCP client / manager / tool-adapter tests. Test servers are real @modelcontextprotocol/sdk
 * servers connected through InMemoryTransport pairs; the stdio test spawns a real child process.
 */

import { afterEach, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

import { createMcpClient, type McpClientFactory, type McpClientLike } from "../src/mcp/client.js";
import { createMcpManager } from "../src/mcp/manager.js";
import { createMcpTools } from "../src/tools/mcp.js";
import type {
  AppConfig,
  ConfigStoreLike,
  DeepPartial,
  HaClientLike,
  LogEntry,
  LogLevel,
  LoggerLike,
  McpManagerLike,
  McpServerConfig,
  SchedulerApiLike,
  ToolContext,
} from "../src/shared/types.js";

const TEST_TOOL_TIMEOUT_SEC = 5;
const SLOW_TOOL_DELAY_MS = 250;

const STDIO_SERVER_SCRIPT = [
  "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
  "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
  "import { z } from 'zod';",
  "const server = new McpServer({ name: 'stdio-fixture', version: '1.0.0' });",
  "server.registerTool(",
  "  'echo',",
  "  { description: 'Echo the given text', inputSchema: { text: z.string() } },",
  "  async ({ text }) => ({ content: [{ type: 'text', text: 'stdio:' + text }] }),",
  ");",
  "await server.connect(new StdioServerTransport());",
].join("\n");

// ────────────────────────────────────────────────────────────── harness ──

interface TestMcpServer {
  readonly id: string;
  readonly clientTransport: InMemoryTransport;
  close(): Promise<void>;
}

const servers: TestMcpServer[] = [];
const clients: McpClientLike[] = [];
const managers: McpManagerLike[] = [];

function delayed(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delayed(10);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function trackClient<T extends McpClientLike>(client: T): T {
  clients.push(client);
  return client;
}

function trackManager(manager: McpManagerLike): McpManagerLike {
  managers.push(manager);
  return manager;
}

async function startTestServer(id: string): Promise<TestMcpServer> {
  const server = new McpServer({ name: `test-${id}`, version: "1.0.0" });

  server.registerTool(
    "echo",
    { description: "Echo the given text", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text: `${id}:${text}` }] }),
  );
  server.registerTool(
    "fail",
    { description: "Always reports an error" },
    async () => ({ content: [{ type: "text", text: `failure from ${id}` }], isError: true }),
  );
  server.registerTool(
    "json",
    { description: "Returns a JSON document as text" },
    async () => ({ content: [{ type: "text", text: JSON.stringify({ server: id, ok: true }) }] }),
  );
  server.registerTool(
    "structured",
    { description: "Returns structured content", outputSchema: { value: z.number() } },
    async () => ({ content: [{ type: "text", text: "7" }], structuredContent: { value: 7 } }),
  );
  server.registerTool(
    "slow",
    {
      description: "Answers after a delay",
      inputSchema: { delayMs: z.number().int().nonnegative() },
    },
    async ({ delayMs }) => {
      await delayed(delayMs);
      return { content: [{ type: "text", text: `${id}:slow` }] };
    },
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const testServer: TestMcpServer = {
    id,
    clientTransport,
    close: async () => {
      await server.close();
    },
  };
  servers.push(testServer);
  return testServer;
}

function serverConfig(id: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id,
    name: id,
    enabled: true,
    transport: "stdio",
    command: "unused-test-command",
    args: [],
    url: "",
    headers: {},
    toolTimeoutSec: TEST_TOOL_TIMEOUT_SEC,
    ...overrides,
  };
}

function transportFactoryFor(transports: Map<string, Transport>): (config: McpServerConfig) => Transport {
  return (config) => {
    const transport = transports.get(config.id);
    if (transport === undefined) throw new Error(`no test transport for MCP server "${config.id}"`);
    return transport;
  };
}

function queuedTransportFactory(queue: Transport[]): (config: McpServerConfig) => Transport {
  return () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("test transport queue is empty");
    return next;
  };
}

function inMemoryClientFactory(transports: Map<string, Transport>): McpClientFactory {
  return (config, log) =>
    createMcpClient(config, log, { transportFactory: transportFactoryFor(transports) });
}

function baseConfig(mcpServers: McpServerConfig[]): AppConfig {
  return {
    version: 1,
    logLevel: "debug",
    provider: {
      id: "mock",
      openai: {
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "",
        model: "mock",
        temperature: 0,
        maxTokens: 64,
        extraHeaders: {},
      },
      openclaw: { baseUrl: "http://127.0.0.1:1", apiKey: "", agentId: "", model: "mock" },
      geminiLive: { apiKey: "", model: "mock", voice: "Puck", responseModality: "TEXT" },
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
        minSpeechMs: 100,
        maxUtteranceMs: 15_000,
        preRollMs: 300,
      },
    },
    tts: {
      mode: "piper",
      piper: { host: "127.0.0.1", port: 10200, voice: "ru_RU-irina-medium" },
      provider: { model: "tts-1", voice: "alloy", format: "wav", language: "ru" },
      outputSampleRate: 16_000,
    },
    prompt: { system: "", language: "ru" },
    conversation: {
      maxHistoryTurns: 10,
      followUpTimeoutMs: 5_000,
      bargeIn: true,
      llmMaxToolIterations: 6,
      requestTimeoutMs: 30_000,
    },
    tools: {
      ha: { enabled: false, url: "", token: "" },
      scheduler: { enabled: false, maxActive: 10, confirmBeforeSchedule: false },
      mcp: { servers: mcpServers },
    },
    aliases: {},
  };
}

class TestConfigStore implements ConfigStoreLike {
  private current: AppConfig;

  constructor(config: AppConfig) {
    this.current = config;
  }

  get(): AppConfig {
    return this.current;
  }

  async update(patch: DeepPartial<AppConfig>): Promise<AppConfig> {
    this.current = { ...this.current, ...patch } as AppConfig;
    return this.current;
  }

  masked(): AppConfig {
    return this.current;
  }

  onChange(_listener: (config: AppConfig) => void): () => void {
    return () => {
      // Tests do not subscribe to config changes.
    };
  }

  bridgeToken(): string {
    return "test-bridge-token";
  }
}

class TestLogger implements LoggerLike {
  readonly entries: Array<{ level: LogLevel; msg: string }> = [];

  trace(msg: string, _data?: Record<string, unknown>): void {
    this.entries.push({ level: "trace", msg });
  }

  debug(msg: string, _data?: Record<string, unknown>): void {
    this.entries.push({ level: "debug", msg });
  }

  info(msg: string, _data?: Record<string, unknown>): void {
    this.entries.push({ level: "info", msg });
  }

  warn(msg: string, _data?: Record<string, unknown>): void {
    this.entries.push({ level: "warn", msg });
  }

  error(msg: string, _data?: Record<string, unknown>): void {
    this.entries.push({ level: "error", msg });
  }

  child(_scope: string): LoggerLike {
    return this;
  }

  since(_afterSeq: number, _limit?: number): LogEntry[] {
    return [];
  }

  subscribe(_listener: (entry: LogEntry) => void): () => void {
    return () => {
      // Tests do not subscribe to log entries.
    };
  }
}

function createTestLogger(): TestLogger {
  return new TestLogger();
}

function unusedHaClient(): HaClientLike {
  return {
    callService: async () => {
      throw new Error("HA client is not used by MCP tools");
    },
    getState: async () => {
      throw new Error("HA client is not used by MCP tools");
    },
    listStates: async () => {
      throw new Error("HA client is not used by MCP tools");
    },
    listEntities: async () => {
      throw new Error("HA client is not used by MCP tools");
    },
    listAreas: async () => {
      throw new Error("HA client is not used by MCP tools");
    },
    listServices: async () => {
      throw new Error("HA client is not used by MCP tools");
    },
    available: async () => {
      throw new Error("HA client is not used by MCP tools");
    },
  };
}

function unusedScheduler(): SchedulerApiLike {
  return {
    addOnce: async () => {
      throw new Error("Scheduler is not used by MCP tools");
    },
    cancel: async () => {
      throw new Error("Scheduler is not used by MCP tools");
    },
    list: async () => {
      throw new Error("Scheduler is not used by MCP tools");
    },
  };
}

function toolContext(manager: McpManagerLike, config: AppConfig): ToolContext {
  return {
    runId: "test-run",
    ha: unusedHaClient(),
    scheduler: unusedScheduler(),
    mcp: manager,
    log: createTestLogger(),
    config,
  };
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  for (const manager of managers.splice(0)) {
    await manager.stop();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

// ───────────────────────────────────────────────────────────────── client ──

describe("McpClient", () => {
  it("connects, discovers and calls tools over an in-memory transport", async () => {
    const server = await startTestServer("alpha");
    const client = trackClient(
      createMcpClient(serverConfig("alpha"), createTestLogger(), {
        transportFactory: () => server.clientTransport,
      }),
    );

    await client.connect();
    expect(client.state.connected).toBe(true);
    expect(client.state.error).toBe("");

    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "mcp.alpha.echo",
      "mcp.alpha.fail",
      "mcp.alpha.json",
      "mcp.alpha.slow",
      "mcp.alpha.structured",
    ]);
    const echo = tools.find((tool) => tool.name === "mcp.alpha.echo");
    expect(echo?.serverId).toBe("alpha");
    expect(echo?.description).toBe("Echo the given text");
    expect(echo?.parameters.type).toBe("object");
    expect(echo?.parameters.properties?.["text"]?.type).toBe("string");
    expect(echo?.parameters.required).toEqual(["text"]);

    await expect(client.callTool("echo", { text: "привет" })).resolves.toEqual({
      ok: true,
      data: "alpha:привет",
    });
    await expect(client.callTool("json", {})).resolves.toEqual({
      ok: true,
      data: { server: "alpha", ok: true },
    });
    await expect(client.callTool("structured", {})).resolves.toEqual({
      ok: true,
      data: { value: 7 },
    });

    const failed = await client.callTool("fail", {});
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe("failure from alpha");

    await client.close();
    expect(client.state.connected).toBe(false);
    expect(client.state.tools).toEqual([]);
  });

  it("reports not-connected errors before connect without throwing from the state getter", async () => {
    const client = trackClient(
      createMcpClient(serverConfig("idle"), createTestLogger(), {
        transportFactory: () => {
          throw new Error("transport must not be built before connect");
        },
      }),
    );

    expect(() => client.state).not.toThrow();
    await expect(client.listTools()).rejects.toThrow('MCP server "idle" is not connected');
    await expect(client.callTool("echo", {})).rejects.toThrow('MCP server "idle" is not connected');
  });

  it("records transport setup failures in state and rejects connect", async () => {
    const client = trackClient(
      createMcpClient(serverConfig("broken"), createTestLogger(), {
        transportFactory: () => {
          throw new Error("no transport available");
        },
      }),
    );

    await expect(client.connect()).rejects.toThrow('MCP server "broken" transport setup failed');
    expect(client.state.connected).toBe(false);
    expect(client.state.error).toContain("no transport available");
    expect(() => client.state).not.toThrow();
  });

  it("rejects malformed transport settings before touching the network", async () => {
    const missingUrl = trackClient(
      createMcpClient(serverConfig("no-url", { transport: "http" }), createTestLogger()),
    );
    await expect(missingUrl.connect()).rejects.toThrow('transport setup failed');
    expect(missingUrl.state.error).toContain("requires a url");

    const malformedUrl = trackClient(
      createMcpClient(
        serverConfig("bad-url", { transport: "sse", url: "not a url" }),
        createTestLogger(),
      ),
    );
    await expect(malformedUrl.connect()).rejects.toThrow('transport setup failed');
    expect(malformedUrl.state.error).toContain("not a valid URL");

    const missingCommand = trackClient(
      createMcpClient(serverConfig("no-command", { command: "  " }), createTestLogger()),
    );
    await expect(missingCommand.connect()).rejects.toThrow('transport setup failed');
    expect(missingCommand.state.error).toContain("requires a command");
  });

  it("times out tool calls using toolTimeoutSec", async () => {
    const server = await startTestServer("slowpoke");
    const client = trackClient(
      createMcpClient(serverConfig("slowpoke", { toolTimeoutSec: 0.05 }), createTestLogger(), {
        transportFactory: () => server.clientTransport,
      }),
    );
    await client.connect();

    await expect(client.callTool("slow", { delayMs: SLOW_TOOL_DELAY_MS })).rejects.toThrow(
      /timed out after 50 ms/,
    );
    // Let the server finish its handler before the transport closes, so it can send the late reply.
    await delayed(SLOW_TOOL_DELAY_MS);
    await client.close();
  });

  it("honours an external abort signal", async () => {
    const server = await startTestServer("aborts");
    const client = trackClient(
      createMcpClient(serverConfig("aborts"), createTestLogger(), {
        transportFactory: () => server.clientTransport,
      }),
    );
    await client.connect();

    const controller = new AbortController();
    const pending = client.callTool("slow", { delayMs: SLOW_TOOL_DELAY_MS }, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toThrow(/aborted/i);

    await delayed(SLOW_TOOL_DELAY_MS);
    await client.close();
  });

  it("reconnects with backoff after an established connection drops", async () => {
    const first = await startTestServer("first");
    const second = await startTestServer("second");
    const client = trackClient(
      createMcpClient(serverConfig("reconnector"), createTestLogger(), {
        transportFactory: queuedTransportFactory([first.clientTransport, second.clientTransport]),
        reconnectDelaysMs: [10, 20],
      }),
    );

    await client.connect();
    await expect(client.callTool("echo", { text: "one" })).resolves.toEqual({
      ok: true,
      data: "first:one",
    });

    await first.clientTransport.close();
    await waitFor(() => client.state.connected, "client to reconnect");
    await expect(client.callTool("echo", { text: "two" })).resolves.toEqual({
      ok: true,
      data: "second:two",
    });

    await client.close();
  });

  it("connects to a real stdio MCP server process", async () => {
    const client = trackClient(
      createMcpClient(
        serverConfig("stdio", {
          command: process.execPath,
          args: ["--input-type=module", "-e", STDIO_SERVER_SCRIPT],
        }),
        createTestLogger(),
      ),
    );

    await client.connect();
    expect(client.state.connected).toBe(true);
    await expect(client.callTool("echo", { text: "process" })).resolves.toEqual({
      ok: true,
      data: "stdio:process",
    });
    await client.close();
  });
});

// ──────────────────────────────────────────────────────────────── manager ──

describe("McpManager", () => {
  it("connects enabled servers in parallel, namespaces tools and isolates a failure", async () => {
    const alpha = await startTestServer("alpha");
    const beta = await startTestServer("beta");
    const transports = new Map<string, Transport>([
      ["alpha", alpha.clientTransport],
      ["beta", beta.clientTransport],
    ]);
    const manager = trackManager(
      createMcpManager(new TestConfigStore(baseConfig([])), createTestLogger(), {
        createClient: inMemoryClientFactory(transports),
      }),
    );

    await manager.start(
      baseConfig([serverConfig("alpha"), serverConfig("beta"), serverConfig("broken")]),
    );

    const states = manager.states();
    expect(states.map((state) => state.id)).toEqual(["alpha", "beta", "broken"]);
    expect(states.find((state) => state.id === "alpha")?.connected).toBe(true);
    expect(states.find((state) => state.id === "beta")?.connected).toBe(true);
    const broken = states.find((state) => state.id === "broken");
    expect(broken?.connected).toBe(false);
    expect(broken?.error).toContain("no test transport");

    expect(manager.tools()).toHaveLength(10);
    expect(manager.tools().map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "mcp.alpha.echo",
        "mcp.alpha.fail",
        "mcp.beta.echo",
        "mcp.beta.structured",
      ]),
    );

    await expect(manager.callTool("mcp.alpha.echo", { text: "hi" })).resolves.toEqual({
      ok: true,
      data: "alpha:hi",
    });
    await expect(manager.callTool("mcp.beta.echo", { text: "hi" })).resolves.toEqual({
      ok: true,
      data: "beta:hi",
    });

    const unknown = await manager.callTool("mcp.alpha.missing", {});
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("Unknown MCP tool");

    const failed = await manager.callTool("mcp.beta.fail", {});
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe("failure from beta");
  });

  it("keeps servers from other modules isolated when one connection fails", async () => {
    const alpha = await startTestServer("alpha");
    const transports = new Map<string, Transport>([["alpha", alpha.clientTransport]]);
    const manager = trackManager(
      createMcpManager(new TestConfigStore(baseConfig([])), createTestLogger(), {
        createClient: inMemoryClientFactory(transports),
      }),
    );

    await manager.start(baseConfig([serverConfig("broken"), serverConfig("alpha")]));

    expect(manager.states().find((state) => state.id === "broken")?.connected).toBe(false);
    expect(manager.states().find((state) => state.id === "alpha")?.connected).toBe(true);
    await expect(manager.callTool("mcp.alpha.echo", { text: "still" })).resolves.toEqual({
      ok: true,
      data: "alpha:still",
    });
  });

  it("reload closes removed and changed servers and reconnects new ones", async () => {
    const alpha = await startTestServer("alpha");
    const betaOld = await startTestServer("beta");
    const betaNew = await startTestServer("beta");
    const transports = new Map<string, Transport>([
      ["alpha", alpha.clientTransport],
      ["beta", betaOld.clientTransport],
    ]);
    const manager = trackManager(
      createMcpManager(new TestConfigStore(baseConfig([])), createTestLogger(), {
        createClient: inMemoryClientFactory(transports),
      }),
    );

    await manager.start(baseConfig([serverConfig("alpha"), serverConfig("beta")]));
    expect(manager.states().every((state) => state.connected)).toBe(true);

    transports.set("beta", betaNew.clientTransport);
    await manager.reload(
      baseConfig([serverConfig("alpha"), serverConfig("beta", { toolTimeoutSec: 7 })]),
    );
    expect(manager.states().find((state) => state.id === "beta")?.connected).toBe(true);
    await expect(manager.callTool("mcp.beta.echo", { text: "reloaded" })).resolves.toEqual({
      ok: true,
      data: "beta:reloaded",
    });
    await expect(manager.callTool("mcp.alpha.echo", { text: "kept" })).resolves.toEqual({
      ok: true,
      data: "alpha:kept",
    });

    await manager.reload(baseConfig([serverConfig("alpha")]));
    expect(manager.states().map((state) => state.id)).toEqual(["alpha"]);
    expect(manager.tools()).toHaveLength(5);
    expect(manager.tools().every((tool) => tool.serverId === "alpha")).toBe(true);
    const removed = await manager.callTool("mcp.beta.echo", {});
    expect(removed.ok).toBe(false);
  });

  it("connects disabled servers only after a reload enables them", async () => {
    const alpha = await startTestServer("alpha");
    const transports = new Map<string, Transport>([["alpha", alpha.clientTransport]]);
    const manager = trackManager(
      createMcpManager(new TestConfigStore(baseConfig([])), createTestLogger(), {
        createClient: inMemoryClientFactory(transports),
      }),
    );

    await manager.start(baseConfig([serverConfig("alpha", { enabled: false })]));
    const disabled = manager.states()[0];
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.connected).toBe(false);
    expect(manager.tools()).toEqual([]);

    await manager.reload(baseConfig([serverConfig("alpha")]));
    expect(manager.states()[0]?.connected).toBe(true);
    expect(manager.tools()).toHaveLength(5);
  });

  it("tests a server with a temporary connection", async () => {
    const probe = await startTestServer("probe");
    const transports = new Map<string, Transport>([["probe", probe.clientTransport]]);
    const manager = trackManager(
      createMcpManager(new TestConfigStore(baseConfig([])), createTestLogger(), {
        createClient: inMemoryClientFactory(transports),
      }),
    );

    const healthy = await manager.test(serverConfig("probe"));
    expect(healthy.ok).toBe(true);
    expect(healthy.detail).toContain("инструментов: 5");

    const failed = await manager.test(serverConfig("absent"));
    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain("Не удалось подключиться");
  });

  it("stops all connections and clears states and tools", async () => {
    const alpha = await startTestServer("alpha");
    const transports = new Map<string, Transport>([["alpha", alpha.clientTransport]]);
    const manager = trackManager(
      createMcpManager(new TestConfigStore(baseConfig([])), createTestLogger(), {
        createClient: inMemoryClientFactory(transports),
      }),
    );

    await manager.start(baseConfig([serverConfig("alpha")]));
    await manager.stop();

    expect(manager.states()).toEqual([]);
    expect(manager.tools()).toEqual([]);
    const afterStop = await manager.callTool("mcp.alpha.echo", {});
    expect(afterStop.ok).toBe(false);
  });

});

// ───────────────────────────────────────────────────────── tools/mcp.ts ──

describe("createMcpTools", () => {
  async function startedManager(): Promise<{
    manager: McpManagerLike;
    config: AppConfig;
    transports: Map<string, Transport>;
  }> {
    const alpha = await startTestServer("alpha");
    const transports = new Map<string, Transport>([["alpha", alpha.clientTransport]]);
    const config = baseConfig([serverConfig("alpha")]);
    const manager = trackManager(
      createMcpManager(new TestConfigStore(config), createTestLogger(), {
        createClient: inMemoryClientFactory(transports),
      }),
    );
    await manager.start(config);
    return { manager, config, transports };
  }

  it("exposes one Tool per discovered MCP tool with a JSON schema", async () => {
    const { manager } = await startedManager();

    const tools = createMcpTools(manager);
    expect(tools.map((tool) => tool.name)).toEqual(manager.tools().map((tool) => tool.name));
    expect(tools).toHaveLength(5);

    const echo = tools.find((tool) => tool.name === "mcp.alpha.echo");
    expect(echo?.description).toBe("Echo the given text");
    expect(echo?.parameters.type).toBe("object");
    expect(echo?.parameters.properties?.["text"]?.type).toBe("string");
    expect(echo?.parameters.required).toEqual(["text"]);
  });

  it("executes through the manager and returns its ToolResult", async () => {
    const { manager, config } = await startedManager();
    const echo = createMcpTools(manager).find((tool) => tool.name === "mcp.alpha.echo");
    if (echo === undefined) throw new Error("echo tool was not adapted");

    await expect(echo.execute({ text: "adapter" }, toolContext(manager, config))).resolves.toEqual({
      ok: true,
      data: "alpha:adapter",
    });

    const fail = createMcpTools(manager).find((tool) => tool.name === "mcp.alpha.fail");
    if (fail === undefined) throw new Error("fail tool was not adapted");
    const failed = await fail.execute({}, toolContext(manager, config));
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe("failure from alpha");
  });

  it("re-reads manager.tools() on each call", async () => {
    const { manager, config, transports } = await startedManager();
    expect(createMcpTools(manager)).toHaveLength(5);

    await manager.reload(baseConfig([]));
    expect(createMcpTools(manager)).toEqual([]);

    // The removed connection consumed its transport, so re-adding the server needs a fresh one.
    const restarted = await startTestServer("alpha");
    transports.set("alpha", restarted.clientTransport);
    await manager.reload(config);
    expect(createMcpTools(manager)).toHaveLength(5);
  });
});
