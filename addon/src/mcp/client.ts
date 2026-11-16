/**
 * MCP client for one configured server. Wraps @modelcontextprotocol/sdk transports (stdio,
 * Streamable HTTP, SSE), namespaces discovered tools, and keeps connection state without
 * throwing from getters. Transport failures are wrapped into messages that name the server;
 * headers and environment variables are never logged.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type {
  LoggerLike,
  McpServerConfig,
  McpServerState,
  McpToolInfo,
  ToolResult,
} from "../shared/types.js";
import { errorMessage } from "./errors.js";
import { isRecord, toJsonSchema } from "./schema.js";

const CLIENT_NAME = "pulsar-brain";
const CLIENT_VERSION = "0.1.0";
const CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_TOOL_TIMEOUT_SEC = 20;
/** Backoff after an established connection drops; the last value repeats. */
const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

export interface McpClientOptions {
  /** Replaces the SDK transport built from config. Tests use it with InMemoryTransport pairs. */
  transportFactory?: (config: McpServerConfig) => Transport;
  /** Reconnect delays, tests override it to avoid waiting for real backoff. */
  reconnectDelaysMs?: readonly number[];
}

export interface McpClientLike {
  readonly serverId: string;
  readonly state: McpServerState;
  connect(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
  close(): Promise<void>;
}

export type McpClientFactory = (config: McpServerConfig, log: LoggerLike) => McpClientLike;

/** Creates a client for one server; connection happens lazily in connect(). */
export function createMcpClient(
  serverConfig: McpServerConfig,
  log: LoggerLike,
  options: McpClientOptions = {},
): McpClientLike {
  return new McpClient(serverConfig, log, options);
}

class McpClient implements McpClientLike {
  readonly serverId: string;

  private readonly config: McpServerConfig;
  private readonly log: LoggerLike;
  private readonly options: McpClientOptions;

  private client: Client | undefined;
  private connecting: Promise<void> | undefined;
  private closing = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private serverState: McpServerState;

  constructor(serverConfig: McpServerConfig, log: LoggerLike, options: McpClientOptions) {
    this.serverId = serverConfig.id;
    this.config = serverConfig;
    this.log = log;
    this.options = options;
    this.serverState = {
      id: serverConfig.id,
      enabled: serverConfig.enabled,
      connected: false,
      error: "",
      tools: [],
    };
  }

  get state(): McpServerState {
    return {
      id: this.serverState.id,
      enabled: this.config.enabled,
      connected: this.serverState.connected,
      error: this.serverState.error,
      tools: [...this.serverState.tools],
    };
  }

  async connect(): Promise<void> {
    await this.connectWithBackoff(true);
  }

  async listTools(): Promise<McpToolInfo[]> {
    const client = this.client;
    if (client === undefined || !this.serverState.connected) {
      throw new Error(`MCP server "${this.serverId}" is not connected`);
    }
    try {
      const tools = await this.fetchTools(client);
      this.serverState = { ...this.serverState, error: "", tools };
      return [...tools];
    } catch (error) {
      const message = errorMessage(error);
      this.serverState = { ...this.serverState, error: message };
      throw new Error(`Failed to list MCP tools of server "${this.serverId}": ${message}`, {
        cause: error,
      });
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const client = this.client;
    if (client === undefined || !this.serverState.connected) {
      throw new Error(`MCP server "${this.serverId}" is not connected`);
    }
    const timeoutMs = this.toolTimeoutMs();
    const timeoutMessage = `MCP tool "${name}" of server "${this.serverId}" timed out after ${timeoutMs} ms`;
    let raw: unknown;
    try {
      raw = await runWithTimeout(
        timeoutMs,
        (timeoutSignal) => client.callTool({ name, arguments: args }, undefined, { signal: timeoutSignal }),
        timeoutMessage,
        this.log,
        signal,
      );
    } catch (error) {
      const message = errorMessage(error);
      this.log.warn("MCP tool call failed", { server: this.serverId, tool: name, error: message });
      throw new Error(`MCP tool "${name}" of server "${this.serverId}" failed: ${message}`, {
        cause: error,
      });
    }
    return convertCallToolResult(name, raw);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.clearReconnectTimer();
    const pending = this.connecting;
    if (pending !== undefined) {
      try {
        await pending;
      } catch (error) {
        this.log.debug("MCP connect finished with an error while closing", {
          server: this.serverId,
          error: errorMessage(error),
        });
      }
    }
    const client = this.client;
    this.client = undefined;
    await this.closeClient(client);
    this.serverState = { ...this.serverState, connected: false, error: "", tools: [] };
  }

  private async connectWithBackoff(resetBackoff: boolean): Promise<void> {
    if (this.serverState.connected) return;
    if (this.connecting !== undefined) {
      await this.connecting;
      return;
    }
    this.closing = false;
    this.clearReconnectTimer();
    if (resetBackoff) this.reconnectAttempt = 0;

    const work = this.openConnection();
    this.connecting = work;
    try {
      await work;
    } finally {
      if (this.connecting === work) this.connecting = undefined;
    }
  }

  private async openConnection(): Promise<void> {
    let transport: Transport;
    try {
      transport = this.createTransport();
    } catch (error) {
      const message = errorMessage(error);
      this.serverState = { ...this.serverState, connected: false, error: message, tools: [] };
      throw new Error(`MCP server "${this.serverId}" transport setup failed: ${message}`, {
        cause: error,
      });
    }

    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
    client.onclose = () => this.handleTransportClosed(client, "connection closed by the server");
    client.onerror = (error) => this.handleTransportError(client, error);
    this.client = client;

    try {
      await runWithTimeout(
        CONNECT_TIMEOUT_MS,
        (signal) => client.connect(transport, { signal }),
        `MCP server "${this.serverId}" connection timed out after ${CONNECT_TIMEOUT_MS} ms`,
        this.log,
      );
      this.serverState = { ...this.serverState, connected: true, error: "" };
      const tools = await this.fetchTools(client);
      this.serverState = { ...this.serverState, tools };
      this.log.info("MCP server connected", { server: this.serverId, tools: tools.length });
    } catch (error) {
      const message = errorMessage(error);
      this.serverState = { ...this.serverState, connected: false, error: message, tools: [] };
      if (this.client === client) this.client = undefined;
      await this.closeClient(client);
      throw new Error(`MCP server "${this.serverId}" connection failed: ${message}`, {
        cause: error,
      });
    }
  }

  private createTransport(): Transport {
    const factory = this.options.transportFactory;
    if (factory !== undefined) return factory(this.config);

    switch (this.config.transport) {
      case "stdio": {
        const command = this.config.command.trim();
        if (command === "") {
          throw new Error("stdio transport requires a command");
        }
        return new StdioClientTransport({
          command,
          args: [...this.config.args],
          env: inheritableEnvironment(),
        });
      }
      case "http":
        return new StreamableHTTPClientTransport(this.parseUrl(), {
          requestInit: { headers: { ...this.config.headers } },
        });
      case "sse": {
        const url = this.parseUrl();
        const headers = { ...this.config.headers };
        return new SSEClientTransport(url, {
          requestInit: { headers },
          // EventSource cannot set request headers itself, so the stream request needs a fetch wrapper.
          eventSourceInit: {
            fetch: (input, init) => fetch(input, { ...init, headers: { ...init.headers, ...headers } }),
          },
        });
      }
      default:
        return assertNever(this.config.transport);
    }
  }

  private parseUrl(): URL {
    const raw = this.config.url.trim();
    if (raw === "") {
      throw new Error(`${this.config.transport} transport requires a url`);
    }
    try {
      return new URL(raw);
    } catch (error) {
      // The URL may carry credentials in its query, so it is not echoed into the message.
      throw new Error(`${this.config.transport} transport url is not a valid URL`, { cause: error });
    }
  }

  private toolTimeoutMs(): number {
    const configured = this.config.toolTimeoutSec;
    const seconds =
      Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TOOL_TIMEOUT_SEC;
    return Math.round(seconds * 1000);
  }

  private async fetchTools(client: Client): Promise<McpToolInfo[]> {
    const result = await client.listTools();
    return result.tools.map((tool) => ({
      name: `mcp.${this.config.id}.${tool.name}`,
      description:
        tool.description ?? `MCP tool "${tool.name}" of server "${this.config.id}"`,
      parameters: toJsonSchema(tool.inputSchema),
      serverId: this.config.id,
    }));
  }

  private async closeClient(client: Client | undefined): Promise<void> {
    if (client === undefined) return;
    try {
      await client.close();
    } catch (error) {
      this.log.warn("MCP connection close failed", {
        server: this.serverId,
        error: errorMessage(error),
      });
    }
  }

  private handleTransportClosed(source: Client, reason: string): void {
    // A stale callback from a replaced client must not mark the current connection as broken.
    if (this.closing || this.client !== source) return;
    // A close during the initial connect is reported by openConnection, not by reconnect.
    if (this.connecting !== undefined) return;
    const message = this.serverState.error === "" ? reason : this.serverState.error;
    this.serverState = { ...this.serverState, connected: false, error: message, tools: [] };
    this.log.warn("MCP server disconnected", { server: this.serverId, error: message });
    const disconnected = this.client;
    this.client = undefined;
    void this.closeClient(disconnected);
    this.scheduleReconnect();
  }

  private handleTransportError(source: Client, error: Error): void {
    if (this.closing || this.client !== source) return;
    const message = errorMessage(error);
    this.serverState = { ...this.serverState, error: message };
    this.log.warn("MCP transport error", { server: this.serverId, error: message });
  }

  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer !== undefined) return;
    const delays = this.options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    if (this.reconnectAttempt >= delays.length) {
      this.log.error("MCP reconnect attempts exhausted", {
        server: this.serverId,
        attempts: this.reconnectAttempt,
      });
      return;
    }
    const delay = delays[this.reconnectAttempt] ?? delays[delays.length - 1] ?? 1_000;
    this.reconnectAttempt += 1;
    this.log.info("MCP reconnect scheduled", {
      server: this.serverId,
      attempt: this.reconnectAttempt,
      delayMs: delay,
    });
    const timer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.attemptReconnect();
    }, delay);
    timer.unref();
    this.reconnectTimer = timer;
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closing) return;
    try {
      await this.connectWithBackoff(false);
      this.reconnectAttempt = 0;
      this.log.info("MCP server reconnected", { server: this.serverId });
    } catch (error) {
      this.log.warn("MCP reconnect failed", {
        server: this.serverId,
        error: errorMessage(error),
      });
      this.scheduleReconnect();
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}

/** Runs a promise-producing operation with a timeout and an optional external abort signal. */
async function runWithTimeout<T>(
  timeoutMs: number,
  build: (signal: AbortSignal) => Promise<T>,
  timeoutMessage: string,
  log: LoggerLike,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  // Register the rejection listener before any abort can happen, including an already-aborted parent.
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        reject(timedOut ? new Error(timeoutMessage) : abortReasonToError(controller.signal.reason));
      },
      { once: true },
    );
  });

  const abortFromExternal = (): void => controller.abort(externalSignal?.reason);
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener("abort", abortFromExternal, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();

  let settled = false;
  const work = build(controller.signal);
  // The race may lose interest in this promise on timeout; log a late failure instead of leaking it.
  void work.catch((error: unknown) => {
    if (settled) {
      log.debug("MCP request settled after it was abandoned", { error: errorMessage(error) });
    }
  });

  try {
    return await Promise.race([work, aborted]);
  } finally {
    settled = true;
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

function abortReasonToError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error("MCP request aborted");
}

function convertCallToolResult(toolName: string, raw: unknown): ToolResult {
  if (isModernCallToolResult(raw)) {
    const data = raw.content.map(mcpContentToData);
    if (raw.isError === true) {
      const errorText = extractTextContent(raw.content);
      const message = errorText === "" ? `MCP tool "${toolName}" reported an error` : errorText;
      return data.length === 0 ? { ok: false, error: message } : { ok: false, error: message, data };
    }
    if (raw.structuredContent !== undefined) return { ok: true, data: raw.structuredContent };
    if (data.length === 0) return { ok: true };
    if (data.length === 1) {
      const only = data[0];
      return { ok: true, data: typeof only === "string" ? parseJsonText(only) : only };
    }
    return { ok: true, data };
  }
  // Protocol 2024-10-07 compatibility result shape.
  if (isRecord(raw) && "toolResult" in raw) return { ok: true, data: raw.toolResult };
  return { ok: false, error: `MCP tool "${toolName}" returned an unrecognised result` };
}

interface ModernCallToolResult {
  content: readonly unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

function isModernCallToolResult(value: unknown): value is ModernCallToolResult {
  return isRecord(value) && Array.isArray(value.content);
}

/** Collects human-readable text from content items; non-text items are ignored. */
function extractTextContent(content: readonly unknown[]): string {
  const parts: string[] = [];
  for (const item of content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") parts.push(item.text);
  }
  return parts.join("\n");
}

/**
 * Maps one MCP content item to a JSON-friendly value for the LLM tool result.
 * Binary payloads (image/audio/resource blobs) are reduced to descriptors: they would otherwise
 * push megabytes of base64 into the conversation history.
 */
function mcpContentToData(item: unknown): unknown {
  if (!isRecord(item)) return item;
  switch (item.type) {
    case "text":
      return typeof item.text === "string" ? item.text : "";
    case "resource": {
      const resource = item.resource;
      if (!isRecord(resource) || typeof resource.uri !== "string") return item;
      const mapped: Record<string, unknown> = { uri: resource.uri };
      if (typeof resource.mimeType === "string") mapped.mimeType = resource.mimeType;
      if (typeof resource.text === "string") mapped.text = resource.text;
      return mapped;
    }
    case "resource_link": {
      const mapped: Record<string, unknown> = {};
      if (typeof item.uri === "string") mapped.uri = item.uri;
      if (typeof item.name === "string") mapped.name = item.name;
      if (typeof item.description === "string") mapped.description = item.description;
      if (typeof item.mimeType === "string") mapped.mimeType = item.mimeType;
      return mapped;
    }
    case "image":
    case "audio": {
      const mapped: Record<string, unknown> = { type: item.type };
      if (typeof item.mimeType === "string") mapped.mimeType = item.mimeType;
      return mapped;
    }
    default:
      return item;
  }
}

/** Parses JSON document text, keeping the original string when it is not JSON. */
function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed;
  } catch {
    // Not JSON despite looking like it; the raw text is the truthful payload.
    return text;
  }
}

/** Environment inherited by stdio MCP servers; values are never logged. */
const INHERITED_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "TEMP", "TMP"];

/**
 * MCP stdio servers are configured from the admin UI, so they inherit only a small,
 * non-sensitive part of the addon environment. SUPERVISOR_TOKEN and provider keys must
 * never leak into a user-defined child process.
 */
function inheritableEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported MCP transport: ${String(value)}`);
}
