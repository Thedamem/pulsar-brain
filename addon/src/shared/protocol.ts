/**
 * Wire protocol between the Python bridge and this addon, plus HTTP DTOs for the web UI.
 * Source of truth: docs/contracts.md §3–§4. Bump PROTOCOL_VERSION on breaking changes.
 */

import type {
  AppConfig,
  BrainToolTrace,
  DeviceEvent,
  DeviceInfo,
  LogEntry,
  McpServerConfig,
  McpServerState,
  McpToolInfo,
  ProviderCapabilities,
  RunEndReason,
  SessionRecord,
  StatusSnapshot,
  Voice,
} from "./types.js";

export const PROTOCOL_VERSION = 1;

// ─────────────────────────────────────────────── bridge → addon (JSON) ──

export interface BridgeRunStart {
  type: "run.start";
  protocol: number;
  runId: string;
  device: DeviceInfo;
  wakeWord: string;
  /** Non-empty on a wake-word run, empty for button/continue runs. */
  wakeWordPhrase: string;
  flags: { useWakeWord: boolean };
}

export interface BridgeTextInput {
  type: "text.input";
  text: string;
}

export interface BridgeVadStart {
  type: "vad.start";
  runId: string;
}

export interface BridgeVadEnd {
  type: "vad.end";
  runId: string;
  reason: "silence";
}

export interface BridgeRunCancel {
  type: "run.cancel";
  runId: string;
  reason: "barge_in" | "device_stop" | "timeout" | "client";
}

export interface BridgeRunEnd {
  type: "run.end";
  runId: string;
  reason: string;
}

export type BridgeInbound =
  | BridgeRunStart
  | BridgeTextInput
  | BridgeVadStart
  | BridgeVadEnd
  | BridgeRunCancel
  | BridgeRunEnd;

// ─────────────────────────────────────────────── addon → bridge (JSON) ──

export interface AddonDeviceEvent {
  type: "device.event";
  event: DeviceEvent["event"];
  data: Record<string, string>;
}

export interface AddonRunAccepted {
  type: "run.accepted";
  runId: string;
}

export interface AddonError {
  type: "error";
  code: string;
  message: string;
  fatal: boolean;
}

export interface AddonTtsStart {
  type: "tts.start";
  text: string;
  /** WAV frames follow as binary WS messages until tts.end. 16 kHz mono s16le RIFF. */
  format: "wav";
}

export interface AddonTtsEnd {
  type: "tts.end";
  reason: "done" | "cancelled" | "error";
}

export interface AddonRunEnd {
  type: "run.end";
  reason: RunEndReason;
}

export type AddonOutbound =
  | AddonDeviceEvent
  | AddonRunAccepted
  | AddonError
  | AddonTtsStart
  | AddonTtsEnd
  | AddonRunEnd;

// ────────────────────────────────────────────────────────── HTTP DTOs ──

export interface HealthResponse {
  status: "ok";
  version: string;
  uptimeSec: number;
}

export interface ConfigResponse {
  config: AppConfig;
  warnings: string[];
  /** Bridge bearer token; shown once the UI is authenticated. */
  bridgeToken: string;
}

export interface ModelsResponse {
  models: string[];
}

export interface TestAudioResponse {
  transcript: string;
  text: string;
  speech: string;
  toolTraces: BrainToolTrace[];
  timings: { sttMs: number; llmMs: number; totalMs: number };
  provider: string;
}

export interface ProviderInfoResponse {
  providers: Array<{
    id: string;
    label: string;
    capabilities: ProviderCapabilities;
  }>;
}

export interface PromptResponse {
  system: string;
  language: string;
  defaults: { system: string; language: string };
}

export interface TtsPreviewRequest {
  text: string;
  voice: string;
}

export interface TestTextRequest {
  text: string;
  /** Reuse conversation history when true (default false). */
  keepHistory?: boolean;
}

export interface TestTextResponse {
  transcript?: string;
  text: string;
  speech: string;
  toolTraces: BrainToolTrace[];
  timings: { llmMs: number; totalMs: number };
  provider: string;
}

export interface LogsResponse {
  entries: LogEntry[];
  nextSeq: number;
}

export interface SchedulesResponse {
  entries: Array<{
    id: string;
    at: number;
    label: string;
    action: Record<string, unknown>;
    runId?: string;
  }>;
  nextAt: number | null;
}

export interface McpServersResponse {
  servers: Array<McpServerConfig & McpServerState>;
}

export interface McpToolsResponse {
  tools: McpToolInfo[];
}

export interface SessionsResponse {
  sessions: SessionRecord[];
}

export interface VoicesResponse {
  voices: Voice[];
}

export interface HaEntitiesResponse {
  entities: Array<{ entity_id: string; name: string; state: string; domain: string; area_id?: string }>;
  areas: Array<{ area_id: string; name: string }>;
}

export interface StatusResponse extends StatusSnapshot {}

// ─────────────────────────────────────────── station binding (§8) ──

export interface StationEntryDto {
  entry_id: string;
  name: string;
  host: string;
  port: number;
  mac: string;
}

export interface StationBindingDto {
  mode: "discovered" | "manual";
  entry_id: string;
  name: string;
  host: string;
  port: number;
  has_psk: boolean;
  bound_at: number;
}

export interface CurrentStationDto {
  mode: "discovered" | "manual";
  entry_id: string;
  name: string;
  host: string;
  port: number;
  has_psk: boolean;
}

export interface StationsPushRequest {
  stations: StationEntryDto[];
  /** Current binding on the Home Assistant side; absent when unknown. */
  current?: CurrentStationDto | null;
}

export interface StationsResponse {
  stations: StationEntryDto[];
  binding: StationBindingDto | null;
  integration_connected: boolean;
}

export interface SetStationRequest {
  entry_id?: string;
  name?: string;
  host?: string;
  port?: number;
  noise_psk?: string;
}

// ───────────────────────────────────────────── debug API (§8.5) ──

export interface DiscoveryStatusDto {
  state: "pending" | "announced" | "failed" | "not_supervisor";
  at: number | null;
  host: string | null;
  reason: string;
}

export interface DiagnosticsResponse {
  version: string;
  uptimeSec: number;
  addon: {
    port: number;
    hostname: string | null;
    supervisorTokenConfigured: boolean;
    accessTokenConfigured: boolean;
    discovery: DiscoveryStatusDto;
  };
  config: {
    provider: string;
    stt: { host: string; port: number };
    tts: { mode: string; host: string; port: number; voice: string };
  };
  checks: {
    ha: { ok: boolean; detail: string };
    stt: { ok: boolean; detail: string };
    tts: { ok: boolean; detail: string };
  };
  probes: {
    stt: { host: string; port: number; ok: boolean; latencyMs: number; error: string };
    tts: { host: string; port: number; ok: boolean; latencyMs: number; error: string };
  };
  integration: { connected: boolean; lastStationsAt: number | null };
  station: { bound: boolean; name: string | null };
}

export interface ProbeRequest {
  host: string;
  port: number;
  timeoutMs?: number;
}

export interface ProbeResponse {
  ok: boolean;
  latencyMs: number;
  error: string;
}

export interface AutodetectResponse {
  applied: boolean;
  details: string;
}

export interface ErrorResponse {
  error: { code: string; message: string };
}
