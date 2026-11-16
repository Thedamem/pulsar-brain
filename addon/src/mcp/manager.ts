/**
 * MCP server manager: owns one MCP client per configured server, connects enabled servers in
 * parallel with per-server error isolation, refreshes connections on config reload, and routes
 * namespaced `mcp.<serverId>.<tool>` calls back to the right client.
 */

import type {
  AppConfig,
  ConfigStoreLike,
  LoggerLike,
  McpManagerLike,
  McpServerConfig,
  McpServerState,
  McpToolInfo,
  ProviderHealth,
  ToolResult,
} from "../shared/types.js";
import { createMcpClient, type McpClientFactory, type McpClientLike } from "./client.js";
import { errorMessage } from "./errors.js";

export interface McpManagerOptions {
  /** Overrides client construction; tests inject in-memory transports this way. */
  createClient?: McpClientFactory;
}

interface ManagedServer {
  config: McpServerConfig;
  /** Undefined when client construction itself failed. */
  client: McpClientLike | undefined;
  creationError: string;
}

/** Creates the MCP manager; servers are connected only when start()/reload() is called. */
export function createMcpManager(
  configStore: ConfigStoreLike,
  log: LoggerLike,
  options: McpManagerOptions = {},
): McpManagerLike {
  return new McpManager(configStore, log, options.createClient ?? createMcpClient);
}

class McpManager implements McpManagerLike {
  private readonly configStore: ConfigStoreLike;
  private readonly log: LoggerLike;
  private readonly createClient: McpClientFactory;
  private readonly servers = new Map<string, ManagedServer>();

  constructor(configStore: ConfigStoreLike, log: LoggerLike, createClient: McpClientFactory) {
    this.configStore = configStore;
    this.log = log;
    this.createClient = createClient;
  }

  async start(config?: AppConfig): Promise<void> {
    const resolved = config ?? this.configStore.get();
    await this.stop();
    for (const serverConfig of resolved.tools.mcp.servers) {
      if (this.servers.has(serverConfig.id)) {
        this.log.warn("MCP server id is configured more than once", { server: serverConfig.id });
      }
      this.servers.set(serverConfig.id, this.createManagedServer(serverConfig));
    }
    await this.connectAll(resolved.tools.mcp.servers);
  }

  async reload(config?: AppConfig): Promise<void> {
    const resolved = config ?? this.configStore.get();
    const desired = resolved.tools.mcp.servers;

    const nextById = new Map<string, McpServerConfig>();
    for (const serverConfig of desired) {
      if (nextById.has(serverConfig.id)) {
        this.log.warn("MCP server id is configured more than once", { server: serverConfig.id });
      }
      nextById.set(serverConfig.id, serverConfig);
    }

    // Drop removed or changed connections first; their transports cannot be reused.
    const closers: Array<Promise<void>> = [];
    for (const [serverId, managed] of [...this.servers.entries()]) {
      const next = nextById.get(serverId);
      const unchanged = next !== undefined && sameConnectionSettings(managed.config, next);
      if (unchanged) {
        managed.config = next;
        continue;
      }
      closers.push(this.removeManagedServer(serverId));
    }
    await Promise.all(closers);

    for (const serverConfig of desired) {
      const existing = this.servers.get(serverConfig.id);
      if (existing === undefined || existing.client === undefined) {
        this.servers.set(serverConfig.id, this.createManagedServer(serverConfig));
      } else {
        existing.config = serverConfig;
      }
    }

    const toConnect = desired.filter((serverConfig) => {
      if (!serverConfig.enabled) return false;
      const managed = this.servers.get(serverConfig.id);
      return managed?.client !== undefined && !managed.client.state.connected;
    });
    await this.connectAll(toConnect);
  }

  async stop(): Promise<void> {
    const managedServers = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(
      managedServers.map(async (managed) => {
        try {
          await managed.client?.close();
        } catch (error) {
          this.log.warn("MCP client close failed", {
            server: managed.config.id,
            error: errorMessage(error),
          });
        }
      }),
    );
  }

  states(): McpServerState[] {
    return [...this.servers.values()].map((managed) => {
      if (managed.client === undefined) {
        return {
          id: managed.config.id,
          enabled: managed.config.enabled,
          connected: false,
          error: managed.creationError,
          tools: [],
        };
      }
      const state = managed.client.state;
      if (managed.creationError === "" || state.error !== "") return state;
      return { ...state, error: managed.creationError };
    });
  }

  tools(): McpToolInfo[] {
    const tools: McpToolInfo[] = [];
    for (const managed of this.servers.values()) {
      if (managed.client !== undefined) tools.push(...managed.client.state.tools);
    }
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    for (const managed of this.servers.values()) {
      const client = managed.client;
      if (client === undefined) continue;
      const prefix = `mcp.${managed.config.id}.`;
      if (!name.startsWith(prefix)) continue;
      const toolName = name.slice(prefix.length);
      if (toolName === "") continue;
      if (!client.state.tools.some((tool) => tool.name === name)) continue;
      try {
        return await client.callTool(toolName, args, signal);
      } catch (error) {
        const message = errorMessage(error);
        this.log.warn("MCP tool call failed", {
          server: managed.config.id,
          tool: toolName,
          error: message,
        });
        return { ok: false, error: message };
      }
    }
    return { ok: false, error: `Unknown MCP tool "${name}"` };
  }

  async test(server: McpServerConfig): Promise<ProviderHealth> {
    let client: McpClientLike | undefined;
    try {
      client = this.createClient(
        { ...server, enabled: true },
        this.log.child(`mcp.test.${server.id}`),
      );
      await client.connect();
      const tools = await client.listTools();
      return { ok: true, detail: `Подключено, инструментов: ${tools.length}` };
    } catch (error) {
      return { ok: false, detail: `Не удалось подключиться: ${errorMessage(error)}` };
    } finally {
      try {
        await client?.close();
      } catch (error) {
        this.log.warn("MCP test connection close failed", {
          server: server.id,
          error: errorMessage(error),
        });
      }
    }
  }

  private createManagedServer(serverConfig: McpServerConfig): ManagedServer {
    try {
      const client = this.createClient(
        serverConfig,
        this.log.child(`mcp.${serverConfig.id}`),
      );
      return { config: serverConfig, client, creationError: "" };
    } catch (error) {
      const message = errorMessage(error);
      return { config: serverConfig, client: undefined, creationError: message };
    }
  }

  private async removeManagedServer(serverId: string): Promise<void> {
    const managed = this.servers.get(serverId);
    this.servers.delete(serverId);
    if (managed?.client === undefined) return;
    try {
      await managed.client.close();
    } catch (error) {
      this.log.warn("MCP client close failed", { server: serverId, error: errorMessage(error) });
    }
  }

  private async connectAll(serverConfigs: McpServerConfig[]): Promise<void> {
    const enabled = serverConfigs.filter((serverConfig) => serverConfig.enabled);
    const results = await Promise.allSettled(
      enabled.map(async (serverConfig) => this.connectManagedServer(serverConfig.id)),
    );
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        const serverConfig = enabled[index];
        this.log.error("MCP server connection failed", {
          server: serverConfig?.id ?? "unknown",
          error: errorMessage(result.reason),
        });
      }
    }
  }

  private async connectManagedServer(serverId: string): Promise<void> {
    const managed = this.servers.get(serverId);
    if (managed?.client === undefined) return;
    try {
      await managed.client.connect();
    } catch (error) {
      // The client stores the failure in its state; the manager only logs it.
      this.log.error("MCP server connection failed", {
        server: serverId,
        error: errorMessage(error),
      });
    }
  }
}

/** Compares the settings that require a new transport; display name changes do not. */
function sameConnectionSettings(left: McpServerConfig, right: McpServerConfig): boolean {
  // The client captures its config at construction, so an enabled toggle needs a fresh client.
  if (left.enabled !== right.enabled) return false;
  if (left.transport !== right.transport) return false;
  if (left.command !== right.command) return false;
  if (left.url !== right.url) return false;
  if (left.toolTimeoutSec !== right.toolTimeoutSec) return false;
  if (left.args.length !== right.args.length) return false;
  if (left.args.some((arg, index) => arg !== right.args[index])) return false;
  if (!sameHeaders(left.headers, right.headers)) return false;
  return true;
}

function sameHeaders(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) return false;
  return leftEntries.every(([name, value]) => right[name] === value);
}
