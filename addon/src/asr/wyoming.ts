/**
 * Wyoming TCP client with no external dependencies, plus the ASR adapter.
 *
 * Wire format (OHF-voice/wyoming): one newline-terminated JSON header per event,
 * `{"type", "data", "data_length", "payload_length"}`. When `data_length` is set
 * an additional JSON object of that size follows the newline and is merged into
 * `data`; when `payload_length` is set the binary payload follows (raw PCM for
 * audio-chunk). The protocol is JSONL, not 4-byte length-prefixed.
 *
 * ASR flow against wyoming-faster-whisper:
 *   transcribe -> audio-start -> audio-chunk+ -> audio-stop => transcript
 */
import { createConnection, type Socket } from "node:net";
import { PCM16_BYTES, int16ToBuffer, toMono } from "../audio/pcm.js";
import type {
  LoggerLike,
  PcmFormat,
  ProviderHealth,
  SttConfig,
  SttLike,
  SttResult,
  SttSession,
} from "../shared/types.js";

export const WYOMING_CONNECT_TIMEOUT_MS = 2_000;
export const WYOMING_READ_TIMEOUT_MS = 30_000;
/** Defensive cap for a single event header/data/payload, protects against bad peers. */
const MAX_EVENT_BYTES = 16 * 1024 * 1024;
const NEWLINE = 0x0a;

export interface WyomingTarget {
  host: string;
  port: number;
  /** Short role used in error messages, e.g. "wyoming-asr". */
  label?: string;
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
}

export interface WyomingEvent {
  type: string;
  data: Record<string, unknown>;
  payload: Uint8Array | null;
}

/** Narrowing helpers for untrusted JSON coming from the wire. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readStringField(data: Record<string, unknown>, field: string): string | undefined {
  const value = data[field];
  return typeof value === "string" ? value : undefined;
}

export function readNumberField(data: Record<string, unknown>, field: string): number | undefined {
  const value = data[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asJsonObjectArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(isJsonObject);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

export function validateWyomingTarget(target: WyomingTarget): void {
  if (typeof target.host !== "string" || target.host.trim().length === 0) {
    throw new RangeError("Wyoming host must be a non-empty string");
  }
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    throw new RangeError(`Wyoming port must be an integer in 1..65535, got ${target.port}`);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(errorMessage(error)));
      },
    );
  });
}

/**
 * One Wyoming connection. Events are read sequentially by a single consumer;
 * concurrent `readEvent` calls are not supported. Use {@link WyomingClient.connect}.
 */
export class WyomingClient {
  private readonly socket: Socket;
  private readonly host: string;
  private readonly port: number;
  private readonly label: string;
  private readonly readTimeoutMs: number;
  private readonly log: LoggerLike | undefined;
  private buffer: Buffer = Buffer.alloc(0);
  private closedError: Error | null = null;
  private wake: (() => void) | null = null;

  private constructor(
    socket: Socket,
    options: { host: string; port: number; label: string; readTimeoutMs: number; log: LoggerLike | undefined },
  ) {
    this.socket = socket;
    this.host = options.host;
    this.port = options.port;
    this.label = options.label;
    this.readTimeoutMs = options.readTimeoutMs;
    this.log = options.log;

    socket.on("data", (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.notify();
    });
    socket.on("error", (error: Error) => {
      this.markClosed(new Error(`${this.label}: connection error to ${this.host}:${this.port}: ${error.message}`));
    });
    socket.on("close", () => {
      this.markClosed(new Error(`${this.label}: connection to ${this.host}:${this.port} was closed`));
    });
  }

  static connect(target: WyomingTarget, log?: LoggerLike): Promise<WyomingClient> {
    validateWyomingTarget(target);
    const host = target.host;
    const port = target.port;
    const label = target.label ?? "wyoming";
    const connectTimeoutMs = target.connectTimeoutMs ?? WYOMING_CONNECT_TIMEOUT_MS;
    const readTimeoutMs = target.readTimeoutMs ?? WYOMING_READ_TIMEOUT_MS;

    return new Promise<WyomingClient>((resolve, reject) => {
      const socket = createConnection({ host, port });
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        if (error !== undefined) {
          socket.destroy();
          log?.warn("Wyoming connection failed", { label, host, port, error: error.message });
          reject(error);
          return;
        }
        log?.debug("Wyoming connected", { label, host, port });
        resolve(new WyomingClient(socket, { host, port, label, readTimeoutMs, log }));
      };

      timeout = setTimeout(() => {
        finish(new Error(`${label}: connect timeout after ${connectTimeoutMs} ms to ${host}:${port}`));
      }, connectTimeoutMs);
      socket.once("connect", () => finish());
      socket.once("error", (error: Error) => {
        finish(new Error(`${label}: cannot connect to ${host}:${port}: ${error.message}`));
      });
      socket.once("close", () => {
        finish(new Error(`${label}: connection to ${host}:${port} closed before it was established`));
      });
    });
  }

  /** Read the next event, honouring the configured read timeout. */
  async readEvent(): Promise<WyomingEvent> {
    return withTimeout(
      this.readEventInternal(),
      this.readTimeoutMs,
      `${this.label}: read timeout after ${this.readTimeoutMs} ms (${this.host}:${this.port})`,
    );
  }

  /**
   * Write one event. The payload is sent after the JSONL header, exactly
   * `payload_length` bytes, and the write is awaited so TCP backpressure applies.
   */
  async writeEvent(type: string, data?: Record<string, unknown>, payload?: Uint8Array): Promise<void> {
    if (this.closedError !== null) throw this.closedError;
    if (typeof type !== "string" || type.length === 0) {
      throw new TypeError("Wyoming event type must be a non-empty string");
    }
    const header: Record<string, unknown> = { type };
    if (data !== undefined && Object.keys(data).length > 0) header["data"] = data;
    const payloadBuffer = payload !== undefined && payload.byteLength > 0 ? Buffer.from(payload) : null;
    if (payloadBuffer !== null) header["payload_length"] = payloadBuffer.byteLength;
    const headerBuffer = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
    await this.writeRaw(payloadBuffer === null ? headerBuffer : Buffer.concat([headerBuffer, payloadBuffer]));
  }

  /** Close the socket. The first close reason is kept for pending/future reads. */
  close(reason?: Error): void {
    if (this.closedError === null) {
      this.closedError = reason ?? new Error(`${this.label}: connection closed`);
    }
    this.socket.destroy();
    this.notify();
  }

  private async readEventInternal(): Promise<WyomingEvent> {
    let headerLine = await this.readLine();
    while (headerLine.trim().length === 0) headerLine = await this.readLine();

    let parsed: unknown;
    try {
      parsed = JSON.parse(headerLine);
    } catch (error) {
      throw new Error(`${this.label}: malformed JSON event header: ${errorMessage(error)}`);
    }
    if (!isJsonObject(parsed)) {
      throw new Error(`${this.label}: event header is not a JSON object`);
    }
    const type = parsed["type"];
    if (typeof type !== "string" || type.length === 0) {
      throw new Error(`${this.label}: event header is missing a string "type"`);
    }

    let data: Record<string, unknown> = {};
    const headerData = parsed["data"];
    if (headerData !== undefined) {
      if (!isJsonObject(headerData)) throw new Error(`${this.label}: event "${type}" has a non-object "data"`);
      data = { ...headerData };
    }

    const dataLength = readLengthField(this.label, parsed, "data_length");
    if (dataLength > 0) {
      const bytes = await this.readExact(dataLength);
      let extra: unknown;
      try {
        extra = JSON.parse(bytes.toString("utf8"));
      } catch (error) {
        throw new Error(`${this.label}: malformed JSON in "data_length" block of event "${type}": ${errorMessage(error)}`);
      }
      if (!isJsonObject(extra)) throw new Error(`${this.label}: "data_length" block of event "${type}" is not a JSON object`);
      data = { ...data, ...extra };
    }

    const payloadLength = readLengthField(this.label, parsed, "payload_length");
    const payload = payloadLength > 0 ? new Uint8Array(await this.readExact(payloadLength)) : null;
    return { type, data, payload };
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const newlineIndex = this.buffer.indexOf(NEWLINE);
      if (newlineIndex >= 0) {
        const line = this.buffer.subarray(0, newlineIndex).toString("utf8");
        this.buffer = this.buffer.subarray(newlineIndex + 1);
        return line;
      }
      if (this.closedError !== null) throw this.closedError;
      await this.waitForData();
    }
  }

  private async readExact(byteLength: number): Promise<Buffer> {
    for (;;) {
      if (this.buffer.length >= byteLength) {
        const bytes = this.buffer.subarray(0, byteLength);
        this.buffer = this.buffer.subarray(byteLength);
        return bytes;
      }
      if (this.closedError !== null) throw this.closedError;
      await this.waitForData();
    }
  }

  private waitForData(): Promise<void> {
    if (this.closedError !== null) return Promise.reject(this.closedError);
    return new Promise<void>((resolve) => {
      this.wake = resolve;
    });
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private markClosed(error: Error): void {
    if (this.closedError === null) {
      this.closedError = error;
      this.log?.debug("Wyoming connection closed", { label: this.label, host: this.host, port: this.port, error: error.message });
    }
    this.notify();
  }

  private writeRaw(bytes: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const closed = this.closedError;
      if (closed !== null) {
        reject(closed);
        return;
      }
      this.socket.write(bytes, (error) => {
        if (error) reject(new Error(`${this.label}: write to ${this.host}:${this.port} failed: ${error.message}`));
        else resolve();
      });
    });
  }
}

function readLengthField(label: string, header: Record<string, unknown>, field: string): number {
  const value = header[field];
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label}: event header "${field}" must be a non-negative integer`);
  }
  if (value > MAX_EVENT_BYTES) throw new Error(`${label}: event header "${field}" is too large (${value} bytes)`);
  return value;
}

export function describeWyomingError(event: WyomingEvent): string {
  const text =
    readStringField(event.data, "text") ??
    readStringField(event.data, "message") ??
    readStringField(event.data, "error") ??
    "unknown error";
  const code = readStringField(event.data, "code");
  return code === undefined ? text : `${text} (${code})`;
}

/** Send `describe` and wait for `info`; used for health checks and voice listing. */
export async function requestWyomingInfo(
  target: WyomingTarget,
  log?: LoggerLike,
): Promise<Record<string, unknown>> {
  const label = target.label ?? "wyoming";
  const client = await WyomingClient.connect(target, log);
  try {
    await client.writeEvent("describe");
    for (;;) {
      const event = await client.readEvent();
      if (event.type === "info") return event.data;
      if (event.type === "error") throw new Error(`${label}: describe failed: ${describeWyomingError(event)}`);
    }
  } finally {
    client.close();
  }
}

// ─────────────────────────────────────────────────────────────── ASR ──

function assertPcmFormat(format: PcmFormat): void {
  if (format.width !== PCM16_BYTES) {
    throw new RangeError(`Wyoming ASR expects 16-bit PCM (width 2), got width ${format.width}`);
  }
  if (!Number.isInteger(format.channels) || format.channels < 1) {
    throw new RangeError(`Invalid PCM channel count: ${format.channels}`);
  }
  if (!Number.isInteger(format.sampleRate) || format.sampleRate <= 0) {
    throw new RangeError(`Invalid PCM sample rate: ${format.sampleRate}`);
  }
}

/**
 * faster-whisper only accepts bare ISO-639-1 codes (it validates against the
 * Whisper language list), so a region-qualified tag such as "ru-RU" must become
 * "ru" before it reaches the server. "auto" stays "auto" and is omitted below.
 */
function normalizeLanguageTag(language: string): string {
  const trimmed = language.trim();
  if (trimmed.length === 0) return "";
  const base = trimmed.split(/[-_]/)[0] ?? trimmed;
  return base.toLowerCase();
}

function resolveLanguage(config: SttConfig, requested: string): string {
  return normalizeLanguageTag(requested) || normalizeLanguageTag(config.language);
}

function buildTranscribeData(config: SttConfig, language: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const model = config.model.trim();
  if (model.length > 0 && model.toLowerCase() !== "auto") data["name"] = model;
  if (language.length > 0 && language.toLowerCase() !== "auto") data["language"] = language;
  return data;
}

function parseTranscript(event: WyomingEvent, fallbackLanguage: string): SttResult {
  const text = readStringField(event.data, "text");
  if (text === undefined) throw new Error("Wyoming ASR transcript event is missing a string \"text\"");
  const language = readStringField(event.data, "language") ?? fallbackLanguage;
  const confidence = readNumberField(event.data, "confidence");
  if (confidence === undefined) return { text, language };
  return { text, language, confidence };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}

class WyomingSttSession implements SttSession {
  private readonly client: WyomingClient;
  private readonly format: PcmFormat;
  private readonly language: string;
  private writeChain: Promise<void> = Promise.resolve();
  private writeError: Error | null = null;
  private finishPromise: Promise<SttResult> | null = null;
  private cancelled = false;

  constructor(client: WyomingClient, format: PcmFormat, language: string) {
    this.client = client;
    this.format = format;
    this.language = language;
  }

  write(chunk: Int16Array): void {
    if (this.cancelled) throw new Error("Wyoming STT session was cancelled");
    if (this.finishPromise !== null) throw new Error("Wyoming STT session is already finishing");
    if (chunk.length === 0) return;
    const mono = this.format.channels === 1 ? chunk : toMono(chunk, this.format.channels);
    this.writeChain = this.writeChain.then(async () => {
      if (this.writeError !== null || this.cancelled) return;
      try {
        await this.client.writeEvent(
          "audio-chunk",
          { rate: this.format.sampleRate, width: PCM16_BYTES, channels: 1 },
          int16ToBuffer(mono),
        );
      } catch (error) {
        this.writeError = asError(error);
      }
    });
  }

  finish(): Promise<SttResult> {
    if (this.finishPromise === null) this.finishPromise = this.runFinish();
    return this.finishPromise;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.client.close(abortError("Wyoming STT session cancelled"));
  }

  private async runFinish(): Promise<SttResult> {
    try {
      await this.writeChain;
      if (this.cancelled) throw new Error("Wyoming STT session was cancelled");
      if (this.writeError !== null) throw this.writeError;
      await this.client.writeEvent("audio-stop");
      for (;;) {
        const event = await this.client.readEvent();
        if (event.type === "transcript") return parseTranscript(event, this.language);
        if (event.type === "error") throw new Error(`Wyoming ASR error: ${describeWyomingError(event)}`);
        // transcript-start/chunk/stop streaming events lead up to the required
        // final "transcript", which is the only result the caller gets.
      }
    } finally {
      this.client.close();
    }
  }
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

async function openSttSession(
  config: SttConfig,
  format: PcmFormat,
  requestedLanguage: string,
  log: LoggerLike,
): Promise<SttSession> {
  assertPcmFormat(format);
  const language = resolveLanguage(config, requestedLanguage);
  const client = await WyomingClient.connect({ host: config.host, port: config.port, label: "wyoming-asr" }, log);
  try {
    await client.writeEvent("transcribe", buildTranscribeData(config, language));
    await client.writeEvent("audio-start", {
      rate: format.sampleRate,
      width: PCM16_BYTES,
      channels: 1,
    });
  } catch (error) {
    client.close();
    throw asError(error);
  }
  log.debug("STT stream started", {
    host: config.host,
    port: config.port,
    sampleRate: format.sampleRate,
    language,
  });
  return new WyomingSttSession(client, format, language);
}

/**
 * Wyoming ASR adapter (wyoming-faster-whisper). The returned session streams
 * audio chunks to the server and resolves the final transcript on `finish()`.
 */
export function createWyomingStt(config: SttConfig, log: LoggerLike): SttLike {
  validateWyomingTarget({ host: config.host, port: config.port });
  const scoped = log.child("stt");
  const host = config.host;
  const port = config.port;

  return {
    transcribeStream(format: PcmFormat, language: string): Promise<SttSession> {
      return openSttSession(config, format, language, scoped);
    },

    async transcribe(format: PcmFormat, pcm: Int16Array): Promise<SttResult> {
      const session = await openSttSession(config, format, config.language, scoped);
      try {
        session.write(pcm);
        return await session.finish();
      } catch (error) {
        session.cancel();
        throw error;
      }
    },

    async health(): Promise<ProviderHealth> {
      try {
        const info = await requestWyomingInfo({ host, port, label: "wyoming-asr" }, scoped);
        const programs = asJsonObjectArray(info["asr"]);
        if (programs.length === 0) {
          return { ok: false, detail: `ASR server at ${host}:${port} advertises no ASR programs` };
        }
        const program = programs[0]!;
        const programName = readStringField(program, "name") ?? "asr";
        const models = asJsonObjectArray(program["models"])
          .map((model) => readStringField(model, "name"))
          .filter((name): name is string => name !== undefined);
        const modelsInfo = models.length === 0 ? "no models advertised" : `${models.length} model(s): ${models.slice(0, 3).join(", ")}`;
        return { ok: true, detail: `ASR ${programName} at ${host}:${port}, ${modelsInfo}` };
      } catch (error) {
        scoped.warn("Wyoming ASR health check failed", { host, port, error: errorMessage(error) });
        return { ok: false, detail: `ASR server at ${host}:${port} is unavailable: ${errorMessage(error)}` };
      }
    },
  };
}
