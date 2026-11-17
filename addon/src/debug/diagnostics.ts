/**
 * Read-only diagnostics for the debug API (docs/contracts.md §8.5).
 *
 * Everything here is derived from live services: no passwords, tokens or PSKs are included.
 */

import type {
  DiagnosticsResponse,
  DiscoveryStatusDto,
} from "../shared/protocol.js";
import type { AppServices, LoggerLike } from "../shared/types.js";
import { probeTcp } from "../supervisor/probe.js";

export interface DiscoverySnapshot {
  state: DiscoveryStatusDto["state"];
  at: number | null;
  host: string | null;
  reason: string;
}

export interface DiagnosticsInput {
  services: AppServices;
  startedAt: number;
  addonPort: number;
  hostname: string | null;
  accessTokenConfigured: boolean;
  discovery: DiscoverySnapshot;
  stationName: string | null;
  integrationLastSeenAt: number | null;
  log: LoggerLike;
}

export async function buildDiagnostics(input: DiagnosticsInput): Promise<DiagnosticsResponse> {
  const { services, log } = input;
  const config = services.config.get();
  const sttTarget = { host: config.stt.host, port: config.stt.port };
  const ttsTarget = { host: config.tts.piper.host, port: config.tts.piper.port };

  const [ha, sttHealth, ttsHealth, sttProbe, ttsProbe] = await Promise.all([
    safeHa(services),
    safeHealth(() => services.stt.health(), "STT"),
    safeHealth(() => services.tts.health(), "TTS"),
    probeTcp(sttTarget.host, sttTarget.port),
    probeTcp(ttsTarget.host, ttsTarget.port),
  ]);

  log.debug("diagnostics requested", {
    ha: ha.ok,
    stt: sttProbe.ok,
    tts: ttsProbe.ok,
  });

  return {
    version: services.version,
    uptimeSec: Math.floor((Date.now() - input.startedAt) / 1000),
    addon: {
      port: input.addonPort,
      hostname: input.hostname,
      supervisorTokenConfigured: (process.env.SUPERVISOR_TOKEN ?? "").trim().length > 0,
      accessTokenConfigured: input.accessTokenConfigured,
      discovery: { ...input.discovery },
    },
    config: {
      provider: config.provider.id,
      stt: { host: config.stt.host, port: config.stt.port },
      tts: {
        mode: config.tts.mode,
        host: config.tts.piper.host,
        port: config.tts.piper.port,
        voice: config.tts.piper.voice,
      },
    },
    checks: {
      ha,
      stt: sttHealth,
      tts: ttsHealth,
    },
    probes: {
      stt: { ...sttTarget, ...sttProbe },
      tts: { ...ttsTarget, ...ttsProbe },
    },
    integration: {
      connected: input.integrationLastSeenAt !== null && Date.now() - input.integrationLastSeenAt < 90_000,
      lastStationsAt: input.integrationLastSeenAt,
    },
    station: {
      bound: input.stationName !== null,
      name: input.stationName,
    },
  };
}

async function safeHa(services: AppServices): Promise<{ ok: boolean; detail: string }> {
  try {
    const ok = await services.ha.available();
    return { ok, detail: ok ? "Home Assistant доступен" : "нет связи с HA" };
  } catch (err) {
    return { ok: false, detail: errorText(err) };
  }
}

async function safeHealth(
  check: () => Promise<{ ok: boolean; detail: string }>,
  label: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    return await check();
  } catch (err) {
    return { ok: false, detail: `${label}: ${errorText(err)}` };
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
