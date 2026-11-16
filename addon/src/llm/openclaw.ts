/**
 * OpenClaw provider: the OpenClaw gateway exposes an OpenAI-compatible chat completions
 * endpoint (`POST /v1/chat/completions`, `GET /v1/models`) that must be enabled in gateway
 * config. Auth is `Authorization: Bearer <gateway token>`; the token grants operator access.
 * `model` is an agent target (`openclaw/default` or `openclaw/<agentId>`), and the agent id can
 * also be sent as `x-openclaw-agent-id`.
 *
 * Source: docs/research-openclaw.md and docs/research-providers.md §1. The adapter was not
 * exercised against a live gateway (the user's instance was unavailable), so it is
 * "documented, not verified" — see the report.
 */

import type { AppConfig, LoggerLike, ProviderCapabilities, ProviderLike } from "../shared/types.js";
import {
  fetchModelIds,
  probeModels,
  runChatCompletion,
  type ChatCompletionTarget,
  type LlmProviderDeps,
} from "./openai.js";
import { joinUrl } from "./util.js";

export const OPENCLAW_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  tools: true,
  nativeAudio: false,
  tts: false,
  models: true,
};

const MODELS_TIMEOUT_MS = 8_000;

/** Config baseUrl may be the gateway root or already include /v1. */
function v1Base(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return "";
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function resolveOpenClawTarget(config: AppConfig, log: LoggerLike): ChatCompletionTarget {
  const provider = config.provider.openclaw;
  const headers: Record<string, string> = {};
  const agentId = provider.agentId.trim();
  if (agentId.length > 0) headers["x-openclaw-agent-id"] = agentId;
  const base = v1Base(provider.baseUrl);
  return {
    name: "openclaw",
    chatUrl: joinUrl(base, "chat/completions"),
    modelsUrl: joinUrl(base, "models"),
    apiKey: provider.apiKey,
    model: provider.model,
    headers,
    temperature: null,
    maxTokens: null,
    requestTimeoutMs: config.conversation.requestTimeoutMs,
    log,
  };
}

export function createOpenClawProvider(deps: LlmProviderDeps): ProviderLike {
  const log = deps.log.child("openclaw");
  return {
    id: "openclaw",
    label: "OpenClaw",
    capabilities: OPENCLAW_CAPABILITIES,
    health: (config) => probeModels(resolveOpenClawTarget(config, log), MODELS_TIMEOUT_MS),
    listModels: (config) => fetchModelIds(resolveOpenClawTarget(config, log), MODELS_TIMEOUT_MS),
    generate: (ctx) => runChatCompletion(resolveOpenClawTarget(ctx.config, log), ctx),
  };
}
