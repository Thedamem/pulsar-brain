/**
 * Shared domain types for pulsar-brain. This file is the interface hub between modules:
 * every module imports types from here, modules do not import each other's files.
 * Runtime wiring lives in src/index.ts (lead-owned).
 */

// ─────────────────────────────────────────────────────────────── config ──

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export type ProviderId = "openai" | "openclaw" | "gemini-live" | "mock";

export interface OpenAiProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  /** Extra headers, e.g. for RouterAI/OpenRouter. */
  extraHeaders: Record<string, string>;
}

export interface OpenClawProviderConfig {
  baseUrl: string;
  apiKey: string;
  /** Optional agent/session identifier understood by OpenClaw. */
  agentId: string;
  model: string;
}

export interface GeminiLiveProviderConfig {
  apiKey: string;
  /** Model id, e.g. gemini-live-2.5-flash-preview (validated against live docs). */
  model: string;
  voice: string;
  /** AUDIO = native speech-to-speech, TEXT = text reply through same session. */
  responseModality: "AUDIO" | "TEXT";
}

export interface MockProviderConfig {
  mode: "smart" | "echo" | "scripted";
  /** For scripted mode: file name inside the addon data dir with JSON steps. */
  scriptFile: string;
}

export interface ProviderConfig {
  id: ProviderId;
  openai: OpenAiProviderConfig;
  openclaw: OpenClawProviderConfig;
  geminiLive: GeminiLiveProviderConfig;
  mock: MockProviderConfig;
}

export interface EndpointingConfig {
  /** RMS threshold in dBFS below which audio counts as silence. */
  silenceThresholdDb: number;
  /** Silence after speech that ends the utterance. */
  sentenceSilenceMs: number;
  /** Ignore speech shorter than this. */
  minSpeechMs: number;
  /** Hard stop for one utterance. */
  maxUtteranceMs: number;
  /** Audio kept before speech start, so the first word is not cut. */
  preRollMs: number;
}

export interface SttConfig {
  provider: "wyoming";
  host: string;
  port: number;
  language: string;
  /** Model name passed to whisper; "auto" uses server default. */
  model: string;
  endpointing: EndpointingConfig;
}

export interface PiperTtsConfig {
  host: string;
  port: number;
  voice: string;
}

export interface ProviderVoiceConfig {
  /** OpenAI-compatible /audio/speech model, e.g. gpt-4o-mini-tts or tts-1. */
  model: string;
  voice: string;
  /** wav is decoded as RIFF; pcm is treated as raw s16le at providerSampleRate. */
  format: "wav" | "pcm";
  language: string;
}

export interface TtsConfig {
  /** piper = local Piper; provider = configured LLM provider voice; auto = provider if capable else Piper. */
  mode: "piper" | "provider" | "auto";
  piper: PiperTtsConfig;
  provider: ProviderVoiceConfig;
  /** Sample rate sent to the satellite. pulsar expects 16000. */
  outputSampleRate: number;
}

export interface PromptConfig {
  system: string;
  language: string;
}

export interface ConversationConfig {
  maxHistoryTurns: number;
  followUpTimeoutMs: number;
  bargeIn: boolean;
  llmMaxToolIterations: number;
  requestTimeoutMs: number;
}

export interface HaToolsConfig {
  enabled: boolean;
  /** Override for dev outside Supervisor (e.g. http://127.0.0.1:8124). */
  url: string;
  /** Override bearer token for dev outside Supervisor. */
  token: string;
}

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "http" | "sse";
  /** stdio */
  command: string;
  args: string[];
  /** http / sse */
  url: string;
  headers: Record<string, string>;
  /** Seconds; tool call timeout. */
  toolTimeoutSec: number;
}

export interface SchedulerToolsConfig {
  enabled: boolean;
  maxActive: number;
  /** Ask for spoken confirmation before scheduling when the phrase is ambiguous. */
  confirmBeforeSchedule: boolean;
}

export interface ToolsConfig {
  ha: HaToolsConfig;
  scheduler: SchedulerToolsConfig;
  mcp: {
    servers: McpServerConfig[];
  };
}

export interface AppConfig {
  version: number;
  logLevel: LogLevel;
  provider: ProviderConfig;
  stt: SttConfig;
  tts: TtsConfig;
  prompt: PromptConfig;
  conversation: ConversationConfig;
  tools: ToolsConfig;
  /** User phrase fragment → entity_id, e.g. "свет на кухне": "light.kitchen". */
  aliases: Record<string, string>;
}

/** Config with secrets masked for API/UI responses. */
export type MaskedAppConfig = AppConfig;

// ──────────────────────────────────────────────────────────────── logger ──

export interface LogEntry {
  seq: number;
  ts: string;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
}

export interface LoggerLike {
  trace(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  /** Scoped child logger, e.g. log.child("stt"). */
  child(scope: string): LoggerLike;
  /** Entries with seq > after, oldest first. */
  since(afterSeq: number, limit?: number): LogEntry[];
  /** Subscribe to new entries; returns unsubscribe. */
  subscribe(listener: (entry: LogEntry) => void): () => void;
}

// ──────────────────────────────────────────────────────────────── config ──

export interface ConfigStoreLike {
  get(): AppConfig;
  /** Merge patch into config, persist and notify subscribers. */
  update(patch: DeepPartial<AppConfig>): Promise<AppConfig>;
  /** Config for API response: secrets replaced by mask. */
  masked(): MaskedAppConfig;
  onChange(listener: (config: AppConfig) => void): () => void;
  /** Persisted bridge bearer token (generated on first start). */
  bridgeToken(): string;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K];
};

// ───────────────────────────────────────────────────────────────────── ha ──

export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
}

export interface HaEntity {
  entity_id: string;
  name: string;
  domain: string;
  state: string;
  area_id?: string;
  device_id?: string;
}

export interface HaArea {
  area_id: string;
  name: string;
}

export interface HaServiceTarget {
  entity_id?: string | string[];
  area_id?: string | string[];
  device_id?: string | string[];
}

export interface HaCallServiceRequest {
  domain: string;
  service: string;
  target?: HaServiceTarget;
  data?: Record<string, unknown>;
}

export interface HaClientLike {
  callService(req: HaCallServiceRequest): Promise<void>;
  getState(entityId: string): Promise<HaState | null>;
  listStates(domain?: string): Promise<HaState[]>;
  listEntities(filter?: { domain?: string; query?: string; areaId?: string }): Promise<HaEntity[]>;
  listAreas(): Promise<HaArea[]>;
  listServices(): Promise<Array<{ domain: string; service: string }>>;
  available(): Promise<boolean>;
}

// ─────────────────────────────────────────────────────────────── tools ──

export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: Array<string | number | boolean>;
  additionalProperties?: boolean | JsonSchema;
  default?: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments string as returned by the model. */
  argumentsJson: string;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** Optional phrase to add to the spoken answer. */
  speech?: string;
}

export interface McpToolProxyLike {
  callTool(namespacedName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
}

export interface SchedulerApiLike {
  addOnce(input: {
    at: number;
    action: SchedulerAction;
    label: string;
    runId?: string;
  }): Promise<{ id: string; at: number }>;
  cancel(idOrAll: string): Promise<{ cancelled: number }>;
  list(): Promise<SchedulerEntry[]>;
}

export type SchedulerAction =
  | { kind: "ha.call_service"; request: HaCallServiceRequest }
  | { kind: "announce"; text: string }
  | { kind: "mcp.tool"; name: string; args: Record<string, unknown> };

export interface SchedulerEntry {
  id: string;
  at: number;
  label: string;
  action: SchedulerAction;
  runId?: string;
  createdAt: number;
}

export interface ToolContext {
  runId: string;
  ha: HaClientLike;
  scheduler: SchedulerApiLike;
  mcp: McpToolProxyLike;
  log: LoggerLike;
  config: AppConfig;
}

export interface Tool extends ToolSpec {
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolRegistryLike {
  /** Specs for the model (optionally filtered by enabled groups). */
  specs(): ToolSpec[];
  get(name: string): Tool | undefined;
  execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
  register(tool: Tool): void;
  /** Remove every tool whose name starts with prefix, e.g. "mcp."; returns removed count. */
  removeByPrefix(prefix: string): number;
}

// ──────────────────────────────────────────────────────────── providers ──

export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  nativeAudio: boolean;
  tts: boolean;
  models: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Assistant messages that requested tools must carry them back to the provider. */
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
}

export interface ProviderContext {
  systemPrompt: string;
  history: ChatMessage[];
  tools: ToolSpec[];
  config: AppConfig;
  signal: AbortSignal;
  onDelta?(text: string): void;
  onSpeechAudio?(chunk: Int16Array): void;
}

export interface ProviderReply {
  text: string;
  speech: string;
  toolCalls: ToolCall[];
  /** Native speech-to-speech audio chunks (PCM 16 kHz mono) when the provider speaks itself. */
  audio?: Int16Array[];
  finish: "stop" | "tool_calls" | "length" | "error";
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ProviderHealth {
  ok: boolean;
  detail: string;
}

export interface ProviderLike {
  id: ProviderId;
  label: string;
  capabilities: ProviderCapabilities;
  health(config: AppConfig): Promise<ProviderHealth>;
  listModels(config: AppConfig): Promise<string[]>;
  generate(ctx: ProviderContext): Promise<ProviderReply>;
}

export interface ProviderRegistryLike {
  list(): Array<{ id: ProviderId; label: string; capabilities: ProviderCapabilities }>;
  get(id: ProviderId): ProviderLike;
}

// ──────────────────────────────────────────────────────────────── audio ──

export interface PcmFormat {
  sampleRate: number;
  channels: number;
  /** Bytes per sample, 2 for s16le. */
  width: number;
}

export interface SttResult {
  text: string;
  language: string;
  /** Server-reported confidence when available. */
  confidence?: number;
}

export interface SttSession {
  /** Feed s16le PCM 16 kHz mono. */
  write(chunk: Int16Array): void;
  /** Flush and return the final transcript. */
  finish(): Promise<SttResult>;
  cancel(): void;
}

export interface SttLike {
  transcribeStream(format: PcmFormat, language: string): Promise<SttSession>;
  /** One-shot transcription, used by the test console. */
  transcribe(format: PcmFormat, pcm: Int16Array): Promise<SttResult>;
  health(): Promise<ProviderHealth>;
}

export interface Voice {
  id: string;
  name: string;
  language: string;
}

export interface TtsLike {
  /** Returns PCM chunks at config.tts.outputSampleRate, s16le mono. */
  synthesize(text: string, signal: AbortSignal, voice?: string): AsyncIterable<Int16Array>;
  listVoices(): Promise<Voice[]>;
  health(): Promise<ProviderHealth>;
}

export interface VadEvent {
  kind: "speech_start" | "speech_end";
  /** Timestamp offset in the stream, milliseconds. */
  atMs: number;
}

export interface AudioAccumulator {
  /** Append PCM; returns endpoint events detected in this chunk. */
  push(chunk: Int16Array): VadEvent[];
  /** Bytes of pre-roll buffered so far. */
  hasSpeech(): boolean;
  /** Collected utterance including pre-roll. */
  utterance(): Int16Array;
  /** Speaking duration in ms (speech frames only). */
  speechMs(): number;
  /** Total duration in ms (speech + silence). */
  totalMs(): number;
  reset(): void;
}

// ───────────────────────────────────────────────────────────────── brain ──

export interface BrainRequest {
  text: string;
  runId: string;
  signal: AbortSignal;
  onDelta?(text: string): void;
  onSpeechAudio?(chunk: Int16Array): void;
}

export interface BrainToolTrace {
  call: ToolCall;
  result: ToolResult;
  durationMs: number;
}

export interface BrainReply {
  text: string;
  speech: string;
  toolTraces: BrainToolTrace[];
  /** Audio chunks when provider is native speech-to-speech. */
  audio: Int16Array[];
  finish: "stop" | "error" | "cancelled";
  durationMs: number;
}

export interface BrainLike {
  respond(request: BrainRequest): Promise<BrainReply>;
  /** Reset conversation history (called when a run starts from wake word). */
  newConversation(): void;
  history(): ChatMessage[];
  resetHistory(): void;
}

// ─────────────────────────────────────────────────────────────── session ──

export type RunEndReason =
  | "done"
  | "cancelled"
  | "barge_in"
  | "timeout"
  | "error"
  | "no_speech"
  | "device_stop";

export interface DeviceInfo {
  name: string;
  mac: string;
  firmware: string;
}

export interface DeviceEvent {
  event:
    | "run_start"
    | "stt_start"
    | "stt_vad_start"
    | "stt_vad_end"
    | "stt_end"
    | "intent_start"
    | "intent_end"
    | "intent_progress"
    | "tts_start"
    | "tts_stream_start"
    | "tts_stream_end"
    | "tts_end"
    | "run_end"
    | "error";
  data: Record<string, string>;
}

export interface RunSink {
  emit(event: DeviceEvent): void;
  /**
   * Complete WAV answer (16 kHz mono, 16-bit, RIFF) plus the text that was spoken.
   * The bridge serves the WAV over HTTP and puts its URL into TTS_END.
   */
  tts(wav: Uint8Array, text: string): void;
  end(reason: RunEndReason): void;
}

export type WavEncoder = (pcm: Int16Array, format: PcmFormat) => Uint8Array;

export interface RunRequest {
  runId: string;
  device: DeviceInfo;
  flags: { useWakeWord: boolean };
  /** Non-empty on a wake-word run; empty on button/continue runs. */
  wakeWordPhrase: string;
  sink: RunSink;
  /** Text run from the ask service or test console: no STT, no microphone. */
  text?: string;
}

export interface RunHandleLike {
  onAudio(chunk: Int16Array): void;
  /** Text typed by an automation/test client instead of microphone audio. */
  onText(text: string): void;
  onVadHint(kind: "start" | "end"): void;
  cancel(reason: RunEndReason): void;
  /** Device closed the run (socket closed / stop). */
  deviceStopped(): void;
}

export interface SessionManagerLike {
  startRun(request: RunRequest): RunHandleLike;
  active(): Array<{ runId: string; startedAt: number; state: string }>;
  recent(limit: number): SessionRecord[];
  get(runId: string): SessionRecord | undefined;
}

export interface SessionRecord {
  id: string;
  startedAt: number;
  endedAt?: number;
  device: DeviceInfo;
  transcript: string;
  response: string;
  toolCalls: Array<{ name: string; args: string; ok: boolean }>;
  state: "running" | "finished" | "failed" | "cancelled";
  endReason?: RunEndReason;
  timings: { sttMs?: number; llmMs?: number; ttsMs?: number; totalMs?: number };
}

// ────────────────────────────────────────────────────────────────── mcp ──

export interface McpToolInfo {
  /** Namespaced as mcp.<serverId>.<toolName>. */
  name: string;
  description: string;
  parameters: JsonSchema;
  serverId: string;
}

export interface McpServerState {
  id: string;
  enabled: boolean;
  connected: boolean;
  error: string;
  tools: McpToolInfo[];
}

export interface McpManagerLike {
  /** Connect all enabled servers, refresh tool lists. */
  start(config: AppConfig): Promise<void>;
  reload(config: AppConfig): Promise<void>;
  stop(): Promise<void>;
  states(): McpServerState[];
  tools(): McpToolInfo[];
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
  test(server: McpServerConfig): Promise<ProviderHealth>;
}

// ──────────────────────────────────────────────────────────── scheduler ──

export interface SchedulerServiceLike extends SchedulerApiLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Execute a scheduled entry immediately (used by the admin UI). */
  runNow?(id: string): Promise<{ ok: boolean; error?: string }>;
  /** Re-register recurring rules from config, if any. */
  syncRecurring?(): Promise<void>;
}

// ──────────────────────────────────────────────────────────────── status ──

export interface StatusSnapshot {
  version: string;
  uptimeSec: number;
  bridge: { connected: boolean; lastRunAt: number | null };
  activeRuns: Array<{ runId: string; startedAt: number; state: string }>;
  health: {
    stt: ProviderHealth;
    tts: ProviderHealth;
    ha: ProviderHealth;
    provider: ProviderHealth;
    mcp: Array<{ id: string; connected: boolean; error: string }>;
  };
  scheduler: { active: number; nextAt: number | null };
  configWarnings: string[];
}

// ────────────────────────────────────────────────────────────── services ──

/** Complete service graph assembled in src/index.ts and consumed by HTTP/WS servers. */
export interface AppServices {
  config: ConfigStoreLike;
  log: LoggerLike;
  ha: HaClientLike;
  stt: SttLike;
  tts: TtsLike;
  brain: BrainLike;
  providers: ProviderRegistryLike;
  tools: ToolRegistryLike;
  mcp: McpManagerLike;
  /** Reload MCP servers and resync dynamic tools in the registry. */
  refreshMcpTools(): Promise<void>;
  scheduler: SchedulerServiceLike;
  sessions: SessionManagerLike;
  status(): Promise<StatusSnapshot>;
  /** WAV encoder from the audio module: HTTP layer uses it for TTS previews. */
  encodeWav: WavEncoder;
  version: string;
}

export interface BridgeConnectionInfo {
  connected: boolean;
  device?: DeviceInfo;
  lastRunAt: number | null;
}
