/**
 * TTS through an OpenAI-compatible `POST {baseUrl}/audio/speech` provider
 * (OpenAI, RouterAI, Ollama's OpenAI shim, ...).
 *
 * Only `response_format: "wav"` and `"pcm"` are accepted. WAV is decoded as
 * RIFF (sample rate and channels are read from the file); PCM is raw s16le
 * mono at `sampleRate` (24000 for OpenAI-compatible servers by default). MP3
 * and other compressed formats are rejected on purpose: no decoder is pulled
 * into the addon. The result is resampled to 16 kHz mono and yielded in 32 ms
 * chunks, like every other TTS path.
 */
import { bufferToInt16, chunkPcm, parseWav, resampleLinear } from "../audio/pcm.js";
import type { LoggerLike, ProviderHealth, TtsLike, Voice } from "../shared/types.js";
import { TARGET_SAMPLE_RATE, TTS_CHUNK_BYTES } from "./resample.js";

/** Provider TTS settings; built in index.ts from the provider + TTS config sections. */
export interface ProviderTtsConfig {
  baseUrl: string;
  apiKey: string;
  /** OpenAI-compatible speech model, e.g. gpt-4o-mini-tts or tts-1. */
  model: string;
  voice: string;
  /** Response format to request; defaults to "wav". */
  format?: "wav" | "pcm";
  /** Sample rate for raw `pcm` responses; OpenAI-compatible servers use 24000. */
  sampleRate?: number;
  extraHeaders?: Record<string, string>;
  /** Language reported by listVoices(); optional. */
  language?: string;
}

export type ProviderTtsConfigGetter = () => ProviderTtsConfig;

const DEFAULT_PCM_SAMPLE_RATE = 24_000;
const DEFAULT_FORMAT = "wav" as const;
const HEALTH_TIMEOUT_MS = 5_000;
const MAX_ERROR_BODY_CHARS = 300;

interface ResolvedProviderTtsConfig {
  baseUrl: string;
  speechUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  format: "wav" | "pcm";
  sampleRate: number;
  extraHeaders: Record<string, string>;
  language: string;
}

interface DecodedAudio {
  pcm: Int16Array;
  sampleRate: number;
  channels: number;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function normalizeBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Provider TTS baseUrl is not a valid URL: ${baseUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Provider TTS baseUrl must be http(s), got protocol ${parsed.protocol}`);
  }
  return baseUrl.replace(/\/+$/, "");
}

function resolveConfig(raw: ProviderTtsConfig): ResolvedProviderTtsConfig {
  const baseUrl = normalizeBaseUrl(raw.baseUrl.trim());
  const apiKey = raw.apiKey.trim();
  if (apiKey.length === 0) throw new Error("Provider TTS apiKey is not configured");
  const model = raw.model.trim();
  if (model.length === 0) throw new Error("Provider TTS model is not configured");
  const voice = raw.voice.trim();
  if (voice.length === 0) throw new Error("Provider TTS voice is not configured");
  const format = raw.format ?? DEFAULT_FORMAT;
  if (format !== "wav" && format !== "pcm") {
    throw new Error(`Provider TTS format must be "wav" or "pcm", got ${String(format)}`);
  }
  const sampleRate = raw.sampleRate ?? DEFAULT_PCM_SAMPLE_RATE;
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`Provider TTS sampleRate must be a positive integer, got ${sampleRate}`);
  }
  return {
    baseUrl,
    speechUrl: `${baseUrl}/audio/speech`,
    apiKey,
    model,
    voice,
    format,
    sampleRate,
    extraHeaders: raw.extraHeaders ?? {},
    language: raw.language?.trim() ?? "",
  };
}

function requestHeaders(config: ResolvedProviderTtsConfig, accept: string): Record<string, string> {
  return {
    // Extra headers stay overridable, but a plain bearer token is the default
    // contract for OpenAI-compatible endpoints.
    ...config.extraHeaders,
    authorization: `Bearer ${config.apiKey}`,
    "content-type": "application/json",
    accept,
  };
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/g, " ").trim();
    return text.length > MAX_ERROR_BODY_CHARS ? `${text.slice(0, MAX_ERROR_BODY_CHARS)}...` : text;
  } catch (error) {
    return `(error body unreadable: ${errorMessage(error)})`;
  }
}

function decodeResponse(
  config: ResolvedProviderTtsConfig,
  bytes: Uint8Array,
  contentType: string | null,
): DecodedAudio {
  if (config.format === "wav") {
    if (bytes.byteLength >= 12 && readFourCc(bytes, 0) === "RIFF" && readFourCc(bytes, 8) === "WAVE") {
      const wav = parseWav(bytes);
      return { pcm: wav.data, sampleRate: wav.format.sampleRate, channels: wav.format.channels };
    }
    const mime = (contentType ?? "").toLowerCase();
    if (mime.includes("mpeg") || mime.includes("mp3") || mime.includes("ogg") || mime.includes("flac")) {
      throw new Error(
        `Provider TTS returned ${mime || "a compressed audio format"}; only wav and pcm are supported (mp3 decoding is intentionally not implemented)`,
      );
    }
    throw new Error(
      `Provider TTS returned a non-WAV body while response_format=wav (content-type: ${contentType ?? "unknown"})`,
    );
  }

  if (bytes.byteLength % 2 !== 0) {
    throw new Error(`Provider TTS returned ${bytes.byteLength} bytes of raw PCM; expected an even s16le byte count`);
  }
  return { pcm: bufferToInt16(bytes), sampleRate: config.sampleRate, channels: 1 };
}

function readFourCc(bytes: Uint8Array, offset: number): string {
  let text = "";
  for (let i = 0; i < 4; i += 1) text += String.fromCharCode(bytes[offset + i]!);
  return text;
}

/**
 * Create the provider TTS adapter. The getter is called on every request so a
 * config change made in the UI takes effect without rebuilding the service.
 */
export function createProviderTts(getConfig: ProviderTtsConfigGetter, log?: LoggerLike): TtsLike {
  const scoped = log?.child("tts.provider");

  return {
    async *synthesize(text: string, signal: AbortSignal, voice?: string): AsyncIterable<Int16Array> {
      const config = resolveConfig(getConfig());
      const voiceName = voice?.trim() || config.voice;
      if (voiceName.length === 0) throw new Error("Provider TTS voice is not configured");
      if (text.trim().length === 0) return;
      if (signal.aborted) throw abortError("Provider TTS request cancelled");

      const body = JSON.stringify({
        model: config.model,
        input: text,
        voice: voiceName,
        response_format: config.format,
      });
      scoped?.debug("Provider TTS request", {
        url: config.speechUrl,
        format: config.format,
        voice: voiceName,
        chars: text.length,
      });

      let response: Response;
      try {
        response = await fetch(config.speechUrl, {
          method: "POST",
          headers: requestHeaders(config, "audio/wav, audio/pcm, application/octet-stream"),
          body,
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw abortError("Provider TTS request cancelled");
        throw new Error(`Provider TTS request to ${config.speechUrl} failed: ${errorMessage(error)}`);
      }

      if (!response.ok) {
        const details = await readErrorBody(response);
        throw new Error(`Provider TTS HTTP ${response.status}${details.length > 0 ? `: ${details}` : ""}`);
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      const decoded = decodeResponse(config, bytes, response.headers.get("content-type"));
      const pcm = resampleLinear(decoded.pcm, decoded.sampleRate, TARGET_SAMPLE_RATE, decoded.channels);
      for (const chunk of chunkPcm(pcm, TTS_CHUNK_BYTES)) {
        if (signal.aborted) throw abortError("Provider TTS request cancelled");
        yield chunk;
      }
    },

    async listVoices(): Promise<Voice[]> {
      const config = getConfig();
      const voice = config.voice.trim();
      if (voice.length === 0) return [];
      return [{ id: voice, name: voice, language: config.language?.trim() ?? "und" }];
    },

    async health(): Promise<ProviderHealth> {
      let config: ResolvedProviderTtsConfig;
      try {
        config = resolveConfig(getConfig());
      } catch (error) {
        return { ok: false, detail: errorMessage(error) };
      }
      const modelsUrl = `${config.baseUrl}/models`;
      try {
        const response = await fetch(modelsUrl, {
          method: "GET",
          headers: requestHeaders(config, "application/json"),
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        if (response.ok) {
          return { ok: true, detail: `Provider TTS endpoint reachable: ${config.speechUrl}` };
        }
        if (response.status === 401 || response.status === 403) {
          return { ok: false, detail: `Provider TTS authorization rejected (HTTP ${response.status})` };
        }
        return { ok: false, detail: `Provider TTS endpoint ${modelsUrl} returned HTTP ${response.status}` };
      } catch (error) {
        return { ok: false, detail: `Provider TTS endpoint ${modelsUrl} is unreachable: ${errorMessage(error)}` };
      }
    },
  };
}
