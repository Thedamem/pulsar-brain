/**
 * OpenAI-compatible Chat Completions provider: streaming SSE, tool calls, usage, abort
 * and request timeouts. The generic client is also reused by the OpenClaw adapter.
 *
 * Wire format: POST {baseUrl}/chat/completions, GET {baseUrl}/models (baseUrl includes /v1,
 * e.g. https://api.openai.com/v1 or https://openrouter.ai/api/v1).
 */

import { z } from "zod";
import type {
  AppConfig,
  ChatMessage,
  LoggerLike,
  ProviderCapabilities,
  ProviderContext,
  ProviderHealth,
  ProviderLike,
  ProviderReply,
  ToolCall,
  ToolSpec,
} from "../shared/types.js";
import {
  abortedError,
  createAbortScope,
  errorMessage,
  isHttpUrl,
  joinUrl,
  redactSecret,
  shortenDetail,
  tryParseJson,
} from "./util.js";

export const OPENAI_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  tools: true,
  nativeAudio: false,
  tts: false,
  models: true,
};

const HEALTH_TIMEOUT_MS = 8_000;
const MODELS_TIMEOUT_MS = 10_000;
const MAX_ERROR_DETAIL_CHARS = 300;

export interface LlmProviderDeps {
  log: LoggerLike;
}

// ──────────────────────────────────────────────────────────────────── target ──

/** Everything needed to issue one chat-completions request against an OpenAI-like server. */
export interface ChatCompletionTarget {
  /** Name used in log and error messages, e.g. "openai". */
  name: string;
  /** Full chat completions URL. */
  chatUrl: string;
  /** Full models URL; null when the provider cannot list models. */
  modelsUrl: string | null;
  apiKey: string;
  model: string;
  headers: Record<string, string>;
  temperature: number | null;
  maxTokens: number | null;
  /** Request timeout in ms; 0 disables it. */
  requestTimeoutMs: number;
  log: LoggerLike;
}

function resolveOpenAiTarget(config: AppConfig, log: LoggerLike): ChatCompletionTarget {
  const provider = config.provider.openai;
  return {
    name: "openai",
    chatUrl: joinUrl(provider.baseUrl, "chat/completions"),
    modelsUrl: joinUrl(provider.baseUrl, "models"),
    apiKey: provider.apiKey,
    model: provider.model,
    headers: provider.extraHeaders,
    temperature: provider.temperature,
    maxTokens: provider.maxTokens,
    requestTimeoutMs: config.conversation.requestTimeoutMs,
    log,
  };
}

export function createOpenAiProvider(deps: LlmProviderDeps): ProviderLike {
  const log = deps.log.child("openai");
  return {
    id: "openai",
    label: "OpenAI-совместимый",
    capabilities: OPENAI_CAPABILITIES,
    health: (config) => probeModels(resolveOpenAiTarget(config, log)),
    listModels: (config) => fetchModelIds(resolveOpenAiTarget(config, log), MODELS_TIMEOUT_MS),
    generate: (ctx) => runChatCompletion(resolveOpenAiTarget(ctx.config, log), ctx),
  };
}

// ──────────────────────────────────────────────────────────────── messages ──

interface OpenAiToolCallPayload {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type OpenAiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCallPayload[] }
  | { role: "tool"; tool_call_id: string; content: string };

function toOpenAiToolCall(call: ToolCall): OpenAiToolCallPayload {
  return { id: call.id, type: "function", function: { name: call.name, arguments: call.argumentsJson } };
}

function buildChatMessages(systemPrompt: string, history: readonly ChatMessage[]): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [{ role: "system", content: systemPrompt }];
  for (const message of history) {
    if (message.role === "tool") {
      messages.push({ role: "tool", tool_call_id: message.toolCallId ?? "", content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = message.toolCalls ?? [];
      if (toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: message.content.length > 0 ? message.content : null,
          tool_calls: toolCalls.map(toOpenAiToolCall),
        });
      } else {
        messages.push({ role: "assistant", content: message.content });
      }
      continue;
    }
    if (message.role === "system") {
      messages.push({ role: "system", content: message.content });
      continue;
    }
    messages.push({ role: "user", content: message.content });
  }
  return messages;
}

function buildToolDefinitions(tools: readonly ToolSpec[]): Array<{ type: "function"; function: { name: string; description: string; parameters: ToolSpec["parameters"] } }> {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

function buildRequestBody(target: ChatCompletionTarget, ctx: ProviderContext): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: target.model,
    messages: buildChatMessages(ctx.systemPrompt, ctx.history),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (target.temperature !== null) body.temperature = target.temperature;
  if (target.maxTokens !== null) body.max_tokens = target.maxTokens;
  if (ctx.tools.length > 0) {
    body.tools = buildToolDefinitions(ctx.tools);
    body.tool_choice = "auto";
  }
  return body;
}

// ────────────────────────────────────────────────────────────── sse parsing ──

const streamToolCallSchema = z.object({
  index: z.number().int().nonnegative().optional(),
  id: z.string().optional(),
  function: z
    .object({
      name: z.string().optional(),
      arguments: z.string().optional(),
    })
    .optional(),
});

const streamDeltaSchema = z.object({
  content: z.string().nullable().optional(),
  tool_calls: z.array(streamToolCallSchema).nullable().optional(),
});

const streamChoiceSchema = z.object({
  delta: streamDeltaSchema.nullable().optional(),
  finish_reason: z.string().nullable().optional(),
});

const streamUsageSchema = z.object({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
});

const streamChunkSchema = z.object({
  choices: z.array(streamChoiceSchema).nullable().optional(),
  usage: streamUsageSchema.nullable().optional(),
});

interface AggregatedToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

interface StreamState {
  text: string;
  finishReason: string | null;
  usage: ProviderReply["usage"];
  toolCalls: Map<number, AggregatedToolCall>;
}

function mapUsage(usage: z.infer<typeof streamUsageSchema>): ProviderReply["usage"] {
  const mapped: NonNullable<ProviderReply["usage"]> = {};
  if (typeof usage.prompt_tokens === "number") mapped.inputTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === "number") mapped.outputTokens = usage.completion_tokens;
  return mapped;
}

function applyStreamChunk(
  data: string,
  state: StreamState,
  target: ChatCompletionTarget,
  onDelta?: (text: string) => void,
): void {
  const parsed = streamChunkSchema.safeParse(tryParseJson(data));
  if (!parsed.success) {
    target.log.debug("openai: skipping malformed SSE chunk", { reason: parsed.error.issues[0]?.message ?? "schema mismatch" });
    return;
  }
  for (const choice of parsed.data.choices ?? []) {
    const delta = choice.delta;
    if (delta !== null && delta !== undefined) {
      if (typeof delta.content === "string" && delta.content.length > 0) {
        state.text += delta.content;
        onDelta?.(delta.content);
      }
      const toolDeltas = delta.tool_calls ?? [];
      for (const [position, toolDelta] of toolDeltas.entries()) {
        const index = toolDelta.index ?? position;
        const aggregated = state.toolCalls.get(index) ?? { id: "", name: "", argumentsJson: "" };
        if (typeof toolDelta.id === "string" && toolDelta.id.length > 0) aggregated.id = toolDelta.id;
        const functionDelta = toolDelta.function;
        if (functionDelta !== undefined) {
          if (typeof functionDelta.name === "string" && functionDelta.name.length > 0) aggregated.name += functionDelta.name;
          if (typeof functionDelta.arguments === "string") aggregated.argumentsJson += functionDelta.arguments;
        }
        state.toolCalls.set(index, aggregated);
      }
    }
    if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
      state.finishReason = choice.finish_reason;
    }
  }
  if (parsed.data.usage !== null && parsed.data.usage !== undefined) {
    state.usage = mapUsage(parsed.data.usage);
  }
}

function processSseBlock(
  block: string,
  state: StreamState,
  target: ChatCompletionTarget,
  onDelta?: (text: string) => void,
): boolean {
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (data.length === 0) continue;
    if (data === "[DONE]") return true;
    applyStreamChunk(data, state, target, onDelta);
  }
  return false;
}

async function readCompletionStream(
  target: ChatCompletionTarget,
  body: ReadableStream<Uint8Array>,
  onDelta?: (text: string) => void,
): Promise<ProviderReply> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const state: StreamState = { text: "", finishReason: null, usage: undefined, toolCalls: new Map() };
  let buffer = "";
  let streamDone = false;
  try {
    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (processSseBlock(block, state, target, onDelta)) {
          streamDone = true;
          break;
        }
      }
    }
    if (!streamDone && buffer.trim().length > 0) processSseBlock(buffer, state, target, onDelta);
  } finally {
    reader.releaseLock();
  }

  const toolCalls: ToolCall[] = [];
  const aggregatedCalls = [...state.toolCalls.entries()].sort((left, right) => left[0] - right[0]);
  for (const [index, aggregated] of aggregatedCalls) {
    if (aggregated.name.length === 0) {
      target.log.warn("openai: dropping tool call without a name", { index });
      continue;
    }
    toolCalls.push({
      id: aggregated.id.length > 0 ? aggregated.id : `call_${index}`,
      name: aggregated.name,
      argumentsJson: aggregated.argumentsJson.length > 0 ? aggregated.argumentsJson : "{}",
    });
  }
  const finish: ProviderReply["finish"] =
    toolCalls.length > 0 ? "tool_calls" : state.finishReason === "length" ? "length" : "stop";
  const reply: ProviderReply = { text: state.text, speech: state.text, toolCalls, finish };
  if (state.usage !== undefined) reply.usage = state.usage;
  return reply;
}

// ───────────────────────────────────────────────────────────────── transport ──

function buildHeaders(target: ChatCompletionTarget): Record<string, string> {
  const headers: Record<string, string> = { ...target.headers, Accept: "text/event-stream" };
  if (target.apiKey.trim().length > 0) headers.Authorization = `Bearer ${target.apiKey.trim()}`;
  return headers;
}

function buildPostHeaders(target: ChatCompletionTarget): Record<string, string> {
  return { ...buildHeaders(target), "Content-Type": "application/json" };
}

function buildGetHeaders(target: ChatCompletionTarget): Record<string, string> {
  return { ...buildHeaders(target), Accept: "application/json" };
}

function assertEndpoint(target: ChatCompletionTarget): void {
  if (!isHttpUrl(target.chatUrl)) throw new Error(`${target.name}: base URL is not configured`);
}

async function requestError(target: ChatCompletionTarget, response: Response): Promise<Error> {
  let detail = "";
  try {
    detail = shortenDetail(await response.text(), MAX_ERROR_DETAIL_CHARS);
  } catch (error) {
    target.log.debug("openai: failed to read error response body", { error: errorMessage(error) });
  }
  const safeDetail = redactSecret(detail, target.apiKey);
  const suffix = safeDetail.length > 0 ? `: ${safeDetail}` : "";
  return new Error(`${target.name}: HTTP ${response.status} ${response.statusText}${suffix}`);
}

/**
 * Runs one streaming chat completion. Tool calls are aggregated by index across deltas and
 * text deltas are forwarded to `onDelta` for the UI/log stream.
 */
export async function runChatCompletion(target: ChatCompletionTarget, ctx: ProviderContext): Promise<ProviderReply> {
  assertEndpoint(target);
  const scope = createAbortScope(target.requestTimeoutMs, ctx.signal);
  try {
    if (scope.signal.aborted) throw abortedError(`${target.name}: request aborted`);
    const response = await fetch(target.chatUrl, {
      method: "POST",
      headers: buildPostHeaders(target),
      body: JSON.stringify(buildRequestBody(target, ctx)),
      signal: scope.signal,
    });
    if (!response.ok) throw await requestError(target, response);
    if (response.body === null) throw new Error(`${target.name}: response has no body`);
    return await readCompletionStream(target, response.body, ctx.onDelta);
  } catch (error) {
    if (scope.timedOut()) throw new Error(`${target.name}: request timed out after ${target.requestTimeoutMs} ms`);
    throw error;
  } finally {
    scope.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────── models ──

const modelsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string() })),
});

/** Fetches model ids from a `/models` endpoint; throws a readable error on failure. */
export async function fetchModelIds(target: ChatCompletionTarget, timeoutMs: number): Promise<string[]> {
  if (target.modelsUrl === null) return [];
  if (!isHttpUrl(target.modelsUrl)) throw new Error(`${target.name}: base URL is not configured`);
  const scope = createAbortScope(timeoutMs);
  try {
    const response = await fetch(target.modelsUrl, { method: "GET", headers: buildGetHeaders(target), signal: scope.signal });
    if (!response.ok) throw await requestError(target, response);
    const parsed = modelsResponseSchema.safeParse(tryParseJson(await response.text()));
    if (!parsed.success) throw new Error(`${target.name}: unexpected /models response shape`);
    return parsed.data.data.map((model) => model.id);
  } catch (error) {
    if (scope.timedOut()) throw new Error(`${target.name}: models request timed out after ${timeoutMs} ms`);
    throw error;
  } finally {
    scope.dispose();
  }
}

/** Health probe used by the status panel: reachability plus whether the model is listed. */
export async function probeModels(target: ChatCompletionTarget, timeoutMs: number = HEALTH_TIMEOUT_MS): Promise<ProviderHealth> {
  try {
    const ids = await fetchModelIds(target, timeoutMs);
    if (ids.length === 0) return { ok: true, detail: "endpoint is reachable" };
    return ids.includes(target.model)
      ? { ok: true, detail: `model "${target.model}" is available` }
      : { ok: true, detail: `endpoint is reachable, model "${target.model}" is not listed` };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}
