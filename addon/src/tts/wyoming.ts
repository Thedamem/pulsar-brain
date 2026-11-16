/**
 * Wyoming TTS adapter (wyoming-piper).
 *
 * Flow: synthesize {text, voice:{name}} -> audio-start {rate,width,channels} ->
 * audio-chunk+ (raw PCM payload) -> audio-stop. Piper usually produces 22050 Hz,
 * so the result is resampled to `config.tts.outputSampleRate` and yielded as
 * 32 ms chunks. The whole utterance is buffered before chunking: piper is fast
 * and the bridge paces playback, so streaming every server chunk gains nothing.
 */
import { PCM16_BYTES, bufferToInt16, concatPcm, resampleLinear } from "../audio/pcm.js";
import {
  WyomingClient,
  asJsonObjectArray,
  describeWyomingError,
  errorMessage,
  readNumberField,
  readStringField,
  requestWyomingInfo,
  validateWyomingTarget,
  type WyomingTarget,
} from "../asr/wyoming.js";
import type { LoggerLike, PcmFormat, ProviderHealth, TtsConfig, TtsLike, Voice } from "../shared/types.js";
import { splitTtsChunks } from "./resample.js";

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function readAudioFormat(data: Record<string, unknown>): PcmFormat {
  const rate = readNumberField(data, "rate");
  const width = readNumberField(data, "width");
  const channels = readNumberField(data, "channels");
  if (rate === undefined || !Number.isInteger(rate) || rate <= 0) {
    throw new Error("Wyoming TTS audio event is missing a valid sample rate");
  }
  if (width !== PCM16_BYTES) {
    throw new Error(`Wyoming TTS returned unsupported sample width ${width ?? "none"} (only 16-bit PCM)`);
  }
  if (channels === undefined || !Number.isInteger(channels) || channels < 1) {
    throw new Error("Wyoming TTS audio event is missing a valid channel count");
  }
  return { sampleRate: rate, channels, width: PCM16_BYTES };
}

/** Parse `info.tts[].voices` (older servers use `models`) into the shared Voice shape. */
function parseVoices(info: Record<string, unknown>): Voice[] {
  const voices: Voice[] = [];
  for (const program of asJsonObjectArray(info["tts"])) {
    const rawVoices = Array.isArray(program["voices"])
      ? program["voices"]
      : Array.isArray(program["models"])
        ? program["models"]
        : [];
    for (const raw of asJsonObjectArray(rawVoices)) {
      const id = readStringField(raw, "name");
      if (id === undefined || id.length === 0) continue;
      const description = readStringField(raw, "description");
      const languages = Array.isArray(raw["languages"])
        ? raw["languages"].filter((language): language is string => typeof language === "string")
        : [];
      voices.push({
        id,
        name: description !== undefined && description.length > 0 ? description : id,
        language: languages[0] ?? "",
      });
    }
  }
  const seen = new Set<string>();
  return voices.filter((voice) => {
    if (seen.has(voice.id)) return false;
    seen.add(voice.id);
    return true;
  });
}

/**
 * Wyoming TTS adapter. `voice` overrides `config.piper.voice` for one request
 * (used by the UI preview and by the "provider voice" mode when it still wants
 * a specific Piper voice).
 */
export function createWyomingTts(config: TtsConfig, log: LoggerLike): TtsLike {
  validateWyomingTarget({ host: config.piper.host, port: config.piper.port });
  if (!Number.isInteger(config.outputSampleRate) || config.outputSampleRate <= 0) {
    throw new RangeError(`Invalid TTS outputSampleRate: ${config.outputSampleRate}`);
  }

  const host = config.piper.host;
  const port = config.piper.port;
  const outputSampleRate = config.outputSampleRate;
  const defaultVoice = config.piper.voice.trim();
  const target: WyomingTarget = { host, port, label: "wyoming-tts" };
  const scoped = log.child("tts");

  return {
    async *synthesize(text: string, signal: AbortSignal, voice?: string): AsyncIterable<Int16Array> {
      if (signal.aborted) throw abortError("Wyoming TTS request cancelled");
      if (text.trim().length === 0) return;

      const voiceName = voice?.trim() || defaultVoice;
      const client = await WyomingClient.connect(target, scoped);
      const onAbort = (): void => client.close(abortError("Wyoming TTS request cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        if (signal.aborted) throw abortError("Wyoming TTS request cancelled");
        const synthesizeData: Record<string, unknown> = { text };
        if (voiceName.length > 0) synthesizeData["voice"] = { name: voiceName };
        await client.writeEvent("synthesize", synthesizeData);
        scoped.debug("TTS synthesis started", {
          host,
          port,
          voice: voiceName.length > 0 ? voiceName : "(server default)",
          chars: text.length,
        });

        let format: PcmFormat | null = null;
        const chunks: Int16Array[] = [];
        for (;;) {
          const event = await client.readEvent();
          if (event.type === "audio-start") {
            format = readAudioFormat(event.data);
          } else if (event.type === "audio-chunk") {
            if (event.payload === null || event.payload.byteLength === 0) continue;
            if (format === null) format = readAudioFormat(event.data);
            chunks.push(bufferToInt16(event.payload));
          } else if (event.type === "audio-stop") {
            break;
          } else if (event.type === "error") {
            throw new Error(`Wyoming TTS error: ${describeWyomingError(event)}`);
          }
        }

        if (format === null || chunks.length === 0) {
          scoped.debug("TTS returned no audio", { host, port });
          return;
        }

        const resampled = resampleLinear(concatPcm(chunks), format.sampleRate, outputSampleRate, format.channels);
        for (const chunk of splitTtsChunks(resampled)) {
          if (signal.aborted) throw abortError("Wyoming TTS request cancelled");
          yield chunk;
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        client.close();
      }
    },

    async listVoices(): Promise<Voice[]> {
      const info = await requestWyomingInfo(target, scoped);
      return parseVoices(info);
    },

    async health(): Promise<ProviderHealth> {
      try {
        const info = await requestWyomingInfo(target, scoped);
        const programs = asJsonObjectArray(info["tts"]);
        if (programs.length === 0) {
          return { ok: false, detail: `TTS server at ${host}:${port} advertises no TTS programs` };
        }
        const programName = readStringField(programs[0]!, "name") ?? "tts";
        const voices = parseVoices(info);
        return { ok: true, detail: `TTS ${programName} at ${host}:${port}, ${voices.length} voice(s)` };
      } catch (error) {
        scoped.warn("Wyoming TTS health check failed", { host, port, error: errorMessage(error) });
        return { ok: false, detail: `TTS server at ${host}:${port} is unavailable: ${errorMessage(error)}` };
      }
    },
  };
}
