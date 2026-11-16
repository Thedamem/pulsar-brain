import { createServer as createHttpServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { describe, expect, it } from "vitest";

import {
  bufferToInt16,
  chunkPcm,
  concatPcm,
  downmixToMono,
  encodeWav,
  int16ToBuffer,
  parseWav,
  peakDbfs,
  resampleLinear,
  rmsDbfs,
  silencePcm,
  toMono,
} from "../src/audio/pcm.js";
import { VAD_FRAME_MS, createAudioAccumulator } from "../src/audio/vad.js";
import { createWyomingStt } from "../src/asr/wyoming.js";
import { createProviderTts } from "../src/tts/provider.js";
import { TARGET_SAMPLE_RATE, resampleTo16kMono } from "../src/tts/resample.js";
import { createWyomingTts } from "../src/tts/wyoming.js";
import type {
  EndpointingConfig,
  LoggerLike,
  PcmFormat,
  SttConfig,
  TtsConfig,
  VadEvent,
  WavEncoder,
} from "../src/shared/types.js";

// ───────────────────────────────────────────────────────────── helpers ──

const MONO_16K: PcmFormat = { sampleRate: 16_000, channels: 1, width: 2 };

function createTestLogger(): LoggerLike {
  const make = (scope: string): LoggerLike => ({
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: (childScope: string) => make(`${scope}.${childScope}`),
    since: () => [],
    subscribe: () => () => {},
  });
  return make("test");
}

function sine(amplitude: number, frequencyHz: number, durationMs: number, sampleRate = 16_000): Int16Array {
  const samples = Math.round((sampleRate * durationMs) / 1000);
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate));
  }
  return out;
}

/** Peak amplitude of a sine whose RMS equals `dbfs`. */
function sineAmplitudeForRmsDbfs(dbfs: number): number {
  return Math.SQRT2 * 32_768 * 10 ** (dbfs / 20);
}

function maxAbs(pcm: Int16Array): number {
  let peak = 0;
  for (const sample of pcm) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function collectPcm(iterable: AsyncIterable<Int16Array>): Promise<Int16Array[]> {
  const chunks: Int16Array[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

function totalSamples(chunks: readonly Int16Array[]): number {
  return chunks.reduce((total, chunk) => total + chunk.length, 0);
}

// ─────────────────────────────────────────────────────── PCM primitives ──

describe("pcm: byte conversion", () => {
  it("round-trips s16le samples through Buffer", () => {
    const pcm = new Int16Array([0, 1, -1, 1234, -12_345, 32_767, -32_768]);
    const bytes = int16ToBuffer(pcm);
    expect(bytes.byteLength).toBe(pcm.length * 2);
    expect(Array.from(bufferToInt16(bytes))).toEqual(Array.from(pcm));
  });

  it("encodes little-endian regardless of the host byte order", () => {
    const bytes = int16ToBuffer(new Int16Array([256]));
    expect(bytes[0]).toBe(0x00);
    expect(bytes[1]).toBe(0x01);
  });

  it("honours the byte offset of a subarray view", () => {
    const backing = Buffer.from([0, 0, 1, 0, 2, 0]);
    expect(Array.from(bufferToInt16(backing.subarray(2)))).toEqual([1, 2]);
  });

  it("drops a trailing odd byte", () => {
    expect(Array.from(bufferToInt16(Buffer.from([1, 0, 2])))).toEqual([1]);
  });
});

describe("pcm: levels", () => {
  it("reports peak and RMS of a full-scale sine", () => {
    const pcm = sine(32_767, 440, 1000);
    expect(peakDbfs(pcm)).toBeGreaterThan(-0.01);
    expect(peakDbfs(pcm)).toBeLessThanOrEqual(0);
    expect(rmsDbfs(pcm)).toBeCloseTo(-3.01, 1);
  });

  it("reports -6.02 dBFS RMS for half-scale constant samples", () => {
    const pcm = new Int16Array(1000).fill(16_384);
    expect(rmsDbfs(pcm)).toBeCloseTo(-6.02, 2);
    expect(peakDbfs(pcm)).toBeCloseTo(-6.02, 2);
  });

  it("returns -Infinity for silence and empty input", () => {
    expect(rmsDbfs(silencePcm(320))).toBe(Number.NEGATIVE_INFINITY);
    expect(peakDbfs(silencePcm(320))).toBe(Number.NEGATIVE_INFINITY);
    expect(rmsDbfs(new Int16Array(0))).toBe(Number.NEGATIVE_INFINITY);
    expect(peakDbfs(new Int16Array(0))).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("pcm: concat, silence, chunking, downmix", () => {
  it("concatenates chunks in order", () => {
    const joined = concatPcm([new Int16Array([1, 2]), new Int16Array(0), new Int16Array([3, 4, 5])]);
    expect(Array.from(joined)).toEqual([1, 2, 3, 4, 5]);
  });

  it("creates the requested amount of silence", () => {
    const silence = silencePcm(10);
    expect(silence.length).toBe(10);
    expect(maxAbs(silence)).toBe(0);
    expect(() => silencePcm(-1)).toThrow(RangeError);
  });

  it("splits PCM into byte-sized chunks without changing the samples", () => {
    const pcm = new Int16Array(1000);
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = i;
    const chunks = chunkPcm(pcm, 1024);
    expect(chunks.map((chunk) => chunk.length)).toEqual([512, 488]);
    expect(chunks.map((chunk) => chunk.length * 2)).toEqual([1024, 976]);
    expect(Array.from(concatPcm(chunks))).toEqual(Array.from(pcm));
  });

  it("returns no chunks for empty PCM", () => {
    expect(chunkPcm(new Int16Array(0), 1024)).toEqual([]);
  });

  it("rejects invalid chunk sizes", () => {
    const pcm = new Int16Array(10);
    expect(() => chunkPcm(pcm, 0)).toThrow(RangeError);
    expect(() => chunkPcm(pcm, 1)).toThrow(RangeError);
    expect(() => chunkPcm(pcm, 1023)).toThrow(RangeError);
    expect(() => chunkPcm(pcm, 1024.5)).toThrow(RangeError);
  });

  it("downmixes stereo by averaging channels", () => {
    const stereo = new Int16Array([100, 200, -100, 100, 0, 0]);
    expect(Array.from(toMono(stereo, 2))).toEqual([150, 0, 0]);
    expect(Array.from(downmixToMono(stereo, 2))).toEqual([150, 0, 0]);
  });

  it("copies mono input and ignores a trailing partial frame", () => {
    const mono = new Int16Array([1, 2, 3]);
    const copy = toMono(mono, 1);
    expect(Array.from(copy)).toEqual([1, 2, 3]);
    expect(copy).not.toBe(mono);
    expect(Array.from(toMono(new Int16Array([1, 2, 3, 4, 5]), 2))).toEqual([2, 4]);
  });

  it("rejects invalid channel counts", () => {
    expect(() => toMono(new Int16Array(4), 0)).toThrow(RangeError);
    expect(() => toMono(new Int16Array(4), 1.5)).toThrow(RangeError);
  });
});

// ──────────────────────────────────────────────────────────── resampler ──

describe("pcm: linear resampler", () => {
  it("turns one second at 22050 Hz into one second at 16000 Hz", () => {
    const input = sine(sineAmplitudeForRmsDbfs(-20), 440, 1000, 22_050);
    const output = resampleLinear(input, 22_050, 16_000);
    expect(output.length).toBe(16_000);
    expect(maxAbs(output)).toBeGreaterThan(0.9 * 4634);
    expect(maxAbs(output)).toBeLessThanOrEqual(4634);
    expect(output.every((sample) => Number.isFinite(sample))).toBe(true);
  });

  it("interpolates on upsampling", () => {
    const output = resampleLinear(new Int16Array([0, 1000, 2000, 3000]), 8000, 16_000);
    expect(Array.from(output)).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000, 3000]);
  });

  it("returns the same samples for equal rates", () => {
    const input = new Int16Array([5, -5, 1000]);
    expect(Array.from(resampleLinear(input, 16_000, 16_000))).toEqual(Array.from(input));
  });

  it("downmixes stereo while resampling", () => {
    const frames = 22_050;
    const stereo = new Int16Array(frames * 2);
    for (let frame = 0; frame < frames; frame += 1) {
      stereo[frame * 2] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * frame) / 22_050));
      stereo[frame * 2 + 1] = 0;
    }
    const output = resampleLinear(stereo, 22_050, 16_000, 2);
    expect(output.length).toBe(16_000);
    const peak = maxAbs(output);
    expect(peak).toBeGreaterThan(3800);
    expect(peak).toBeLessThan(4200);
  });

  it("handles empty input", () => {
    expect(resampleLinear(new Int16Array(0), 22_050, 16_000).length).toBe(0);
  });

  it("rejects zero and negative rates instead of dividing by zero", () => {
    const input = new Int16Array([1, 2, 3]);
    expect(() => resampleLinear(input, 0, 16_000)).toThrow(RangeError);
    expect(() => resampleLinear(input, 22_050, 0)).toThrow(RangeError);
    expect(() => resampleLinear(input, -1, 16_000)).toThrow(RangeError);
    expect(() => resampleLinear(input, Number.NaN, 16_000)).toThrow(RangeError);
  });

  it("rejects invalid channel counts", () => {
    expect(() => resampleLinear(new Int16Array([1, 2]), 22_050, 16_000, 0)).toThrow(RangeError);
  });

  it("resamples to 16 kHz mono through the TTS helper", () => {
    const input = sine(4000, 440, 1000, 24_000);
    expect(resampleTo16kMono(input, 24_000).length).toBe(16_000);
    expect(TARGET_SAMPLE_RATE).toBe(16_000);
  });
});

// ────────────────────────────────────────────────────────────────── WAV ──

describe("pcm: WAV", () => {
  it("round-trips a mono 16 kHz WAV", () => {
    const pcm = sine(8000, 440, 500);
    const bytes = encodeWav(pcm, MONO_16K);
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");

    const parsed = parseWav(bytes);
    expect(parsed.format).toEqual(MONO_16K);
    expect(Array.from(parsed.data)).toEqual(Array.from(pcm));
  });

  it("round-trips a stereo WAV", () => {
    const stereo = new Int16Array(2000);
    for (let i = 0; i < stereo.length; i += 1) stereo[i] = i - 1000;
    const parsed = parseWav(encodeWav(stereo, { sampleRate: 22_050, channels: 2, width: 2 }));
    expect(parsed.format).toEqual({ sampleRate: 22_050, channels: 2, width: 2 });
    expect(Array.from(parsed.data)).toEqual(Array.from(stereo));
  });

  it("is assignable to the shared WavEncoder contract", () => {
    const encoder: WavEncoder = encodeWav;
    const bytes = encoder(sine(1000, 440, 20), MONO_16K);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(parseWav(bytes).format).toEqual(MONO_16K);
  });

  it("skips unknown RIFF chunks", () => {
    const pcm = sine(1000, 220, 100);
    const base = encodeWav(pcm, MONO_16K);
    const listPayload = Buffer.from("INFOsome metadata", "ascii");
    // Odd payload sizes are padded to a word boundary, exactly like a real RIFF file.
    const listChunk = Buffer.alloc(8 + listPayload.length + (listPayload.length % 2));
    listChunk.write("LIST", 0, 4, "ascii");
    listChunk.writeUInt32LE(listPayload.length, 4);
    listPayload.copy(listChunk, 8);
    const withList = Buffer.concat([base.subarray(0, 36), listChunk, base.subarray(36)]);
    const parsed = parseWav(withList);
    expect(Array.from(parsed.data)).toEqual(Array.from(pcm));
  });

  it("rejects non-RIFF data", () => {
    expect(() => parseWav(Buffer.alloc(12))).toThrow(/RIFF/);
    expect(() => parseWav(Buffer.alloc(4))).toThrow(/too short/);
  });

  it("rejects non-16-bit PCM", () => {
    const bytes = encodeWav(sine(1000, 440, 50), MONO_16K);
    bytes.writeUInt16LE(24, 34);
    expect(() => parseWav(bytes)).toThrow(/16-bit/);
    const floatBytes = encodeWav(sine(1000, 440, 50), MONO_16K);
    floatBytes.writeUInt16LE(3, 20);
    expect(() => parseWav(floatBytes)).toThrow(/unsupported audio format/);
  });

  it("rejects a WAV without a data chunk", () => {
    const bytes = encodeWav(sine(1000, 440, 50), MONO_16K);
    expect(() => parseWav(bytes.subarray(0, 40))).toThrow(/missing data chunk/);
  });

  it("rejects encode input with a non-16-bit width", () => {
    expect(() => encodeWav(sine(1000, 440, 20), { sampleRate: 16_000, channels: 1, width: 4 })).toThrow(RangeError);
  });
});

// ────────────────────────────────────────────────────────────── VAD ──

const VAD_CONFIG: EndpointingConfig = {
  silenceThresholdDb: -45,
  sentenceSilenceMs: 400,
  minSpeechMs: 300,
  maxUtteranceMs: 10_000,
  preRollMs: 200,
};

function buildSpeechSignal(): Int16Array {
  const tone = sine(sineAmplitudeForRmsDbfs(-20), 440, 600);
  return concatPcm([silencePcm(Math.round(0.3 * 16_000)), tone, silencePcm(Math.round(0.8 * 16_000))]);
}

describe("vad: endpointing", () => {
  it("emits speech_start/end and keeps pre-roll + speech + trailing silence", () => {
    const accumulator = createAudioAccumulator(VAD_CONFIG);
    const events = accumulator.push(buildSpeechSignal());

    expect(events).toEqual<VadEvent[]>([
      { kind: "speech_start", atMs: 300 },
      { kind: "speech_end", atMs: 1300 },
    ]);
    expect(accumulator.hasSpeech()).toBe(true);
    expect(accumulator.speechMs()).toBe(600);
    expect(accumulator.totalMs()).toBe(1200);
    expect(accumulator.utterance().length).toBe(19_200);
  });

  it("produces the same events for arbitrary chunk sizes", () => {
    const signal = buildSpeechSignal();
    const accumulator = createAudioAccumulator(VAD_CONFIG);
    const chunkSizes = [1, 7, 160, 1024, 333, 319, 512, 64];
    const events: VadEvent[] = [];
    let offset = 0;
    let index = 0;
    while (offset < signal.length) {
      const size = chunkSizes[index % chunkSizes.length]!;
      const part = signal.subarray(offset, Math.min(offset + size, signal.length));
      events.push(...accumulator.push(part));
      offset += part.length;
      index += 1;
    }

    expect(events).toEqual<VadEvent[]>([
      { kind: "speech_start", atMs: 300 },
      { kind: "speech_end", atMs: 1300 },
    ]);
    const expected = signal.subarray(1600, 1600 + 19_200);
    expect(Array.from(accumulator.utterance())).toEqual(Array.from(expected));
  });

  it("waits for a complete 20 ms frame", () => {
    const accumulator = createAudioAccumulator(VAD_CONFIG);
    expect(accumulator.push(silencePcm(319))).toEqual([]);
    expect(accumulator.totalMs()).toBe(0);
    expect(accumulator.push(silencePcm(1))).toEqual([]);
    expect(accumulator.totalMs()).toBe(VAD_FRAME_MS);
  });

  it("ignores speech shorter than minSpeechMs", () => {
    const shortTone = sine(sineAmplitudeForRmsDbfs(-20), 440, 200);
    const accumulator = createAudioAccumulator(VAD_CONFIG);
    const events = accumulator.push(concatPcm([shortTone, silencePcm(8000)]));
    expect(events).toEqual([]);
    expect(accumulator.hasSpeech()).toBe(false);
    expect(accumulator.speechMs()).toBe(0);
  });

  it("ends the utterance forcibly at maxUtteranceMs", () => {
    const accumulator = createAudioAccumulator({
      silenceThresholdDb: -45,
      sentenceSilenceMs: 5000,
      minSpeechMs: 100,
      maxUtteranceMs: 500,
      preRollMs: 100,
    });
    const events = accumulator.push(sine(sineAmplitudeForRmsDbfs(-20), 440, 2000));

    expect(events).toEqual<VadEvent[]>([
      { kind: "speech_start", atMs: 0 },
      { kind: "speech_end", atMs: 500 },
    ]);
    expect(accumulator.speechMs()).toBe(500);
    expect(accumulator.totalMs()).toBe(500);
    expect(accumulator.utterance().length).toBe(8000);
  });

  it("includes the configured pre-roll before speech", () => {
    const accumulator = createAudioAccumulator({
      silenceThresholdDb: -45,
      sentenceSilenceMs: 200,
      minSpeechMs: 100,
      maxUtteranceMs: 10_000,
      preRollMs: 100,
    });
    const signal = concatPcm([
      silencePcm(3200),
      sine(sineAmplitudeForRmsDbfs(-20), 440, 300),
      silencePcm(4000),
    ]);
    const events = accumulator.push(signal);
    expect(events).toEqual<VadEvent[]>([
      { kind: "speech_start", atMs: 200 },
      { kind: "speech_end", atMs: 700 },
    ]);
    // 100 ms pre-roll + 300 ms speech + 200 ms trailing silence.
    expect(accumulator.utterance().length).toBe(9600);
  });

  it("stops collecting and can be reset for the next utterance", () => {
    const accumulator = createAudioAccumulator(VAD_CONFIG);
    accumulator.push(buildSpeechSignal());
    expect(accumulator.push(silencePcm(3200))).toEqual([]);
    const beforeReset = accumulator.utterance().length;

    accumulator.reset();
    expect(accumulator.hasSpeech()).toBe(false);
    expect(accumulator.totalMs()).toBe(0);
    expect(accumulator.speechMs()).toBe(0);
    expect(accumulator.utterance().length).toBe(0);
    expect(accumulator.push(silencePcm(320))).toEqual([]);

    // The stream clock restarts at 0: the next utterance is measured from the
    // first sample pushed after reset().
    const next = accumulator.push(buildSpeechSignal());
    expect(next).toEqual<VadEvent[]>([
      { kind: "speech_start", atMs: 320 },
      { kind: "speech_end", atMs: 1320 },
    ]);
    expect(accumulator.utterance().length).toBe(19_200);
    expect(beforeReset).toBe(19_200);
  });

  it("validates the endpointing config", () => {
    expect(() => createAudioAccumulator({ ...VAD_CONFIG, maxUtteranceMs: 0 })).toThrow(RangeError);
    expect(() => createAudioAccumulator({ ...VAD_CONFIG, minSpeechMs: -1 })).toThrow(RangeError);
    expect(() => createAudioAccumulator({ ...VAD_CONFIG, silenceThresholdDb: Number.NaN })).toThrow(TypeError);
    expect(() => createAudioAccumulator({ ...VAD_CONFIG, preRollMs: -5 })).toThrow(RangeError);
  });
});

// ──────────────────────────────────────────────── mock Wyoming helpers ──

interface WireEvent {
  type: string;
  data: Record<string, unknown>;
  payload: Buffer | null;
}

type WireSend = (type: string, data?: Record<string, unknown>, payload?: Uint8Array) => void;

function encodeWireEvent(type: string, data?: Record<string, unknown>, payload?: Uint8Array): Buffer {
  const header: Record<string, unknown> = { type };
  if (data !== undefined) header["data"] = data;
  const payloadBuffer = payload !== undefined ? Buffer.from(payload) : null;
  if (payloadBuffer !== null) header["payload_length"] = payloadBuffer.byteLength;
  const head = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
  return payloadBuffer === null ? head : Buffer.concat([head, payloadBuffer]);
}

function decodeWireEvents(buffer: Buffer): { events: WireEvent[]; rest: Buffer } {
  const events: WireEvent[] = [];
  let rest = buffer;
  for (;;) {
    const newline = rest.indexOf(0x0a);
    if (newline < 0) break;
    const headerText = rest.subarray(0, newline).toString("utf8");
    let header: unknown;
    try {
      header = JSON.parse(headerText);
    } catch {
      throw new Error(`mock Wyoming peer received invalid JSON: ${headerText}`);
    }
    if (!isRecord(header)) throw new Error("mock Wyoming peer received a non-object header");
    const payloadLength = typeof header["payload_length"] === "number" ? header["payload_length"] : 0;
    const afterHeader = rest.subarray(newline + 1);
    if (afterHeader.length < payloadLength) break;
    const payload = payloadLength > 0 ? Buffer.from(afterHeader.subarray(0, payloadLength)) : null;
    events.push({
      type: String(header["type"]),
      data: isRecord(header["data"]) ? header["data"] : {},
      payload,
    });
    rest = afterHeader.subarray(payloadLength);
  }
  return { events, rest };
}

class MockWyomingServer {
  readonly events: WireEvent[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly waiters = new Map<string, Array<(event: WireEvent) => void>>();

  private constructor(
    private readonly server: ReturnType<typeof createTcpServer>,
    handler: (event: WireEvent, send: WireSend) => void,
  ) {
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => {
        // A cancelled client is a normal part of the edge-case tests.
      });
      let buffer: Buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const parsed = decodeWireEvents(buffer);
        buffer = parsed.rest;
        const send: WireSend = (type, data, payload) => {
          socket.write(encodeWireEvent(type, data, payload));
        };
        for (const event of parsed.events) {
          this.events.push(event);
          this.notify(event);
          handler(event, send);
        }
      });
    });
  }

  static start(handler: (event: WireEvent, send: WireSend) => void): Promise<MockWyomingServer> {
    return new Promise((resolve, reject) => {
      const server = createTcpServer();
      const mock = new MockWyomingServer(server, handler);
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(mock));
    });
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  waitForEvent(type: string, timeoutMs = 2000): Promise<WireEvent> {
    const existing = this.events.find((event) => event.type === type);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<WireEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`mock Wyoming peer: timed out waiting for "${type}"`));
      }, timeoutMs);
      const list = this.waiters.get(type) ?? [];
      list.push((event) => {
        clearTimeout(timer);
        resolve(event);
      });
      this.waiters.set(type, list);
    });
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private notify(event: WireEvent): void {
    const list = this.waiters.get(event.type);
    if (list === undefined) return;
    this.waiters.delete(event.type);
    for (const waiter of list) waiter(event);
  }
}

function makeSttConfig(port: number): SttConfig {
  return {
    provider: "wyoming",
    host: "127.0.0.1",
    port,
    language: "ru-RU",
    model: "auto",
    endpointing: VAD_CONFIG,
  };
}

function makeTtsConfig(port: number, voice = "ru_RU-irina-medium"): TtsConfig {
  return {
    mode: "piper",
    piper: { host: "127.0.0.1", port, voice },
    provider: { model: "tts-1", voice: "alloy", format: "wav", language: "ru-RU" },
    outputSampleRate: TARGET_SAMPLE_RATE,
  };
}

// ───────────────────────────────────────────────────────── mock HTTP ──

interface CapturedHttpRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

type HttpHandler = (request: CapturedHttpRequest, response: ServerResponse) => void;

class MockHttpServer {
  readonly requests: CapturedHttpRequest[] = [];
  private readonly waiters: Array<() => void> = [];

  private constructor(
    private readonly server: ReturnType<typeof createHttpServer>,
    handler: HttpHandler,
  ) {
    server.on("request", (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const captured: CapturedHttpRequest = {
          method: request.method ?? "GET",
          url: request.url ?? "/",
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        this.requests.push(captured);
        const waiters = this.waiters.splice(0);
        for (const waiter of waiters) waiter();
        handler(captured, response);
      });
    });
  }

  static start(handler: HttpHandler): Promise<MockHttpServer> {
    return new Promise((resolve, reject) => {
      const server = createHttpServer();
      const mock = new MockHttpServer(server, handler);
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(mock));
    });
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  waitForRequest(timeoutMs = 2000): Promise<void> {
    if (this.requests.length > 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("mock HTTP server: timed out waiting for a request")), timeoutMs);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

// ───────────────────────────────────────────── provider TTS (mock HTTP) ──

describe("tts/provider: OpenAI-compatible speech endpoint", () => {
  it("decodes a WAV response and resamples it to 16 kHz", async () => {
    const wav = encodeWav(sine(4000, 440, 400, 24_000), { sampleRate: 24_000, channels: 1, width: 2 });
    const server = await MockHttpServer.start((request, response) => {
      if (request.method === "POST" && request.url === "/v1/audio/speech") {
        response.writeHead(200, { "content-type": "audio/wav" });
        response.end(wav);
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
    });
    try {
      const tts = createProviderTts(
        () => ({
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          apiKey: "test-key",
          model: "tts-1",
          voice: "alloy",
          format: "wav",
        }),
        createTestLogger(),
      );
      const chunks = await collectPcm(tts.synthesize("Привет", new AbortController().signal));
      expect(totalSamples(chunks)).toBe(6400);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0]!.length).toBe(512);
      for (const chunk of chunks.slice(0, -1)) expect(chunk.length).toBe(512);
      expect(chunks[chunks.length - 1]!.length).toBeLessThanOrEqual(512);

      const request = server.requests[0]!;
      expect(request.url).toBe("/v1/audio/speech");
      expect(request.method).toBe("POST");
      expect(request.headers["authorization"]).toBe("Bearer test-key");
      const body: unknown = JSON.parse(request.body);
      if (!isRecord(body)) throw new Error("provider request body is not a JSON object");
      expect(body["model"]).toBe("tts-1");
      expect(body["input"]).toBe("Привет");
      expect(body["voice"]).toBe("alloy");
      expect(body["response_format"]).toBe("wav");
    } finally {
      await server.close();
    }
  });

  it("decodes raw PCM at the configured sample rate", async () => {
    const pcm = sine(4000, 440, 250, 24_000);
    const server = await MockHttpServer.start((_request, response) => {
      response.writeHead(200, { "content-type": "audio/pcm" });
      response.end(int16ToBuffer(pcm));
    });
    try {
      const tts = createProviderTts(
        () => ({
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          apiKey: "test-key",
          model: "tts-1",
          voice: "alloy",
          format: "pcm",
          sampleRate: 24_000,
        }),
        createTestLogger(),
      );
      const chunks = await collectPcm(tts.synthesize("Привет", new AbortController().signal));
      expect(totalSamples(chunks)).toBe(4000);
      const body: unknown = JSON.parse(server.requests[0]!.body);
      if (!isRecord(body)) throw new Error("provider request body is not a JSON object");
      expect(body["response_format"]).toBe("pcm");
    } finally {
      await server.close();
    }
  });

  it("rejects mp3 responses instead of pulling a decoder", async () => {
    const server = await MockHttpServer.start((_request, response) => {
      response.writeHead(200, { "content-type": "audio/mpeg" });
      response.end(Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    });
    try {
      const tts = createProviderTts(
        () => ({
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          apiKey: "test-key",
          model: "tts-1",
          voice: "alloy",
          format: "wav",
        }),
        createTestLogger(),
      );
      await expect(collectPcm(tts.synthesize("Привет", new AbortController().signal))).rejects.toThrow(
        /only wav and pcm/,
      );
    } finally {
      await server.close();
    }
  });

  it("surfaces provider HTTP errors with the response body", async () => {
    const server = await MockHttpServer.start((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "boom" }));
    });
    try {
      const tts = createProviderTts(
        () => ({
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          apiKey: "test-key",
          model: "tts-1",
          voice: "alloy",
          format: "wav",
        }),
        createTestLogger(),
      );
      await expect(collectPcm(tts.synthesize("Привет", new AbortController().signal))).rejects.toThrow(
        /HTTP 500.*boom/,
      );
    } finally {
      await server.close();
    }
  });

  it("aborts an in-flight request", async () => {
    const server = await MockHttpServer.start(() => {
      // Never answer: the test aborts while the request is in flight.
    });
    try {
      const controller = new AbortController();
      const tts = createProviderTts(
        () => ({
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          apiKey: "test-key",
          model: "tts-1",
          voice: "alloy",
          format: "wav",
        }),
        createTestLogger(),
      );
      const iterator = tts.synthesize("Привет", controller.signal)[Symbol.asyncIterator]();
      const pending = iterator.next();
      await server.waitForRequest();
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await server.close();
    }
  });

  it("reports voices and health, and rejects missing configuration", async () => {
    const modelsServer = await MockHttpServer.start((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [] }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    try {
      const tts = createProviderTts(
        () => ({
          baseUrl: `http://127.0.0.1:${modelsServer.port}/v1`,
          apiKey: "test-key",
          model: "tts-1",
          voice: "alloy",
          language: "ru-RU",
        }),
        createTestLogger(),
      );
      expect(await tts.listVoices()).toEqual([{ id: "alloy", name: "alloy", language: "ru-RU" }]);
      const health = await tts.health();
      expect(health.ok).toBe(true);
      expect(health.detail).toContain("/v1/audio/speech");
    } finally {
      await modelsServer.close();
    }

    const unauthorizedServer = await MockHttpServer.start((_request, response) => {
      response.writeHead(401);
      response.end();
    });
    try {
      const tts = createProviderTts(
        () => ({
          baseUrl: `http://127.0.0.1:${unauthorizedServer.port}/v1`,
          apiKey: "bad-key",
          model: "tts-1",
          voice: "alloy",
          format: "wav",
        }),
        createTestLogger(),
      );
      const health = await tts.health();
      expect(health.ok).toBe(false);
      expect(health.detail).toMatch(/authorization rejected/);
    } finally {
      await unauthorizedServer.close();
    }

    const unconfigured = createProviderTts(
      () => ({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "", model: "tts-1", voice: "alloy" }),
      createTestLogger(),
    );
    expect(await unconfigured.listVoices()).toEqual([{ id: "alloy", name: "alloy", language: "und" }]);
    await expect(collectPcm(unconfigured.synthesize("Привет", new AbortController().signal))).rejects.toThrow(
      /apiKey/,
    );
    expect((await unconfigured.health()).ok).toBe(false);
  });
});

// ──────────────────────────────────────────────── Wyoming ASR (mock TCP) ──

describe("asr/wyoming: whisper adapter", () => {
  it("streams audio and resolves the transcript", async () => {
    const server = await MockWyomingServer.start((event, send) => {
      if (event.type === "describe") {
        send("info", {
          asr: [
            {
              name: "faster-whisper",
              models: [{ name: "small", languages: ["ru"], installed: true }],
            },
          ],
          tts: [],
        });
      } else if (event.type === "audio-stop") {
        send("transcript", { text: "привет", language: "ru-RU" });
      }
    });
    try {
      const stt = createWyomingStt(makeSttConfig(server.port), createTestLogger());
      const session = await stt.transcribeStream(MONO_16K, "ru-RU");
      session.write(sine(4000, 440, 500));
      const result = await session.finish();
      expect(result).toEqual({ text: "привет", language: "ru-RU" });

      const transcribe = server.events.find((event) => event.type === "transcribe");
      expect(transcribe?.data["language"]).toBe("ru");
      expect(transcribe?.data["name"]).toBeUndefined();
      const audioStart = server.events.find((event) => event.type === "audio-start");
      expect(audioStart?.data).toMatchObject({ rate: 16_000, width: 2, channels: 1 });
      const audioBytes = server.events
        .filter((event) => event.type === "audio-chunk")
        .reduce((total, event) => total + (event.payload?.byteLength ?? 0), 0);
      expect(audioBytes).toBe(16_000);
      expect(server.events[server.events.length - 1]!.type).toBe("audio-stop");

      const health = await stt.health();
      expect(health.ok).toBe(true);
      expect(health.detail).toContain("faster-whisper");
    } finally {
      await server.close();
    }
  });

  it("sends the configured whisper model", async () => {
    const server = await MockWyomingServer.start((event, send) => {
      if (event.type === "audio-stop") send("transcript", { text: "ок" });
    });
    try {
      const config: SttConfig = { ...makeSttConfig(server.port), model: "small" };
      const stt = createWyomingStt(config, createTestLogger());
      const session = await stt.transcribeStream(MONO_16K, "");
      session.write(silencePcm(3200));
      const result = await session.finish();
      expect(result.text).toBe("ок");
      const transcribe = server.events.find((event) => event.type === "transcribe");
      expect(transcribe?.data["name"]).toBe("small");
      expect(transcribe?.data["language"]).toBe("ru");
    } finally {
      await server.close();
    }
  });

  it("supports one-shot transcription", async () => {
    const server = await MockWyomingServer.start((event, send) => {
      if (event.type === "audio-stop") send("transcript", { text: "одноразово" });
    });
    try {
      const stt = createWyomingStt(makeSttConfig(server.port), createTestLogger());
      const result = await stt.transcribe(MONO_16K, sine(4000, 440, 200));
      expect(result.text).toBe("одноразово");
    } finally {
      await server.close();
    }
  });

  it("surfaces a Wyoming error event", async () => {
    const server = await MockWyomingServer.start((event, send) => {
      if (event.type === "audio-stop") send("error", { text: "model exploded", code: "ValueError" });
    });
    try {
      const stt = createWyomingStt(makeSttConfig(server.port), createTestLogger());
      const session = await stt.transcribeStream(MONO_16K, "ru-RU");
      session.write(silencePcm(320));
      await expect(session.finish()).rejects.toThrow(/model exploded \(ValueError\)/);
    } finally {
      await server.close();
    }
  });

  it("cancels a session and closes the socket", async () => {
    const server = await MockWyomingServer.start(() => {
      // Hold the connection open; the client is expected to cancel.
    });
    try {
      const stt = createWyomingStt(makeSttConfig(server.port), createTestLogger());
      const session = await stt.transcribeStream(MONO_16K, "ru-RU");
      await server.waitForEvent("audio-start");
      session.cancel();
      await expect(session.finish()).rejects.toThrow(/cancelled/);
      expect(() => session.write(silencePcm(320))).toThrow(/cancelled/);
    } finally {
      await server.close();
    }
  });

  it("reports an unavailable server instead of throwing from health()", async () => {
    const server = await MockWyomingServer.start(() => {});
    const port = server.port;
    await server.close();
    const stt = createWyomingStt(makeSttConfig(port), createTestLogger());
    const health = await stt.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain(String(port));
    await expect(stt.transcribe(MONO_16K, silencePcm(320))).rejects.toThrow(/cannot connect/);
  });
});

// ──────────────────────────────────────────────── Wyoming TTS (mock TCP) ──

describe("tts/wyoming: piper adapter", () => {
  function piperServer(rate = 22_050): (event: WireEvent, send: WireSend) => void {
    return (event, send) => {
      if (event.type === "describe") {
        send("info", {
          asr: [],
          tts: [
            {
              name: "piper",
              voices: [
                {
                  name: "ru_RU-irina-medium",
                  description: "Irina (medium)",
                  languages: ["ru-RU"],
                  installed: true,
                },
              ],
            },
          ],
        });
      } else if (event.type === "synthesize") {
        const pcm = sine(5000, 440, 1000, rate);
        const split = Math.floor(pcm.length / 2);
        send("audio-start", { rate, width: 2, channels: 1 });
        send("audio-chunk", { rate, width: 2, channels: 1 }, int16ToBuffer(pcm.subarray(0, split)));
        send("audio-chunk", { rate, width: 2, channels: 1 }, int16ToBuffer(pcm.subarray(split)));
        send("audio-stop");
      }
    };
  }

  it("describes voices and resamples piper audio to the output rate", async () => {
    const server = await MockWyomingServer.start(piperServer());
    try {
      const tts = createWyomingTts(makeTtsConfig(server.port), createTestLogger());
      expect(await tts.listVoices()).toEqual([
        { id: "ru_RU-irina-medium", name: "Irina (medium)", language: "ru-RU" },
      ]);
      const health = await tts.health();
      expect(health.ok).toBe(true);
      expect(health.detail).toContain("piper");

      const chunks = await collectPcm(tts.synthesize("Привет", new AbortController().signal));
      expect(totalSamples(chunks)).toBe(16_000);
      const bytes = chunks.map((chunk) => chunk.length * 2);
      for (const chunkBytes of bytes.slice(0, -1)) expect(chunkBytes).toBe(1024);
      expect(bytes[bytes.length - 1]!).toBeLessThanOrEqual(1024);

      const synthesize = server.events.find((event) => event.type === "synthesize");
      expect(synthesize?.data).toEqual({ text: "Привет", voice: { name: "ru_RU-irina-medium" } });
    } finally {
      await server.close();
    }
  });

  it("uses the per-request voice override", async () => {
    const server = await MockWyomingServer.start(piperServer());
    try {
      const tts = createWyomingTts(makeTtsConfig(server.port), createTestLogger());
      await collectPcm(tts.synthesize("Привет", new AbortController().signal, "ru_RU-dmitri-medium"));
      const synthesize = server.events.find((event) => event.type === "synthesize");
      expect(synthesize?.data["voice"]).toEqual({ name: "ru_RU-dmitri-medium" });
    } finally {
      await server.close();
    }
  });

  it("aborts synthesis and closes the socket", async () => {
    const server = await MockWyomingServer.start((event, send) => {
      if (event.type === "synthesize") {
        send("audio-start", { rate: 22_050, width: 2, channels: 1 });
        send("audio-chunk", { rate: 22_050, width: 2, channels: 1 }, int16ToBuffer(sine(5000, 440, 100)));
        // No audio-stop: the client has to be aborted.
      }
    });
    try {
      const controller = new AbortController();
      const tts = createWyomingTts(makeTtsConfig(server.port), createTestLogger());
      const iterator = tts.synthesize("Привет", controller.signal)[Symbol.asyncIterator]();
      const pending = iterator.next();
      await server.waitForEvent("synthesize");
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await server.close();
    }
  });

  it("surfaces Wyoming error events", async () => {
    const server = await MockWyomingServer.start((event, send) => {
      if (event.type === "synthesize") send("error", { text: "voice not found", code: "VoiceNotFound" });
    });
    try {
      const tts = createWyomingTts(makeTtsConfig(server.port), createTestLogger());
      await expect(collectPcm(tts.synthesize("Привет", new AbortController().signal))).rejects.toThrow(
        /voice not found \(VoiceNotFound\)/,
      );
    } finally {
      await server.close();
    }
  });

  it("reports an unavailable piper instead of throwing from health()", async () => {
    const server = await MockWyomingServer.start(() => {});
    const port = server.port;
    await server.close();
    const tts = createWyomingTts(makeTtsConfig(port), createTestLogger());
    const health = await tts.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain(String(port));
  });

  it("validates the configured output sample rate", () => {
    expect(() => createWyomingTts({ ...makeTtsConfig(1), outputSampleRate: 0 }, createTestLogger())).toThrow(
      RangeError,
    );
  });
});

// ────────────────────────────────────────────────── live Wyoming Piper ──

const livePiperHost = process.env["PIPER_HOST"];
const livePiperPort = Number(process.env["PIPER_PORT"] ?? "10200");
const livePiperLabel =
  livePiperHost === undefined
    ? "skipped: PIPER_HOST is not set, so the dev wyoming-piper stack is not running"
    : `PIPER_HOST=${livePiperHost}:${livePiperPort}`;

describe.skipIf(livePiperHost === undefined)(`live Wyoming Piper (${livePiperLabel})`, () => {
  it(
    "reports voices and synthesizes 16 kHz PCM",
    async () => {
      const tts = createWyomingTts(
        {
          mode: "piper",
          piper: {
            host: livePiperHost ?? "127.0.0.1",
            port: livePiperPort,
            voice: process.env["PIPER_VOICE"] ?? "ru_RU-irina-medium",
          },
          provider: { model: "", voice: "", format: "wav", language: "ru-RU" },
          outputSampleRate: TARGET_SAMPLE_RATE,
        },
        createTestLogger(),
      );
      const health = await tts.health();
      expect(health.ok).toBe(true);
      const voices = await tts.listVoices();
      expect(voices.length).toBeGreaterThan(0);
      const voice = voices[0]!.id;
      const chunks = await collectPcm(tts.synthesize("Привет", new AbortController().signal, voice));
      expect(totalSamples(chunks)).toBeGreaterThan(4000);
      for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(512);
    },
    60_000,
  );
});
