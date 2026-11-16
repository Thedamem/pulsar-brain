/**
 * Narrowing helpers for MCP-provided JSON. MCP servers send arbitrary JSON Schema objects;
 * shared types expect the stricter `JsonSchema` shape, so unknown fields are dropped instead
 * of trusted.
 */

import type { JsonSchema } from "../shared/types.js";

const SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Converts an MCP tool input schema into a shared `JsonSchema`.
 * A missing or non-primitive root `type` falls back to `"object"`, which is what MCP requires
 * for tool arguments.
 */
export function toJsonSchema(value: unknown): JsonSchema {
  if (!isRecord(value)) return { type: "object" };

  const type = typeof value.type === "string" && SCHEMA_TYPES.has(value.type) ? value.type : "object";
  const schema: JsonSchema = { type };

  if (typeof value.description === "string") schema.description = value.description;

  if (isRecord(value.properties)) {
    const properties: Record<string, JsonSchema> = {};
    for (const [name, property] of Object.entries(value.properties)) {
      properties[name] = toJsonSchema(property);
    }
    schema.properties = properties;
  }

  if (isRecord(value.items)) schema.items = toJsonSchema(value.items);

  if (Array.isArray(value.required)) {
    const required = value.required.filter((name): name is string => typeof name === "string");
    if (required.length > 0) schema.required = required;
  }

  if (Array.isArray(value.enum)) {
    const allowed = value.enum.filter(
      (item): item is string | number | boolean =>
        typeof item === "string" || typeof item === "number" || typeof item === "boolean",
    );
    if (allowed.length > 0) schema.enum = allowed;
  }

  const additionalProperties = value.additionalProperties;
  if (typeof additionalProperties === "boolean") schema.additionalProperties = additionalProperties;
  else if (isRecord(additionalProperties)) schema.additionalProperties = toJsonSchema(additionalProperties);

  if ("default" in value) schema.default = value.default;

  return schema;
}
