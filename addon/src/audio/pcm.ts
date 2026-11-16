/**
 * PCM16 helpers for every audio path in the addon.
 *
 * The pipeline speaks one format: interleaved signed 16-bit little-endian
 * samples, 16 kHz mono towards the satellite (docs/contracts.md §3.1). Only
 * `width: 2` sample containers are accepted; 16-bit linear PCM is the only WAV
 * flavour decoded here.
 */
import type { PcmFormat } from "../shared/types.js";

/** Bytes per s16le sample. */
export const PCM16_BYTES = 2;

const INT16_MIN = -32768;
const INT16_MAX = 32767;
/** Full-scale amplitude for dBFS math: |−32768| === 32768. */
const FULL_SCALE = 32768;

function clampInt16(value: number): number {
  if (value > INT16_MAX) return INT16_MAX;
  if (value < INT16_MIN) return INT16_MIN;
  return value;
}

function assertFormat(format: PcmFormat): void {
  if (format.width !== PCM16_BYTES) {
    throw new RangeError(`Expected ${PCM16_BYTES}-byte PCM samples, got width ${format.width}`);
  }
  if (!Number.isInteger(format.channels) || format.channels < 1) {
    throw new RangeError(`Invalid PCM channel count: ${format.channels}`);
  }
  if (!Number.isFinite(format.sampleRate) || format.sampleRate <= 0) {
    throw new RangeError(`Invalid PCM sample rate: ${format.sampleRate}`);
  }
}

/** Decode interleaved s16le bytes to samples. A trailing odd byte is dropped. */
export function bufferToInt16(buffer: Uint8Array): Int16Array {
  const samples = Math.floor(buffer.byteLength / PCM16_BYTES);
  const out = new Int16Array(samples);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let i = 0; i < samples; i += 1) {
    out[i] = view.getInt16(i * PCM16_BYTES, true);
  }
  return out;
}

/** Encode samples as interleaved s16le bytes (always little-endian). */
export function int16ToBuffer(pcm: Int16Array): Buffer {
  const out = Buffer.alloc(pcm.length * PCM16_BYTES);
  for (let i = 0; i < pcm.length; i += 1) {
    out.writeInt16LE(pcm[i]!, i * PCM16_BYTES);
  }
  return out;
}

/** Concatenate PCM arrays preserving sample order. */
export function concatPcm(chunks: readonly Int16Array[]): Int16Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Allocate silence (zero samples). */
export function silencePcm(samples: number): Int16Array {
  if (!Number.isInteger(samples) || samples < 0) {
    throw new RangeError(`Invalid silence sample count: ${samples}`);
  }
  return new Int16Array(samples);
}

/** RMS level in dBFS; -Infinity for empty or all-zero input. */
export function rmsDbfs(pcm: Int16Array): number {
  const samples = pcm.length;
  if (samples === 0) return Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const sample = pcm[i]!;
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / samples);
  if (rms === 0) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(rms / FULL_SCALE);
}

/** Peak level in dBFS; -Infinity for empty or all-zero input. */
export function peakDbfs(pcm: Int16Array): number {
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const magnitude = Math.abs(pcm[i]!);
    if (magnitude > peak) peak = magnitude;
  }
  if (peak === 0) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(peak / FULL_SCALE);
}

/**
 * Split PCM into chunks of exactly `chunkBytes` bytes (last chunk may be
 * shorter). `chunkBytes` must be a positive even number: a chunk boundary
 * cannot fall inside a sample.
 */
export function chunkPcm(pcm: Int16Array, chunkBytes: number): Int16Array[] {
  if (!Number.isInteger(chunkBytes) || chunkBytes < PCM16_BYTES || chunkBytes % PCM16_BYTES !== 0) {
    throw new RangeError(`Invalid PCM chunk size: ${chunkBytes} bytes (expected a positive even number)`);
  }
  const samplesPerChunk = chunkBytes / PCM16_BYTES;
  const chunks: Int16Array[] = [];
  for (let offset = 0; offset < pcm.length; offset += samplesPerChunk) {
    chunks.push(pcm.subarray(offset, Math.min(offset + samplesPerChunk, pcm.length)));
  }
  return chunks;
}

/**
 * Downmix interleaved PCM to mono by averaging channels. A trailing partial
 * frame is ignored; mono input is copied.
 */
export function toMono(pcm: Int16Array, channels: number): Int16Array {
  if (!Number.isInteger(channels) || channels < 1) {
    throw new RangeError(`Invalid channel count: ${channels}`);
  }
  if (channels === 1) return new Int16Array(pcm);
  const frames = Math.floor(pcm.length / channels);
  const out = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    const base = frame * channels;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += pcm[base + channel]!;
    }
    out[frame] = clampInt16(Math.round(sum / channels));
  }
  return out;
}

/** Alias of {@link toMono} matching the audio-processing term used elsewhere. */
export const downmixToMono = toMono;

/**
 * Linear interpolation resampler for PCM16. Multi-channel input is downmixed
 * to mono first (the rest of the pipeline is mono), so the result always has
 * `input.length / channels * toRate / fromRate` mono samples.
 *
 * Plain linear interpolation: good enough for voice at 16 kHz, no anti-alias
 * filter. Invalid rates are rejected instead of dividing by zero.
 */
export function resampleLinear(
  input: Int16Array,
  fromRate: number,
  toRate: number,
  channels = 1,
): Int16Array {
  if (!Number.isFinite(fromRate) || fromRate <= 0) {
    throw new RangeError(`Invalid source sample rate: ${fromRate}`);
  }
  if (!Number.isFinite(toRate) || toRate <= 0) {
    throw new RangeError(`Invalid target sample rate: ${toRate}`);
  }
  if (!Number.isInteger(channels) || channels < 1) {
    throw new RangeError(`Invalid channel count: ${channels}`);
  }
  const mono = toMono(input, channels);
  if (mono.length === 0) return mono;
  if (fromRate === toRate) return mono;

  const outLength = Math.max(1, Math.round((mono.length * toRate) / fromRate));
  const step = fromRate / toRate;
  const lastIndex = mono.length - 1;
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const position = i * step;
    const index = Math.floor(position);
    const fraction = position - index;
    const left = mono[Math.min(index, lastIndex)]!;
    const right = mono[Math.min(index + 1, lastIndex)]!;
    out[i] = clampInt16(Math.round(left + (right - left) * fraction));
  }
  return out;
}

/** Decoded WAV: sample format plus interleaved samples. */
export interface ParsedWav {
  format: PcmFormat;
  data: Int16Array;
}

function readAscii(buffer: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let i = 0; i < length; i += 1) {
    text += String.fromCharCode(buffer[offset + i]!);
  }
  return text;
}

/**
 * Parse a RIFF/WAVE file with 16-bit linear PCM (format 1, or WAVE_FORMAT_EXTENSIBLE
 * whose subformat is PCM). Unknown chunks are skipped; multiple `data` chunks are
 * concatenated; a declared `data` size that overruns the buffer (streaming WAV
 * writers use 0xFFFFFFFF) is clamped to what is available.
 */
export function parseWav(buffer: Uint8Array): ParsedWav {
  if (buffer.byteLength < 12) {
    throw new Error(`WAV parse: buffer too short (${buffer.byteLength} bytes)`);
  }
  if (readAscii(buffer, 0, 4) !== "RIFF") {
    throw new Error("WAV parse: missing RIFF header");
  }
  if (readAscii(buffer, 8, 4) !== "WAVE") {
    throw new Error("WAV parse: missing WAVE form type");
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let format: PcmFormat | undefined;
  const dataChunks: Int16Array[] = [];
  let offset = 12;

  while (offset + 8 <= buffer.byteLength) {
    const chunkId = readAscii(buffer, offset, 4);
    const declaredSize = view.getUint32(offset + 4, true);
    const payloadOffset = offset + 8;
    const available = buffer.byteLength - payloadOffset;
    const isData = chunkId === "data";
    const size = isData && declaredSize > available ? available : declaredSize;
    if (size > available) {
      throw new Error(
        `WAV parse: truncated "${chunkId}" chunk (declared ${declaredSize} bytes, ${available} available)`,
      );
    }

    if (chunkId === "fmt ") {
      if (size < 16) {
        throw new Error(`WAV parse: "fmt " chunk is too short (${size} bytes)`);
      }
      let audioFormat = view.getUint16(payloadOffset, true);
      const channels = view.getUint16(payloadOffset + 2, true);
      const sampleRate = view.getUint32(payloadOffset + 4, true);
      const bitsPerSample = view.getUint16(payloadOffset + 14, true);
      if (audioFormat === 0xfffe) {
        // WAVE_FORMAT_EXTENSIBLE: the actual format is the first field of the
        // SubFormat GUID at the end of the 40-byte WAVEFORMATEXTENSIBLE header.
        if (size < 40) {
          throw new Error("WAV parse: extensible fmt chunk is too short");
        }
        audioFormat = view.getUint16(payloadOffset + 24, true);
      }
      if (audioFormat !== 1) {
        throw new Error(`WAV parse: unsupported audio format ${audioFormat} (only PCM)`);
      }
      if (bitsPerSample !== 16) {
        throw new Error(`WAV parse: unsupported ${bitsPerSample}-bit samples (only 16-bit PCM)`);
      }
      if (channels < 1) {
        throw new Error(`WAV parse: invalid channel count ${channels}`);
      }
      if (sampleRate < 1) {
        throw new Error(`WAV parse: invalid sample rate ${sampleRate}`);
      }
      format = { sampleRate, channels, width: PCM16_BYTES };
    } else if (isData) {
      dataChunks.push(bufferToInt16(buffer.subarray(payloadOffset, payloadOffset + size)));
    }

    // RIFF chunks are word-aligned: an odd payload is followed by one pad byte.
    offset = payloadOffset + size + (size % 2);
  }

  if (format === undefined) {
    throw new Error("WAV parse: missing fmt chunk");
  }
  if (dataChunks.length === 0) {
    throw new Error("WAV parse: missing data chunk");
  }
  return { format, data: concatPcm(dataChunks) };
}

/** Encode 16-bit PCM as a canonical 44-byte-header RIFF/WAVE file. */
export function encodeWav(pcm: Int16Array, format: PcmFormat): Buffer {
  assertFormat(format);
  const dataSize = pcm.length * PCM16_BYTES;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, 4, "ascii");
  header.write("fmt ", 12, 4, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(format.sampleRate * format.channels * PCM16_BYTES, 28);
  header.writeUInt16LE(format.channels * PCM16_BYTES, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, 4, "ascii");
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, int16ToBuffer(pcm)], header.length + dataSize);
}
