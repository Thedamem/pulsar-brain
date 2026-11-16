/**
 * Adapters from discovered MCP tools to the brain's Tool contract. One Tool per McpToolInfo;
 * createMcpTools() re-reads manager.tools() on every call, so the composition root can refresh
 * the set after a reload.
 */

import type {
  JsonSchema,
  McpManagerLike,
  McpToolInfo,
  Tool,
  ToolContext,
  ToolResult,
} from "../shared/types.js";
import { toJsonSchema } from "../mcp/schema.js";

/** Builds the current MCP tool adapters; call again after mcp.start()/reload() to refresh. */
export function createMcpTools(manager: McpManagerLike): Tool[] {
  return manager.tools().map((info) => createMcpTool(manager, info));
}

function createMcpTool(manager: McpManagerLike, info: McpToolInfo): Tool {
  const parameters: JsonSchema = toJsonSchema(info.parameters);
  return {
    name: info.name,
    description: info.description,
    parameters,
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      ctx.log.debug("MCP tool call", { tool: info.name, server: info.serverId });
      return manager.callTool(info.name, args);
    },
  };
}
