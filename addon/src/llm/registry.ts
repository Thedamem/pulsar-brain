/**
 * LLM provider registry. Providers are created lazily on first `get` so an idle or
 * misconfigured provider costs nothing at startup. Each provider reads the live AppConfig
 * (from ProviderContext / health(config)), so config changes apply without recreating it.
 */

import type {
  AppConfig,
  LoggerLike,
  ProviderCapabilities,
  ProviderId,
  ProviderLike,
  ProviderRegistryLike,
} from "../shared/types.js";
import { GEMINI_LIVE_CAPABILITIES, createGeminiLiveProvider } from "./gemini-live.js";
import { MOCK_CAPABILITIES, createMockProvider } from "./mock.js";
import { OPENAI_CAPABILITIES, createOpenAiProvider } from "./openai.js";
import { OPENCLAW_CAPABILITIES, createOpenClawProvider } from "./openclaw.js";

interface ProviderEntry {
  id: ProviderId;
  label: string;
  capabilities: ProviderCapabilities;
  create: () => ProviderLike;
}

export function createProviderRegistry(config: AppConfig, log: LoggerLike): ProviderRegistryLike {
  const registryLog = log.child("llm.registry");
  const entries: readonly ProviderEntry[] = [
    {
      id: "openai",
      label: "OpenAI-совместимый",
      capabilities: OPENAI_CAPABILITIES,
      create: () => createOpenAiProvider({ log }),
    },
    {
      id: "openclaw",
      label: "OpenClaw",
      capabilities: OPENCLAW_CAPABILITIES,
      create: () => createOpenClawProvider({ log }),
    },
    {
      id: "gemini-live",
      label: "Gemini Live",
      capabilities: GEMINI_LIVE_CAPABILITIES,
      create: () => createGeminiLiveProvider({ log }),
    },
    {
      id: "mock",
      label: "Mock (тесты)",
      capabilities: MOCK_CAPABILITIES,
      create: () => createMockProvider({ log }),
    },
  ];
  const instances = new Map<ProviderId, ProviderLike>();
  for (const warning of describeConfigWarnings(config)) registryLog.warn(warning);
  registryLog.info("provider registry ready", {
    active: config.provider.id,
    providers: entries.map((entry) => entry.id),
  });

  return {
    list: () => entries.map((entry) => ({ id: entry.id, label: entry.label, capabilities: entry.capabilities })),
    get: (id: ProviderId): ProviderLike => {
      const existing = instances.get(id);
      if (existing !== undefined) return existing;
      const entry = entries.find((candidate) => candidate.id === id);
      if (entry === undefined) throw new Error(`unknown LLM provider: ${id}`);
      const provider = entry.create();
      instances.set(id, provider);
      registryLog.debug("provider created", { id, label: entry.label });
      return provider;
    },
  };
}

/** Warnings for the status panel: the active provider is missing credentials or endpoints. */
function describeConfigWarnings(config: AppConfig): string[] {
  const warnings: string[] = [];
  const isBlank = (value: string): boolean => value.trim().length === 0;
  switch (config.provider.id) {
    case "openai": {
      const provider = config.provider.openai;
      if (isBlank(provider.baseUrl)) warnings.push("openai provider is selected but provider.openai.baseUrl is empty");
      if (isBlank(provider.model)) warnings.push("openai provider is selected but provider.openai.model is empty");
      if (isBlank(provider.apiKey)) warnings.push("openai provider is selected without an API key (ok for local servers)");
      break;
    }
    case "openclaw": {
      const provider = config.provider.openclaw;
      if (isBlank(provider.baseUrl)) warnings.push("openclaw provider is selected but provider.openclaw.baseUrl is empty");
      if (isBlank(provider.apiKey)) warnings.push("openclaw provider is selected without a gateway token");
      if (isBlank(provider.model)) warnings.push("openclaw provider is selected but the agent target (model) is empty");
      break;
    }
    case "gemini-live": {
      const provider = config.provider.geminiLive;
      if (isBlank(provider.apiKey)) warnings.push("gemini-live provider is selected without an API key");
      if (isBlank(provider.model)) warnings.push("gemini-live provider is selected but provider.geminiLive.model is empty");
      break;
    }
    case "mock":
      break;
  }
  return warnings;
}
