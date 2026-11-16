/**
 * Tool registry: holds tool specs for the model and executes tool calls.
 * Argument validation is intentionally minimal (required fields only): the tool
 * schemas use JSON-Schema unions (string | string[]) that this subset cannot
 * express, so each tool validates its own argument shapes.
 */

import type {
  JsonSchema,
  LoggerLike,
  Tool,
  ToolCall,
  ToolContext,
  ToolRegistryLike,
  ToolResult,
  ToolSpec,
} from "../shared/types.js";

const INVALID_JSON_ERROR = "invalid json arguments";

export function createToolRegistry(parentLog: LoggerLike): ToolRegistryLike {
  const log = parentLog.child("tools");
  const tools = new Map<string, Tool>();

  function register(tool: Tool): void {
    if (tool.name.trim() === "") {
      throw new Error("tool name must not be empty");
    }
    if (tools.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }
    tools.set(tool.name, tool);
    log.debug("tool registered", { tool: tool.name });
  }

  function specs(): ToolSpec[] {
    return [...tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  function get(name: string): Tool | undefined {
    return tools.get(name);
  }

  function removeByPrefix(prefix: string): number {
    let removed = 0;
    for (const name of [...tools.keys()]) {
      if (name.startsWith(prefix)) {
        tools.delete(name);
        removed += 1;
      }
    }
    if (removed > 0) log.debug("tools removed by prefix", { prefix, removed });
    return removed;
  }

  async function execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const tool = tools.get(call.name);
    if (tool === undefined) {
      log.warn("unknown tool call", { tool: call.name, runId: ctx.runId });
      return { ok: false, error: `unknown tool: ${call.name}` };
    }

    const args = parseArguments(call.argumentsJson);
    if (args === null) {
      log.warn("invalid tool arguments JSON", { tool: call.name, runId: ctx.runId });
      return { ok: false, error: INVALID_JSON_ERROR };
    }

    const validationError = validateArguments(tool.parameters, args);
    if (validationError !== null) {
      log.warn("invalid tool arguments", {
        tool: call.name,
        runId: ctx.runId,
        error: validationError,
      });
      return { ok: false, error: validationError };
    }

    try {
      const result = await tool.execute(args, ctx);
      log.debug("tool call finished", {
        tool: call.name,
        runId: ctx.runId,
        ok: result.ok,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      const message = errorMessage(err);
      log.error("tool call failed", {
        tool: call.name,
        runId: ctx.runId,
        error: message,
        durationMs: Date.now() - startedAt,
      });
      return { ok: false, error: message };
    }
  }

  return { register, specs, get, removeByPrefix, execute };
}

function parseArguments(argumentsJson: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function validateArguments(schema: JsonSchema, args: Record<string, unknown>): string | null {
  const required = schema.required ?? [];
  for (const key of required) {
    if (args[key] === undefined) {
      return `missing required argument: ${key}`;
    }
  }
  return null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "tool execution failed";
}
