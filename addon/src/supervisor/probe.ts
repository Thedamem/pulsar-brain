/**
 * TCP reachability probes and STT/TTS auto-detection (docs/contracts.md §8.5).
 *
 * The addon runs in the Supervisor network, where other apps are reachable by hostname
 * (e.g. core-piper, core-whisper). A bare "localhost" in the default config points at the
 * addon itself, which is the most common reason for a 502 on the voice/tts endpoints.
 */

import { connect } from "node:net";
import type { ConfigStoreLike, LoggerLike } from "../shared/types.js";

const DEFAULT_PROBE_TIMEOUT_MS = 1500;

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  error: string;
}

export interface ProbeTarget {
  host: string;
  port: number;
}

/** Known hostnames for official and custom Wyoming apps. */
export const STT_CANDIDATES: readonly ProbeTarget[] = [
  { host: "core-whisper", port: 10300 },
  { host: "whisper", port: 10300 },
  { host: "local-whisper", port: 10300 },
  { host: "core_whisper", port: 10300 },
];

export const TTS_CANDIDATES: readonly ProbeTarget[] = [
  { host: "core-piper", port: 10200 },
  { host: "piper", port: 10200 },
  { host: "local-piper", port: 10200 },
  { host: "core_piper", port: 10200 },
];

export function probeTcp(host: string, port: number, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, error: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, latencyMs: Date.now() - startedAt, error });
    };
    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, ""));
    socket.once("timeout", () => finish(false, `таймаут ${timeoutMs} мс`));
    socket.once("error", (err: Error) => finish(false, err.message));
  });
}

export interface AutodetectOutcome {
  applied: boolean;
  stt?: ProbeTarget & { previous: ProbeTarget; changed: boolean };
  tts?: ProbeTarget & { previous: ProbeTarget; changed: boolean };
  details: string;
}

export interface AutodetectOptions {
  log: LoggerLike;
  probe?: typeof probeTcp;
  sttCandidates?: readonly ProbeTarget[];
  ttsCandidates?: readonly ProbeTarget[];
}

async function firstReachable(
  targets: readonly ProbeTarget[],
  probe: typeof probeTcp,
): Promise<ProbeTarget | null> {
  const results = await Promise.all(
    targets.map(async (target) => ({ target, result: await probe(target.host, target.port) })),
  );
  return results.find((entry) => entry.result.ok)?.target ?? null;
}

/**
 * Probe the configured STT/TTS endpoint; when it is unreachable, try known app hostnames and
 * persist the first reachable one. Only writes the config when something actually changed.
 */
export async function autodetectAudioServices(
  configStore: ConfigStoreLike,
  options: AutodetectOptions,
): Promise<AutodetectOutcome> {
  const { log } = options;
  const probe = options.probe ?? probeTcp;
  const sttCandidates = options.sttCandidates ?? STT_CANDIDATES;
  const ttsCandidates = options.ttsCandidates ?? TTS_CANDIDATES;
  const config = configStore.get();
  const currentStt = { host: config.stt.host, port: config.stt.port };
  const currentTts = { host: config.tts.piper.host, port: config.tts.piper.port };

  const sttCurrent = await probe(currentStt.host, currentStt.port);
  const ttsCurrent = await probe(currentTts.host, currentTts.port);

  const sttTarget = sttCurrent.ok ? currentStt : await firstReachable(sttCandidates, probe);
  const ttsTarget = ttsCurrent.ok ? currentTts : await firstReachable(ttsCandidates, probe);

  const sttChanged = sttTarget !== null && (sttTarget.host !== currentStt.host || sttTarget.port !== currentStt.port);
  const ttsChanged = ttsTarget !== null && (ttsTarget.host !== currentTts.host || ttsTarget.port !== currentTts.port);

  const parts: string[] = [];
  if (sttCurrent.ok) {
    parts.push(`STT ${currentStt.host}:${currentStt.port} доступен`);
  } else if (sttChanged && sttTarget !== null) {
    parts.push(`STT найден: ${sttTarget.host}:${sttTarget.port}`);
  } else {
    parts.push(`STT не найден (${sttCurrent.error})`);
  }
  if (ttsCurrent.ok) {
    parts.push(`TTS ${currentTts.host}:${currentTts.port} доступен`);
  } else if (ttsChanged && ttsTarget !== null) {
    parts.push(`TTS найден: ${ttsTarget.host}:${ttsTarget.port}`);
  } else {
    parts.push(`TTS не найден (${ttsCurrent.error})`);
  }

  if (sttChanged || ttsChanged) {
    await configStore.update({
      ...(sttChanged && sttTarget !== null
        ? { stt: { ...config.stt, host: sttTarget.host, port: sttTarget.port } }
        : {}),
      ...(ttsChanged && ttsTarget !== null
        ? { tts: { ...config.tts, piper: { ...config.tts.piper, host: ttsTarget.host, port: ttsTarget.port } } }
        : {}),
    });
    log.info("autodetected audio services", { changed: { stt: sttChanged, tts: ttsChanged } });
  }

  return {
    applied: sttChanged || ttsChanged,
    ...(sttTarget === null
      ? {}
      : { stt: { ...sttTarget, previous: currentStt, changed: sttChanged } }),
    ...(ttsTarget === null
      ? {}
      : { tts: { ...ttsTarget, previous: currentTts, changed: ttsChanged } }),
    details: parts.join("; "),
  };
}
