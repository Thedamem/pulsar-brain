/**
 * Zod schema and defaults for AppConfig (see shared/types.ts).
 *
 * The schema is the single source of truth for validation: config file, PUT /api/config
 * patches (after deep merge) and MCP server bodies all go through these rules.
 * Range limits reject values that would break the audio pipeline at runtime.
 */

import { z } from "zod";
import type { AppConfig } from "../shared/types.js";

export const DEFAULT_SYSTEM_PROMPT = [
  "Ты — голосовой ассистент «Pulsar» в умном доме. Отвечай по-русски, кратко и естественно: одна-две",
  "короткие фразы, без списков, разметки, эмодзи и рассуждений о том, как ты устроен.",
  "",
  "Управляй устройствами только через инструменты. Сначала определи сущность по её понятному имени или",
  "алиасу, затем вызови нужный инструмент. Не выдумывай entity_id, названия устройств, зоны и их",
  "состояния — используй только то, что вернули инструменты. Если устройство или сущность не найдены,",
  "скажи об этом и предложи уточнить.",
  "",
  "Все действия одной фразы выполняй все, каждое своим вызовом инструмента, и подтверди результат одной",
  "фразой. Относительные и абсолютные времена («через 10 минут», «в 22:00», «каждый день в 8») передавай",
  "в инструменты планировщика: разовые таймеры и отложенные действия ведёт аддон, повторяющиеся —",
  "нативные автоматизации Home Assistant.",
  "",
  "На вопросы вне умного дома отвечай сам, но не придумывай факты, числа, даты и данные о пользователе.",
  "Если не знаешь — прямо скажи, что не знаешь. Не зачитывай вслух JSON, названия инструментов и",
  "внутренние идентификаторы. Не предлагай пользователю включать или выключать то, о чём он не просил.",
].join("\n");

const LogLevelSchema = z.enum(["trace", "debug", "info", "warn", "error"]);
const ProviderIdSchema = z.enum(["openai", "openclaw", "gemini-live", "mock"]);

const OpenAiProviderConfigSchema = z.object({
  baseUrl: z.string().default("https://api.openai.com/v1"),
  apiKey: z.string().default(""),
  model: z.string().min(1).default("gpt-4o-mini"),
  temperature: z.number().min(0).max(2).default(0.3),
  maxTokens: z.number().int().min(1).max(32768).default(800),
  extraHeaders: z.record(z.string()).default({}),
});

const OpenClawProviderConfigSchema = z.object({
  baseUrl: z.string().default(""),
  apiKey: z.string().default(""),
  agentId: z.string().default(""),
  model: z.string().default(""),
});

const GeminiLiveProviderConfigSchema = z.object({
  apiKey: z.string().default(""),
  model: z.string().min(1).default("gemini-3.8-live"),
  voice: z.string().default("Puck"),
  responseModality: z.enum(["AUDIO", "TEXT"]).default("AUDIO"),
});

const MockProviderConfigSchema = z.object({
  mode: z.enum(["smart", "echo", "scripted"]).default("smart"),
  scriptFile: z.string().default(""),
});

const ProviderConfigSchema = z.object({
  id: ProviderIdSchema.default("mock"),
  openai: OpenAiProviderConfigSchema.default({}),
  openclaw: OpenClawProviderConfigSchema.default({}),
  geminiLive: GeminiLiveProviderConfigSchema.default({}),
  mock: MockProviderConfigSchema.default({}),
});

const EndpointingConfigSchema = z.object({
  silenceThresholdDb: z.number().min(-100).max(0).default(-45),
  sentenceSilenceMs: z.number().int().min(100).max(10000).default(700),
  minSpeechMs: z.number().int().min(0).max(5000).default(200),
  maxUtteranceMs: z.number().int().min(500).max(120000).default(15000),
  preRollMs: z.number().int().min(0).max(2000).default(300),
});

const SttConfigSchema = z.object({
  provider: z.literal("wyoming").default("wyoming"),
  host: z.string().min(1).default("localhost"),
  port: z.number().int().min(1).max(65535).default(10300),
  language: z.string().min(1).default("ru"),
  model: z.string().min(1).default("auto"),
  endpointing: EndpointingConfigSchema.default({}),
});

const PiperTtsConfigSchema = z.object({
  host: z.string().min(1).default("localhost"),
  port: z.number().int().min(1).max(65535).default(10200),
  voice: z.string().min(1).default("ru_RU-irina-medium"),
});

const ProviderVoiceConfigSchema = z.object({
  model: z.string().min(1).default("gpt-4o-mini-tts"),
  voice: z.string().default("alloy"),
  format: z.enum(["wav", "pcm"]).default("wav"),
  language: z.string().default("ru"),
});

const TtsConfigSchema = z.object({
  mode: z.enum(["piper", "provider", "auto"]).default("auto"),
  piper: PiperTtsConfigSchema.default({}),
  provider: ProviderVoiceConfigSchema.default({}),
  outputSampleRate: z.number().int().min(8000).max(48000).default(16000),
});

const PromptConfigSchema = z.object({
  system: z.string().default(DEFAULT_SYSTEM_PROMPT),
  language: z.string().min(1).default("ru"),
});

const ConversationConfigSchema = z.object({
  maxHistoryTurns: z.number().int().min(0).max(100).default(8),
  followUpTimeoutMs: z.number().int().min(0).max(60000).default(8000),
  bargeIn: z.boolean().default(true),
  llmMaxToolIterations: z.number().int().min(1).max(20).default(6),
  requestTimeoutMs: z.number().int().min(1000).max(180000).default(30000),
});

const HaToolsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  url: z.string().default(""),
  token: z.string().default(""),
});

const SchedulerToolsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxActive: z.number().int().min(1).max(1000).default(50),
  confirmBeforeSchedule: z.boolean().default(false),
});

/** MCP ids are embedded into LLM tool names (mcp.<id>.<tool>), so keep them provider-safe. */
export const MCP_SERVER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const McpServerConfigSchema = z.object({
  id: z.string().regex(MCP_SERVER_ID_RE, "id: допустимы латиница, цифры, _ и -"),
  name: z.string().min(1).max(120),
  enabled: z.boolean().default(true),
  transport: z.enum(["stdio", "http", "sse"]),
  command: z.string().default(""),
  args: z.array(z.string()).default([]),
  url: z.string().default(""),
  headers: z.record(z.string()).default({}),
  toolTimeoutSec: z.number().int().min(1).max(600).default(15),
});

const ToolsConfigSchema = z.object({
  ha: HaToolsConfigSchema.default({}),
  scheduler: SchedulerToolsConfigSchema.default({}),
  mcp: z.object({ servers: z.array(McpServerConfigSchema).default([]) }).default({}),
});

const AppConfigObjectSchema = z.object({
  version: z.number().int().min(1).default(1),
  logLevel: LogLevelSchema.default("info"),
  provider: ProviderConfigSchema.default({}),
  stt: SttConfigSchema.default({}),
  tts: TtsConfigSchema.default({}),
  prompt: PromptConfigSchema.default({}),
  conversation: ConversationConfigSchema.default({}),
  tools: ToolsConfigSchema.default({}),
  aliases: z.record(z.string()).default({}),
});

/**
 * Typed as z.ZodType<AppConfig> so the compiler rejects any drift between the schema
 * and shared/types.ts.
 */
export const AppConfigSchema: z.ZodType<AppConfig, z.ZodTypeDef, unknown> = AppConfigObjectSchema;

/** Default configuration: every field filled by schema defaults. */
export const DEFAULT_CONFIG: AppConfig = AppConfigSchema.parse({});

/** Default prompt values used by GET /api/prompt/defaults and reset actions. */
export const DEFAULT_PROMPT: { system: string; language: string } = {
  system: DEFAULT_SYSTEM_PROMPT,
  language: DEFAULT_CONFIG.prompt.language,
};
