/**
 * Gemini Live provider (BidiGenerateContent over WebSocket).
 *
 * Protocol facts: docs/research-providers.md §2. Setup goes in the first frame, text turns use
 * `clientContent{turns,turnComplete}`, microphone audio uses `realtimeInput{audio}` (PCM16
 * 16 kHz), tool results use `toolResponse{functionResponses}`. The server streams
 * `serverContent` with `modelTurn.parts[].inlineData` (PCM16 24 kHz, resampled to 16 kHz here),
 * `outputTranscription`, `interrupted` and `turnComplete`, plus separate `toolCall`, `goAway`
 * and `usageMetadata` messages.
 *
 * Not verified against a live API key (none available): request shapes follow the public
 * reference, and the parser/resampler are unit-tested offline.
 *
 * Native audio arrives through ProviderContext.onSpeechAudio as PCM16 16 kHz mono *and* the
 * full chunk list in ProviderReply.audio. The addon audio module must not be imported here
 * (module isolation), so a small linear resampler lives at the bottom of this file.
 */

import { WebSocket, type RawData } from "ws";
import { z } from "zod";
import type {
  ChatMessage,
  GeminiLiveProviderConfig,
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
  asPlainObject,
  createAbortScope,
  errorMessage,
  tryParseJson,
} from "./util.js";

export const GEMINI_LIVE_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  tools: true,
  nativeAudio: true,
  tts: true,
  models: true,
};

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
const GEMINI_LIVE_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const GEMINI_INPUT_SAMPLE_RATE = 16_000;
const GEMINI_OUTPUT_SAMPLE_RATE = 16_000;
/** Gemini Live always returns 24 kHz audio (research-providers.md §2). */
const GEMINI_NATIVE_OUTPUT_SAMPLE_RATE = 24_000;
const HEALTH_TIMEOUT_MS = 8_000;

// ─────────────────────────────────────────────────────────────────── events ──

export interface GeminiAudioChunk {
  /** PCM16 mono samples at `sampleRate`. */
  data: Int16Array;
  sampleRate: number;
  mimeType: string;
}

export interface GeminiServerContent {
  /** Text parts of modelTurn (used for the TEXT response modality). */
  modelText: string;
  /** Incremental output transcription (used for the AUDIO response modality). */
  outputTranscription: string;
  audio: GeminiAudioChunk[];
  /** Server detected barge-in: drop queued playback. */
  interrupted: boolean;
  turnComplete: boolean;
  generationComplete: boolean;
}

export type GeminiServerEvent =
  | { type: "setupComplete" }
  | { type: "content"; content: GeminiServerContent }
  | { type: "toolCall"; toolCalls: ToolCall[] }
  | { type: "usage"; inputTokens: number | null; outputTokens: number | null }
  | { type: "goAway"; timeLeft: string | null }
  | { type: "closed"; reason: string };

// ─────────────────────────────────────────────────────────────────── parser ──

const geminiFunctionCallSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  args: z.record(z.unknown()).optional(),
});

const geminiPartSchema = z.object({
  text: z.string().optional(),
  inlineData: z
    .object({
      mimeType: z.string().optional(),
      data: z.string(),
    })
    .optional(),
  functionCall: geminiFunctionCallSchema.optional(),
});

const geminiContentSchema = z.object({
  role: z.string().optional(),
  parts: z.array(geminiPartSchema).optional(),
});

const geminiServerContentSchema = z.object({
  modelTurn: geminiContentSchema.optional(),
  inputTranscription: z.object({ text: z.string().optional() }).optional(),
  outputTranscription: z.object({ text: z.string().optional() }).optional(),
  interrupted: z.boolean().optional(),
  turnComplete: z.boolean().optional(),
  generationComplete: z.boolean().optional(),
});

const geminiToolCallSchema = z.object({
  functionCalls: z.array(geminiFunctionCallSchema).optional(),
});

const geminiServerMessageSchema = z.object({
  setupComplete: z.unknown().optional(),
  serverContent: geminiServerContentSchema.optional(),
  toolCall: geminiToolCallSchema.optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      responseTokenCount: z.number().optional(),
      totalTokenCount: z.number().optional(),
    })
    .optional(),
  goAway: z.object({ timeLeft: z.string().optional() }).optional(),
});

type GeminiServerContentPayload = z.infer<typeof geminiServerContentSchema>;
type GeminiFunctionCallPayload = z.infer<typeof geminiFunctionCallSchema>;
type GeminiToolCallPayload = z.infer<typeof geminiToolCallSchema>;

/**
 * Parses one BidiGenerateContent server frame. Returns null for non-JSON input and an empty
 * list for JSON with no fields this adapter understands, so callers can log and continue.
 */
export function parseGeminiServerMessage(raw: string): GeminiServerEvent[] | null {
  const parsedJson = tryParseJson(raw);
  if (parsedJson === undefined) return null;
  const parsed = geminiServerMessageSchema.safeParse(parsedJson);
  if (!parsed.success) return [];
  const message = parsed.data;
  const events: GeminiServerEvent[] = [];
  if (message.setupComplete !== undefined) events.push({ type: "setupComplete" });
  if (message.serverContent !== undefined) {
    events.push({ type: "content", content: toServerContent(message.serverContent) });
  }
  const toolCalls = collectToolCalls(message.serverContent, message.toolCall);
  if (toolCalls.length > 0) events.push({ type: "toolCall", toolCalls });
  if (message.usageMetadata !== undefined) {
    events.push({
      type: "usage",
      inputTokens: message.usageMetadata.promptTokenCount ?? null,
      outputTokens: message.usageMetadata.responseTokenCount ?? null,
    });
  }
  if (message.goAway !== undefined) events.push({ type: "goAway", timeLeft: message.goAway.timeLeft ?? null });
  return events;
}

function toServerContent(payload: GeminiServerContentPayload): GeminiServerContent {
  const parts = payload.modelTurn?.parts ?? [];
  let modelText = "";
  const audio: GeminiAudioChunk[] = [];
  for (const part of parts) {
    if (typeof part.text === "string" && part.text.length > 0) modelText += part.text;
    if (part.inlineData !== undefined) {
      const chunk = decodeInlineAudio(part.inlineData);
      if (chunk !== null) audio.push(chunk);
    }
  }
  return {
    modelText,
    outputTranscription: payload.outputTranscription?.text ?? "",
    audio,
    interrupted: payload.interrupted === true,
    turnComplete: payload.turnComplete === true,
    generationComplete: payload.generationComplete === true,
  };
}

function collectToolCalls(
  content: GeminiServerContentPayload | undefined,
  toolCall: GeminiToolCallPayload | undefined,
): ToolCall[] {
  const calls: ToolCall[] = [];
  const append = (functionCalls: readonly GeminiFunctionCallPayload[] | undefined): void => {
    for (const functionCall of functionCalls ?? []) {
      const name = functionCall.name?.trim() ?? "";
      if (name.length === 0) continue;
      const providedId = functionCall.id?.trim() ?? "";
      calls.push({
        id: providedId.length > 0 ? providedId : `gemini_call_${calls.length}`,
        name,
        argumentsJson: JSON.stringify(functionCall.args ?? {}),
      });
    }
  };
  const parts = content?.modelTurn?.parts ?? [];
  append(parts.flatMap((part) => (part.functionCall === undefined ? [] : [part.functionCall])));
  append(toolCall?.functionCalls);
  const unique: ToolCall[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    const key = `${call.id}|${call.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(call);
  }
  return unique;
}

function parseSampleRate(mimeType: string | undefined): number {
  if (mimeType === undefined) return GEMINI_NATIVE_OUTPUT_SAMPLE_RATE;
  const match = /rate=(\d+)/.exec(mimeType);
  if (match === null) return GEMINI_NATIVE_OUTPUT_SAMPLE_RATE;
  const rate = Number(match[1]);
  return Number.isFinite(rate) && rate > 0 ? rate : GEMINI_NATIVE_OUTPUT_SAMPLE_RATE;
}

function decodeInlineAudio(inline: { mimeType?: string | undefined; data: string }): GeminiAudioChunk | null {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(inline.data, "base64");
  } catch (error) {
    throw new Error(`gemini-live: invalid base64 audio payload: ${errorMessage(error)}`);
  }
  if (bytes.length < 2) return null;
  const samples = new Int16Array(Math.floor(bytes.length / 2));
  for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readInt16LE(index * 2);
  const mimeType = inline.mimeType ?? `audio/pcm;rate=${GEMINI_NATIVE_OUTPUT_SAMPLE_RATE}`;
  return { data: samples, sampleRate: parseSampleRate(mimeType), mimeType };
}

/**
 * Linear-interpolation PCM16 resampler. Deliberately local: importing addon/src/audio/pcm.ts
 * from this module would break the module-isolation rule in AGENTS.md.
 */
export function resamplePcm16(input: Int16Array, fromSampleRate: number, toSampleRate: number): Int16Array {
  if (input.length === 0 || fromSampleRate === toSampleRate || toSampleRate <= 0 || fromSampleRate <= 0) return input;
  const ratio = toSampleRate / fromSampleRate;
  const outputLength = Math.max(1, Math.floor(input.length * ratio));
  const output = new Int16Array(outputLength);
  const step = fromSampleRate / toSampleRate;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * step;
    const leftIndex = Math.floor(position);
    const fraction = position - leftIndex;
    const left = input[Math.min(leftIndex, input.length - 1)] ?? 0;
    const right = input[Math.min(leftIndex + 1, input.length - 1)] ?? 0;
    const sample = Math.round(left + (right - left) * fraction);
    output[index] = Math.max(-32_768, Math.min(32_767, sample));
  }
  return output;
}

// ───────────────────────────────────────────────────────────────── outgoing ──

export interface GeminiSetupOptions {
  model: string;
  systemPrompt: string;
  tools: readonly ToolSpec[];
  responseModality: "AUDIO" | "TEXT";
  voice: string;
}

/** Builds the `{setup: ...}` frame sent right after the socket opens. */
export function buildSetupMessage(options: GeminiSetupOptions): Record<string, unknown> {
  const model = options.model.trim().startsWith("models/") ? options.model.trim() : `models/${options.model.trim()}`;
  const generationConfig: Record<string, unknown> = { responseModalities: [options.responseModality] };
  const setup: Record<string, unknown> = {
    model,
    generationConfig,
    systemInstruction: { parts: [{ text: options.systemPrompt }] },
  };
  if (options.responseModality === "AUDIO") {
    generationConfig.speechConfig = {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice } },
    };
    // Required to receive serverContent.outputTranscription for the spoken answer.
    setup.outputAudioTranscription = {};
  }
  if (options.tools.length > 0) {
    setup.tools = [
      {
        functionDeclarations: options.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      },
    ];
  }
  return { setup };
}

/** One part of a `clientContent` turn. */
export type LiveTurnPart =
  | { text: string }
  | { functionCall: { id?: string; name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export interface LiveTurn {
  role: "user" | "model";
  parts: LiveTurnPart[];
}

/** Maps a ChatMessage history to Live API turns (tool calls and tool results included). */
export function buildLiveTurns(history: readonly ChatMessage[]): LiveTurn[] {
  const turns: LiveTurn[] = [];
  const push = (role: LiveTurn["role"], parts: LiveTurnPart[]): void => {
    if (parts.length === 0) return;
    const last = turns[turns.length - 1];
    if (last !== undefined && last.role === role) {
      last.parts.push(...parts);
      return;
    }
    turns.push({ role, parts });
  };
  for (const message of history) {
    if (message.role === "user") {
      push("user", [{ text: message.content }]);
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = message.toolCalls ?? [];
      if (toolCalls.length > 0) {
        push("model", toolCalls.map(toFunctionCallPart));
      } else if (message.content.trim().length > 0) {
        push("model", [{ text: message.content }]);
      }
      continue;
    }
    if (message.role === "tool") {
      push("user", [
        {
          functionResponse: {
            name: message.toolName ?? "",
            response: toolResponsePayload(message.content),
          },
        },
      ]);
    }
  }
  return turns;
}

function toFunctionCallPart(call: ToolCall): LiveTurnPart {
  const args = asPlainObject(tryParseJson(call.argumentsJson)) ?? {};
  const functionCall: { id?: string; name: string; args: Record<string, unknown> } = { name: call.name, args };
  if (call.id.length > 0) functionCall.id = call.id;
  return { functionCall };
}

function toolResponsePayload(content: string): Record<string, unknown> {
  const parsed = asPlainObject(tryParseJson(content));
  if (parsed !== undefined) return parsed;
  return { result: content };
}

/** `realtimeInput` frame with PCM16 16 kHz mono microphone audio. */
export function buildRealtimeAudioInput(pcm: Int16Array, sampleRate: number = GEMINI_INPUT_SAMPLE_RATE): Record<string, unknown> {
  const bytes = Buffer.alloc(pcm.length * 2);
  for (let index = 0; index < pcm.length; index += 1) bytes.writeInt16LE(pcm[index] ?? 0, index * 2);
  return {
    realtimeInput: {
      audio: {
        mimeType: `audio/pcm;rate=${sampleRate}`,
        data: bytes.toString("base64"),
      },
    },
  };
}

export interface GeminiFunctionResponse {
  name: string;
  response: Record<string, unknown>;
}

// ──────────────────────────────────────────────────────────────── connection ──

function buildLiveUrl(apiKey: string): string {
  return `${GEMINI_LIVE_ENDPOINT}?key=${encodeURIComponent(apiKey.trim())}`;
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

/**
 * One Live API WebSocket session. `connect` resolves after `setupComplete`; server events are
 * delivered to subscribers. Reconnect/resumption across the 10–15 min limits is not
 * implemented here: one brain turn opens one short-lived session.
 */
export class GeminiLiveConnection {
  private socket: WebSocket | null = null;
  private readonly listeners: Array<(event: GeminiServerEvent) => void> = [];
  private readonly config: GeminiLiveProviderConfig;
  private readonly log: LoggerLike;

  constructor(config: GeminiLiveProviderConfig, log: LoggerLike) {
    this.config = config;
    this.log = log;
  }

  /** Subscribes to server events; returns an unsubscribe function. */
  onEvent(listener: (event: GeminiServerEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  /** Opens the socket, sends the setup frame and waits for setupComplete. */
  async connect(setupPayload: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    const apiKey = this.config.apiKey.trim();
    if (apiKey.length === 0) throw new Error("gemini-live: API key is not configured");
    if (this.socket !== null) throw new Error("gemini-live: connection is already open");
    if (signal.aborted) throw abortedError("gemini-live: connection aborted");
    const socket = new WebSocket(buildLiveUrl(apiKey));
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onAbort = (): void => {
        this.close();
        settle(abortedError("gemini-live: connection aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      socket.on("open", () => {
        socket.send(JSON.stringify(setupPayload));
      });
      socket.on("message", (data: RawData) => {
        const events = parseGeminiServerMessage(rawDataToString(data));
        if (events === null) {
          this.log.warn("gemini-live: skipping non-JSON server frame");
          return;
        }
        for (const event of events) {
          if (event.type === "setupComplete") settle();
          else this.emit(event);
        }
      });
      socket.on("error", (error: Error) => {
        this.emit({ type: "closed", reason: errorMessage(error) });
        settle(new Error(`gemini-live: websocket error: ${redactKey(errorMessage(error), apiKey)}`));
      });
      socket.on("close", (code: number, reason: Buffer) => {
        const text = reason.toString("utf8").trim();
        this.emit({ type: "closed", reason: text.length > 0 ? text : `closed with code ${code}` });
        const detail = text.length > 0 ? `: ${redactKey(text, apiKey)}` : "";
        settle(new Error(`gemini-live: connection closed before setup completed (code ${code}${detail})`));
      });
    });
  }

  /** Sends one text conversation turn. */
  sendTurns(turns: readonly LiveTurn[]): void {
    this.send({ clientContent: { turns, turnComplete: true } });
  }

  /** Sends raw PCM16 16 kHz microphone audio (native speech-to-speech input path). */
  sendAudio(pcm: Int16Array): void {
    this.send(buildRealtimeAudioInput(pcm));
  }

  /** Sends function responses for a tool call received from the model. */
  sendFunctionResponses(responses: readonly GeminiFunctionResponse[]): void {
    this.send({ toolResponse: { functionResponses: responses } });
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket === null) return;
    try {
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close(1000, "client close");
    } catch (error) {
      this.log.debug("gemini-live: failed to close socket", { error: errorMessage(error) });
    }
  }

  private send(payload: Record<string, unknown>): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      throw new Error("gemini-live: websocket is not open");
    }
    socket.send(JSON.stringify(payload));
  }

  private emit(event: GeminiServerEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

function redactKey(text: string, apiKey: string): string {
  return apiKey.length === 0 ? text : text.split(apiKey).join("***");
}

// ─────────────────────────────────────────────────────────────────── provider ──

export interface GeminiLiveProviderDeps {
  log: LoggerLike;
}

export function createGeminiLiveProvider(deps: GeminiLiveProviderDeps): ProviderLike {
  const log = deps.log.child("gemini-live");
  return {
    id: "gemini-live",
    label: "Gemini Live",
    capabilities: GEMINI_LIVE_CAPABILITIES,
    health: (config) => checkGeminiHealth(config.provider.geminiLive, log),
    listModels: (config) => fetchGeminiModels(config.provider.geminiLive, log),
    generate: (ctx) => runLiveTurn(ctx, log),
  };
}

async function runLiveTurn(ctx: ProviderContext, log: LoggerLike): Promise<ProviderReply> {
  const providerConfig = ctx.config.provider.geminiLive;
  if (providerConfig.apiKey.trim().length === 0) throw new Error("gemini-live: API key is not configured");
  const connection = new GeminiLiveConnection(providerConfig, log);
  const scope = createAbortScope(ctx.config.conversation.requestTimeoutMs, ctx.signal);
  let rejectTurn: (error: Error) => void = () => {};
  let unsubscribe: () => void = () => {};
  const turn = new Promise<ProviderReply>((resolve, reject) => {
    let settled = false;
    const textParts: string[] = [];
    const audioChunks: Int16Array[] = [];
    let usage: ProviderReply["usage"];
    const buildReply = (toolCalls: ToolCall[], finish: ProviderReply["finish"]): ProviderReply => {
      const text = textParts.join("");
      const reply: ProviderReply = { text, speech: text, toolCalls, finish };
      if (audioChunks.length > 0) reply.audio = audioChunks;
      if (usage !== undefined) reply.usage = usage;
      return reply;
    };
    const finishTurn = (toolCalls: ToolCall[], finish: ProviderReply["finish"]): void => {
      if (settled) return;
      settled = true;
      resolve(buildReply(toolCalls, finish));
    };
    const failTurn = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    rejectTurn = failTurn;
    unsubscribe = connection.onEvent((event) => {
      switch (event.type) {
        case "content": {
          for (const chunk of event.content.audio) {
            const resampled = resamplePcm16(chunk.data, chunk.sampleRate, GEMINI_OUTPUT_SAMPLE_RATE);
            if (resampled.length === 0) continue;
            audioChunks.push(resampled);
            ctx.onSpeechAudio?.(resampled);
          }
          const delta = `${event.content.modelText}${event.content.outputTranscription}`;
          if (delta.length > 0) {
            textParts.push(delta);
            ctx.onDelta?.(delta);
          }
          if (event.content.interrupted) log.debug("gemini-live: response interrupted by barge-in");
          if (event.content.turnComplete) finishTurn([], "stop");
          break;
        }
        case "toolCall":
          finishTurn(event.toolCalls, "tool_calls");
          break;
        case "usage": {
          const mapped: NonNullable<ProviderReply["usage"]> = {};
          if (event.inputTokens !== null) mapped.inputTokens = event.inputTokens;
          if (event.outputTokens !== null) mapped.outputTokens = event.outputTokens;
          usage = mapped;
          break;
        }
        case "goAway":
          log.warn("gemini-live: server sent goAway, session will end soon", { timeLeft: event.timeLeft });
          break;
        case "closed":
          failTurn(new Error(`gemini-live: connection closed: ${event.reason}`));
          break;
        case "setupComplete":
          break;
      }
    });
  });

  // If connect() fails first the turn promise is never awaited; keep a no-op handler so a
  // later close/error event cannot surface as an unhandled rejection. The success path still
  // observes the rejection through `await turn`.
  turn.catch(() => {
    /* handled by the awaited branch below */
  });

  const onAbort = (): void => {
    connection.close();
    rejectTurn(abortedError("gemini-live: turn aborted"));
  };
  scope.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const setupPayload = buildSetupMessage({
      model: providerConfig.model,
      systemPrompt: ctx.systemPrompt,
      tools: ctx.tools,
      responseModality: providerConfig.responseModality,
      voice: providerConfig.voice,
    });
    await connection.connect(setupPayload, scope.signal);
    if (scope.signal.aborted) throw abortedError("gemini-live: turn aborted");
    connection.sendTurns(buildLiveTurns(ctx.history));
    return await turn;
  } catch (error) {
    if (scope.timedOut()) throw new Error(`gemini-live: request timed out after ${ctx.config.conversation.requestTimeoutMs} ms`);
    throw error;
  } finally {
    scope.signal.removeEventListener("abort", onAbort);
    unsubscribe();
    connection.close();
    scope.dispose();
  }
}

async function fetchGeminiModels(config: GeminiLiveProviderConfig, log: LoggerLike): Promise<string[]> {
  const apiKey = config.apiKey.trim();
  if (apiKey.length === 0) throw new Error("gemini-live: API key is not configured");
  const scope = createAbortScope(HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${GEMINI_API_BASE}/v1beta/models?key=${encodeURIComponent(apiKey)}`, {
      signal: scope.signal,
    });
    if (!response.ok) {
      // The request URL carries the API key, so it is never echoed into error messages.
      throw new Error(`gemini-live: models endpoint returned HTTP ${response.status}`);
    }
    const parsed = geminiModelsSchema.safeParse(tryParseJson(await response.text()));
    if (!parsed.success) throw new Error("gemini-live: unexpected /v1beta/models response shape");
    const models = parsed.data.models ?? [];
    const liveCapable = models.filter((model) => (model.supportedGenerationMethods ?? []).includes("bidiGenerateContent"));
    const selected = liveCapable.length > 0 ? liveCapable : models;
    log.debug("gemini-live: models fetched", { total: models.length, liveCapable: liveCapable.length });
    return selected.map((model) => normalizeModelId(model.name));
  } catch (error) {
    if (scope.timedOut()) throw new Error(`gemini-live: models request timed out after ${HEALTH_TIMEOUT_MS} ms`);
    throw error;
  } finally {
    scope.dispose();
  }
}

const geminiModelsSchema = z.object({
  models: z
    .array(
      z.object({
        name: z.string(),
        supportedGenerationMethods: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

function normalizeModelId(model: string): string {
  return model.trim().replace(/^models\//, "");
}

async function checkGeminiHealth(config: GeminiLiveProviderConfig, log: LoggerLike): Promise<ProviderHealth> {
  if (config.apiKey.trim().length === 0) return { ok: false, detail: "API key is not configured" };
  try {
    const ids = await fetchGeminiModels(config, log);
    if (ids.length === 0) return { ok: true, detail: "API key is valid; no models returned" };
    const wanted = normalizeModelId(config.model);
    return ids.includes(wanted)
      ? { ok: true, detail: `model "${config.model}" is available` }
      : { ok: true, detail: `API key is valid; model "${config.model}" is not in the list` };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}
