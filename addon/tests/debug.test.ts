import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AppConfig,
  ConfigStoreLike,
  LoggerLike,
  LogEntry,
  LogLevel,
} from "../src/shared/types.js";
import { autodetectAudioServices, probeTcp } from "../src/supervisor/probe.js";
import { buildDiagnostics } from "../src/debug/diagnostics.js";

class TestLogger implements LoggerLike {
  readonly entries: LogEntry[] = [];
  private seq = 0;
  constructor(private readonly scope = "test") {}
  private put(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    this.seq += 1;
    this.entries.push({
      seq: this.seq,
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      msg,
      ...(data === undefined ? {} : { data }),
    });
  }
  trace(msg: string, data?: Record<string, unknown>): void {
    this.put("trace", msg, data);
  }
  debug(msg: string, data?: Record<string, unknown>): void {
    this.put("debug", msg, data);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.put("info", msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.put("warn", msg, data);
  }
  error(msg: string, data?: Record<string, unknown>): void {
    this.put("error", msg, data);
  }
  child(): LoggerLike {
    return new TestLogger(this.scope);
  }
  since(): LogEntry[] {
    return this.entries;
  }
  subscribe(): () => void {
    return () => undefined;
  }
}

function configWith(sttHost: string, sttPort: number, ttsHost: string, ttsPort: number): AppConfig {
  return {
    version: 1,
    logLevel: "info",
    provider: {
      id: "mock",
      openai: { baseUrl: "", apiKey: "", model: "", temperature: 0.3, maxTokens: 100, extraHeaders: {} },
      openclaw: { baseUrl: "", apiKey: "", agentId: "", model: "" },
      geminiLive: { apiKey: "", model: "", voice: "", responseModality: "AUDIO" },
      mock: { mode: "smart", scriptFile: "" },
    },
    stt: {
      provider: "wyoming",
      host: sttHost,
      port: sttPort,
      language: "ru",
      model: "auto",
      endpointing: {
        silenceThresholdDb: -45,
        sentenceSilenceMs: 700,
        minSpeechMs: 200,
        maxUtteranceMs: 15_000,
        preRollMs: 300,
      },
    },
    tts: {
      mode: "piper",
      piper: { host: ttsHost, port: ttsPort, voice: "ru_RU-irina-medium" },
      provider: { model: "", voice: "", format: "wav", language: "ru" },
      outputSampleRate: 16_000,
    },
    prompt: { system: "", language: "ru" },
    conversation: {
      maxHistoryTurns: 8,
      followUpTimeoutMs: 8000,
      bargeIn: true,
      llmMaxToolIterations: 6,
      requestTimeoutMs: 30_000,
    },
    tools: {
      ha: { enabled: true, url: "", token: "" },
      scheduler: { enabled: true, maxActive: 50, confirmBeforeSchedule: false },
      mcp: { servers: [] },
    },
    aliases: {},
  };
}

function memoryConfigStore(initial: AppConfig): ConfigStoreLike {
  let config = initial;
  return {
    get: () => config,
    update: async (patch) => {
      config = { ...config, ...(patch as Partial<AppConfig>) };
      return config;
    },
    masked: () => config,
    onChange: () => () => undefined,
    bridgeToken: () => "bridge-token",
  };
}

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function listeningServer(): Promise<number> {
  const server = createServer((socket) => socket.end());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

describe("probeTcp", () => {
  it("reports a listening port as reachable", async () => {
    const port = await listeningServer();
    const result = await probeTcp("127.0.0.1", port, 500);
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a closed port as unreachable", async () => {
    const port = await listeningServer();
    const result = await probeTcp("127.0.0.1", port, 500);
    expect(result.ok).toBe(true);
    // A fresh port that was never opened.
    const closed = await probeTcp("127.0.0.1", 1, 300);
    expect(closed.ok).toBe(false);
    expect(closed.error.length).toBeGreaterThan(0);
  });
});

describe("autodetectAudioServices", () => {
  it("replaces unreachable defaults with a reachable candidate", async () => {
    const store = memoryConfigStore(configWith("localhost", 1, "localhost", 1));
    const sttPort = await listeningServer();
    const ttsPort = await listeningServer();
    const outcome = await autodetectAudioServices(store, {
      log: new TestLogger(),
      probe: async (host, port) => ({
        ok:
          (host === "core-whisper" && port === sttPort) ||
          (host === "core-piper" && port === ttsPort),
        latencyMs: 1,
        error: "",
      }),
      sttCandidates: [{ host: "core-whisper", port: sttPort }],
      ttsCandidates: [{ host: "core-piper", port: ttsPort }],
    });
    expect(outcome.applied).toBe(true);
    expect(store.get().stt).toMatchObject({ host: "core-whisper", port: sttPort });
    expect(store.get().tts.piper).toMatchObject({ host: "core-piper", port: ttsPort });
  });

  it("keeps a reachable configuration untouched", async () => {
    const store = memoryConfigStore(configWith("127.0.0.1", 10300, "127.0.0.1", 10200));
    const outcome = await autodetectAudioServices(store, {
      log: new TestLogger(),
      probe: async () => ({ ok: true, latencyMs: 1, error: "" }),
    });
    expect(outcome.applied).toBe(false);
    expect(store.get().stt.host).toBe("127.0.0.1");
  });
});

describe("buildDiagnostics", () => {
  it("returns service state without secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-diag-"));
    dirs.push(dir);
    const config = configWith("127.0.0.1", 10300, "127.0.0.1", 10200);
    const store = memoryConfigStore(config);
    const services = {
      config: store,
      version: "0.3.0",
      ha: { available: async () => true },
      stt: { health: async () => ({ ok: true, detail: "ASR ok" }) },
      tts: { health: async () => ({ ok: false, detail: "TTS down" }) },
    };
    const result = await buildDiagnostics({
      services: services as never,
      startedAt: Date.now() - 5000,
      addonPort: 8097,
      hostname: "local_pulsar_brain",
      accessTokenConfigured: true,
      discovery: { state: "announced", at: Date.now(), host: "local_pulsar_brain", reason: "" },
      stationName: "yandex-lite2",
      integrationLastSeenAt: Date.now(),
      log: new TestLogger(),
    });
    expect(result.version).toBe("0.3.0");
    expect(result.addon.discovery.state).toBe("announced");
    expect(result.checks.stt.ok).toBe(true);
    expect(result.checks.tts.ok).toBe(false);
    expect(result.station).toEqual({ bound: true, name: "yandex-lite2" });
    const text = JSON.stringify(result);
    expect(text).not.toContain("bridge-token");
    expect(text).not.toContain("psk");
  });
});
