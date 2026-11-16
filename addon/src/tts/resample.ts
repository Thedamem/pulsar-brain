/**
 * Output resampling for TTS: every backend must hand the bridge s16le mono at
 * the rate configured in `tts.outputSampleRate` (pulsar expects 16 kHz).
 */
import { chunkPcm, resampleLinear } from "../audio/pcm.js";

/** Rate the satellite expects (docs/contracts.md §3.2). */
export const TARGET_SAMPLE_RATE = 16_000;

/** 32 ms of 16 kHz s16le: the pacing chunk size the bridge forwards to pulsar. */
export const TTS_CHUNK_BYTES = 1_024;

/** Resample any PCM16 input to 16 kHz mono, downmixing channels first. */
export function resampleTo16kMono(input: Int16Array, fromRate: number, channels = 1): Int16Array {
  return resampleLinear(input, fromRate, TARGET_SAMPLE_RATE, channels);
}

/** Split PCM into bridge-sized chunks (last chunk may be shorter). */
export function splitTtsChunks(pcm: Int16Array): Int16Array[] {
  return chunkPcm(pcm, TTS_CHUNK_BYTES);
}
