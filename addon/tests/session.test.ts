import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionManager, type SessionDeps } from "../src/session/manager.js";
import type { SessionStore } from "../src/session/history.js";
import { normalizeTranscript } from "../src/session/history.js";
import type {
  AppConfig,
  AudioAccumulator,
  BrainLike,
  BrainReply,
  ConfigStoreLike,
  DeviceEvent,
  LoggerLike,
  RunRequest,
  RunSink,
  SessionRecord,
  SttLike,
  SttResult,
  SttSession,
  TtsLike,
  VadEvent,
  Voice,
  ProviderHealth,
  PcmFormat,
} from "../src/shared/types.js";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    version: 1,
    logLevel: "info",
    provider: {
      id: "mock",
      openai: { baseUrl: "", apiKey: "", model: "m", temperature: 0.3, maxTokens: 100, extraHeaders: {} },
      openclaw: { baseUrl: "", apiKey: "", agentId: "", model: "openclaw/default" },
      geminiLive: { apiKey: "", model: "gemini-3.8-live", voice: "Puck", responseModality: "AUDIO" },
      mock: { mode: "smart", scriptFile: "" },
    },
    stt: {
      provider: "wyoming",
      host: "127.0.0.1",
      port: 10300,
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
      mode: "auto",
      piper: { host: "127.0.0.1", port: 10200, voice: "ru_RU-irina-medium" },
      provider: { model: "gpt-4o-mini-tts", voice: "alloy", format: "wav", language: "ru" },
      outputSampleRate: 16000,
    },
    prompt: { system: "system", language: "ru" },
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
    ...overrides,
  };
}

function makeLogger(): LoggerLike {
  const noop = (): void => undefined;
  const logger: LoggerLike = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    since: () => [],
    subscribe: () => () => undefined,
  };
  return logger;
}

function makeConfigStore(initial: AppConfig): ConfigStoreLike {
  let config = initial;
  const listeners = new Set<(cfg: AppConfig) => void>();
  return {
    get: () => config,
    update: async (patch) => {
      config = { ...config, ...(patch as Partial<AppConfig>) };
      for (const listener of listeners) {
        listener(config);
      }
      return config;
    },
    masked: () => config,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bridgeToken: () => "token",
  };
}

class FakeStore implements SessionStore {
  readonly saved = new Map<string, SessionRecord>();
  save(record: SessionRecord): void {
    this.saved.set(record.id, { ...record });
  }
  list(limit: number): SessionRecord[] {
    return [...this.saved.values()].slice(0, limit);
  }
  get(id: string): SessionRecord | undefined {
    return this.saved.get(id);
  }
  close(): void {}
}

class FakeVad implements AudioAccumulator {
  private readonly scripted: Array<Array<"start" | "end">>;
  private index = 0;
  private buffer: Int16Array[] = [];
  private speech = false;
  constructor(scripted: Array<Array<"start" | "end">>) {
    this.scripted = scripted;
  }
  push(chunk: Int16Array): VadEvent[] {
    this.buffer.push(chunk);
    const marks = this.scripted[this.index] ?? [];
    this.index += 1;
    return marks.map((kind) => {
      this.speech = kind === "start";
      return { kind: kind === "start" ? "speech_start" : "speech_end", atMs: 0 };
    });
  }
  hasSpeech(): boolean {
    return this.speech;
  }
  utterance(): Int16Array {
    const total = this.buffer.reduce((sum, part) => sum + part.length, 0);
    const out = new Int16Array(total);
    let offset = 0;
    for (const part of this.buffer) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
  speechMs(): number {
    return this.buffer.length * 20;
  }
  totalMs(): number {
    return this.buffer.length * 20;
  }
  reset(): void {
    this.buffer = [];
    this.index = 0;
  }
}

class FakeStt implements SttLike {
  readonly writes: Int16Array[] = [];
  finishResult: SttResult = { text: "Алиса, включи свет", language: "ru" };
  finishError: Error | null = null;
  cancelled = false;
  health(): Promise<ProviderHealth> {
    return Promise.resolve({ ok: true, detail: "fake" });
  }
  transcribe(_format: PcmFormat, _pcm: Int16Array): Promise<SttResult> {
    return Promise.resolve(this.finishResult);
  }
  async transcribeStream(_format: PcmFormat, _language: string): Promise<SttSession> {
    const self = this;
    return {
      write(chunk: Int16Array): void {
        self.writes.push(chunk);
      },
      finish(): Promise<SttResult> {
        if (self.finishError !== null) {
          return Promise.reject(self.finishError);
        }
        return Promise.resolve(self.finishResult);
      },
      cancel(): void {
        self.cancelled = true;
      },
    };
  }
}

class FakeTts implements TtsLike {
  chunks: Int16Array[] = [new Int16Array([1, 2, 3, 4])];
  health(): Promise<ProviderHealth> {
    return Promise.resolve({ ok: true, detail: "fake" });
  }
  listVoices(): Promise<Voice[]> {
    return Promise.resolve([{ id: "v", name: "v", language: "ru" }]);
  }
  async *synthesize(_text: string, _signal: AbortSignal): AsyncIterable<Int16Array> {
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }
}

class FakeBrain implements BrainLike {
  readonly calls: string[] = [];
  newConversations = 0;
  reply: BrainReply = {
    text: "Готово",
    speech: "Готово",
    toolTraces: [],
    audio: [],
    finish: "stop",
    durationMs: 1,
  };
  respond(request: { text: string }): Promise<BrainReply> {
    this.calls.push(request.text);
    return Promise.resolve(this.reply);
  }
  newConversation(): void {
    this.newConversations += 1;
  }
  history() {
    return [];
  }
  resetHistory(): void {}
}

interface Harness {
  manager: ReturnType<typeof createSessionManager>;
  events: DeviceEvent[];
  ttsCalls: Array<{ wav: Uint8Array; text: string }>;
  ends: string[];
  handle: ReturnType<ReturnType<typeof createSessionManager>["startRun"]>;
  brain: FakeBrain;
  stt: FakeStt;
  tts: FakeTts;
  store: FakeStore;
}

async function makeHarness(options: {
  config?: AppConfig;
  vadScript?: Array<Array<"start" | "end">>;
}): Promise<Harness> {
  const brain = new FakeBrain();
  const stt = new FakeStt();
  const tts = new FakeTts();
  const store = new FakeStore();
  const events: DeviceEvent[] = [];
  const ttsCalls: Array<{ wav: Uint8Array; text: string }> = [];
  const ends: string[] = [];
  const deps: SessionDeps = {
    configStore: makeConfigStore(options.config ?? makeConfig()),
    log: makeLogger(),
    stt,
    tts,
    brain,
    createVad: () => new FakeVad(options.vadScript ?? [["start"], ["end"]]),
    encodeWav: (pcm) => {
      const bytes = new Uint8Array(pcm.length * 2 + 4);
      bytes.set([82, 73, 70, 70]);
      return bytes;
    },
    store,
  };
  const manager = createSessionManager(deps);
  const sink: RunSink = {
    emit(event) {
      events.push(event);
    },
    tts(wav, text) {
      ttsCalls.push({ wav, text });
    },
    end(reason) {
      ends.push(reason);
    },
  };
  const request: RunRequest = {
    runId: "run-1",
    device: { name: "yandex-lite2-000001", mac: "020000000001", firmware: "2026.9.0" },
    flags: { useWakeWord: true },
    wakeWordPhrase: "Алиса",
    sink,
  };
  const handle = manager.startRun(request);
  const harness: Harness = { manager, events, ttsCalls, ends, handle, brain, stt, tts, store };
  return harness;
}

async function flush(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

async function waitForEnd(harness: Harness): Promise<void> {
  for (let i = 0; i < 50 && harness.ends.length === 0; i += 1) {
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(harness.ends.length).toBeGreaterThan(0);
}

describe("session manager", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the full happy path and emits the contract event order", async () => {
    const harness = await makeHarness({});
    harness.handle.onAudio(new Int16Array([10, 20]));
    await flush();
    harness.handle.onAudio(new Int16Array([30, 40]));
    await waitForEnd(harness);

    const names = harness.events.map((event) => event.event);
    expect(names).toEqual([
      "stt_start",
      "stt_vad_start",
      "stt_vad_end",
      "stt_end",
      "intent_start",
      "intent_end",
    ]);
    const intentEnd = harness.events.find((event) => event.event === "intent_end");
    expect(intentEnd?.data.speech).toBe("Готово");
    expect(intentEnd?.data.continue_conversation).toBe("1");
    expect(harness.ttsCalls).toHaveLength(1);
    expect(harness.ttsCalls[0]?.text).toBe("Готово");
    expect(harness.ends).toEqual(["done"]);
    expect(harness.brain.calls).toEqual(["включи свет"]);
    expect(harness.brain.newConversations).toBe(1);
    expect(harness.store.saved.get("run-1")?.state).toBe("finished");
  });

  it("strips the wake word from the transcript", () => {
    expect(normalizeTranscript("Алиса, включи свет")).toBe("включи свет");
    expect(normalizeTranscript("Алиса Алиса выключи телевизор")).toBe("выключи телевизор");
    expect(normalizeTranscript("включи свет, пожалуйста")).toBe("включи свет, пожалуйста");
    expect(normalizeTranscript("Яндекс, который час")).toBe("который час");
  });

  it("ends quietly when no speech is detected", async () => {
    vi.useFakeTimers();
    const harness = await makeHarness({ vadScript: [] });
    await vi.advanceTimersByTimeAsync(10_001);
    const errorEvent = harness.events.find((event) => event.event === "error");
    expect(errorEvent?.data.code).toBe("stt-no-text-recognized");
    expect(harness.ends).toEqual(["no_speech"]);
    expect(harness.store.saved.get("run-1")?.state).toBe("finished");
  });

  it("cancels on barge-in and reports cancelled state", async () => {
    const harness = await makeHarness({});
    harness.handle.onAudio(new Int16Array([1, 2]));
    harness.handle.cancel("barge_in");
    expect(harness.ends).toEqual(["barge_in"]);
    expect(harness.store.saved.get("run-1")?.state).toBe("cancelled");
    // Late audio after cancel is ignored.
    harness.handle.onAudio(new Int16Array([3, 4]));
    await flush();
    expect(harness.events.filter((event) => event.event === "stt_end")).toHaveLength(0);
  });

  it("cancels the previous run when a new run starts", async () => {
    const harness = await makeHarness({});
    const sink: RunSink = { emit: () => undefined, tts: () => undefined, end: () => undefined };
    harness.manager.startRun({
      runId: "run-2",
      device: { name: "d", mac: "m", firmware: "f" },
      flags: { useWakeWord: false },
      wakeWordPhrase: "",
      sink,
    });
    await flush();
    expect(harness.manager.active().map((run) => run.runId)).toEqual(["run-2"]);
  });

  it("sends continue_conversation=0 when follow-up is disabled", async () => {
    const config = makeConfig();
    config.conversation.followUpTimeoutMs = 0;
    const harness = await makeHarness({ config });
    harness.handle.onAudio(new Int16Array([1]));
    await flush();
    harness.handle.onAudio(new Int16Array([2]));
    await waitForEnd(harness);
    const intentEnd = harness.events.find((event) => event.event === "intent_end");
    expect(intentEnd?.data.continue_conversation).toBe("0");
  });

  it("uses native provider audio without calling tts", async () => {
    const harness = await makeHarness({});
    harness.brain.reply = {
      text: "Готово",
      speech: "Готово",
      toolTraces: [],
      audio: [new Int16Array([5, 6])],
      finish: "stop",
      durationMs: 1,
    };
    harness.handle.onAudio(new Int16Array([1]));
    await flush();
    harness.handle.onAudio(new Int16Array([2]));
    await waitForEnd(harness);
    expect(harness.ttsCalls).toHaveLength(1);
    expect(harness.ttsCalls[0]?.wav.length).toBe(4 + 2 * 2);
  });

  it("handles a text run without STT", async () => {
    const brain = new FakeBrain();
    const stt = new FakeStt();
    const tts = new FakeTts();
    const events: DeviceEvent[] = [];
    const ttsCalls: Array<{ wav: Uint8Array; text: string }> = [];
    const ends: string[] = [];
    const deps: SessionDeps = {
      configStore: makeConfigStore(makeConfig()),
      log: makeLogger(),
      stt,
      tts,
      brain,
      createVad: () => new FakeVad([]),
      encodeWav: () => new Uint8Array([1, 2]),
      store: new FakeStore(),
    };
    const manager = createSessionManager(deps);
    manager.startRun({
      runId: "text-1",
      device: { name: "d", mac: "m", firmware: "f" },
      flags: { useWakeWord: false },
      wakeWordPhrase: "",
      text: "привет",
      sink: {
        emit: (event) => events.push(event),
        tts: (wav, text) => ttsCalls.push({ wav, text }),
        end: (reason) => ends.push(reason),
      },
    });
    for (let i = 0; i < 50 && ends.length === 0; i += 1) {
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(brain.calls).toEqual(["привет"]);
    expect(events.map((event) => event.event)).toEqual(["stt_start", "stt_end", "intent_start", "intent_end"]);
    expect(ends).toEqual(["done"]);
  });

  it("accepts text input on a listening run", async () => {
    const harness = await makeHarness({ vadScript: [] });
    harness.handle.onText("включи свет");
    await waitForEnd(harness);
    expect(harness.events.map((event) => event.event)).toEqual([
      "stt_start",
      "stt_end",
      "intent_start",
      "intent_end",
    ]);
    expect(harness.brain.calls).toEqual(["включи свет"]);
    expect(harness.ends).toEqual(["done"]);
  });

  it("reports an STT failure without hanging", async () => {
    const harness = await makeHarness({ vadScript: [["start"], ["end"]] });
    harness.stt.finishError = new Error("asr down");
    harness.handle.onAudio(new Int16Array([1]));
    await flush();
    harness.handle.onAudio(new Int16Array([2]));
    await waitForEnd(harness);
    expect(harness.ends).toEqual(["error"]);
    expect(harness.events.find((event) => event.event === "error")?.data.code).toBe("stt-error");
  });
});
