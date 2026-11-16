/**
 * Energy-based endpointing (VAD) for the microphone stream.
 *
 * Works on the only format the bridge delivers: s16le mono 16 kHz
 * (docs/contracts.md §3.1). Input is sliced into fixed 20 ms frames, so
 * arbitrary socket chunk sizes are fine; a frame counts as speech when its RMS
 * level is above `silenceThresholdDb`.
 *
 * Events:
 * - `speech_start` after `minSpeechMs` of contiguous speech. The timestamp
 *   points at the first sample of that speech, not at the frame that confirmed
 *   it: the utterance starts there and includes that audio.
 * - `speech_end` after `sentenceSilenceMs` of silence, or forcibly once the
 *   utterance reaches `maxUtteranceMs` measured from its first speech sample.
 *
 * Timestamps are milliseconds since the last `reset()`.
 */
import type { AudioAccumulator, EndpointingConfig, VadEvent } from "../shared/types.js";
import { concatPcm, rmsDbfs } from "./pcm.js";

export const VAD_SAMPLE_RATE = 16_000;
export const VAD_FRAME_MS = 20;
const FRAME_SAMPLES = (VAD_SAMPLE_RATE * VAD_FRAME_MS) / 1000;

interface NormalizedConfig {
  silenceThresholdDb: number;
  sentenceSilenceMs: number;
  minSpeechMs: number;
  maxUtteranceMs: number;
}

function normalizeConfig(config: EndpointingConfig): NormalizedConfig {
  const fields: Array<keyof NormalizedConfig> = [
    "silenceThresholdDb",
    "sentenceSilenceMs",
    "minSpeechMs",
    "maxUtteranceMs",
  ];
  for (const field of fields) {
    if (!Number.isFinite(config[field])) {
      throw new TypeError(`Endpointing config "${field}" must be a finite number, got ${config[field]}`);
    }
  }
  if (config.sentenceSilenceMs < 0) {
    throw new RangeError(`Endpointing config "sentenceSilenceMs" must be >= 0, got ${config.sentenceSilenceMs}`);
  }
  if (config.minSpeechMs < 0) {
    throw new RangeError(`Endpointing config "minSpeechMs" must be >= 0, got ${config.minSpeechMs}`);
  }
  if (config.maxUtteranceMs <= 0) {
    throw new RangeError(`Endpointing config "maxUtteranceMs" must be > 0, got ${config.maxUtteranceMs}`);
  }
  if (!Number.isFinite(config.preRollMs) || config.preRollMs < 0) {
    throw new RangeError(`Endpointing config "preRollMs" must be >= 0, got ${config.preRollMs}`);
  }
  return {
    silenceThresholdDb: config.silenceThresholdDb,
    sentenceSilenceMs: config.sentenceSilenceMs,
    minSpeechMs: config.minSpeechMs,
    maxUtteranceMs: config.maxUtteranceMs,
  };
}

function samplesToMs(samples: number): number {
  return (samples * 1000) / VAD_SAMPLE_RATE;
}

class EndpointingAccumulator implements AudioAccumulator {
  private readonly cfg: NormalizedConfig;
  private readonly preRollFrames: number;
  private readonly maxUtteranceSamples: number;

  /** Samples of the last partial frame carried over between pushes. */
  private pending: Int16Array = new Int16Array(0);
  /** Frames currently retained: pre-roll + candidate speech + active utterance. */
  private frames: Int16Array[] = [];
  /** Stream position, samples pushed and fully framed since reset. */
  private consumedSamples = 0;
  private state: "idle" | "speaking" | "ended" = "idle";
  /** Contiguous speech frames seen while idle (candidate for speech_start). */
  private speechRunFrames = 0;
  /** Contiguous silence frames seen while speaking. */
  private silenceRunFrames = 0;
  /** Speech frames in the current utterance. */
  private speechFrames = 0;
  /** Absolute sample index of the first frame of the current speech run. */
  private firstSpeechSample = 0;
  private speechStarted = false;

  constructor(config: EndpointingConfig, preRollMs: number) {
    this.cfg = normalizeConfig(config);
    this.preRollFrames = Math.round(preRollMs / VAD_FRAME_MS);
    this.maxUtteranceSamples = (this.cfg.maxUtteranceMs * VAD_SAMPLE_RATE) / 1000;
  }

  push(chunk: Int16Array): VadEvent[] {
    if (this.state === "ended" || chunk.length === 0) return [];

    let data: Int16Array;
    if (this.pending.length === 0) {
      data = chunk;
    } else {
      data = new Int16Array(this.pending.length + chunk.length);
      data.set(this.pending, 0);
      data.set(chunk, this.pending.length);
    }

    const events: VadEvent[] = [];
    let offset = 0;
    while (data.length - offset >= FRAME_SAMPLES && !this.isEnded()) {
      const frame = data.slice(offset, offset + FRAME_SAMPLES);
      this.processFrame(frame, this.consumedSamples, events);
      offset += FRAME_SAMPLES;
      this.consumedSamples += FRAME_SAMPLES;
    }
    // After an endpoint the rest of the chunk belongs to the next utterance;
    // the caller resets and feeds it again.
    this.pending = this.isEnded() ? new Int16Array(0) : data.slice(offset);
    return events;
  }

  hasSpeech(): boolean {
    return this.speechStarted;
  }

  utterance(): Int16Array {
    return concatPcm(this.frames);
  }

  speechMs(): number {
    return this.speechFrames * VAD_FRAME_MS;
  }

  totalMs(): number {
    return this.frames.length * VAD_FRAME_MS;
  }

  reset(): void {
    this.pending = new Int16Array(0);
    this.frames = [];
    this.consumedSamples = 0;
    this.state = "idle";
    this.speechRunFrames = 0;
    this.silenceRunFrames = 0;
    this.speechFrames = 0;
    this.firstSpeechSample = 0;
    this.speechStarted = false;
  }

  private isEnded(): boolean {
    return this.state === "ended";
  }

  private processFrame(frame: Int16Array, frameStartSample: number, events: VadEvent[]): void {
    const isSpeech = rmsDbfs(frame) > this.cfg.silenceThresholdDb;

    if (this.state === "speaking") {
      this.frames.push(frame);
      if (isSpeech) {
        this.speechFrames += 1;
        this.silenceRunFrames = 0;
      } else {
        this.silenceRunFrames += 1;
      }
      this.checkSpeakingEnd(frameStartSample + FRAME_SAMPLES, events);
      return;
    }

    this.frames.push(frame);
    if (!isSpeech) {
      this.speechRunFrames = 0;
      this.trimFrames(this.preRollFrames);
      return;
    }

    if (this.speechRunFrames === 0) {
      this.firstSpeechSample = frameStartSample;
    }
    this.speechRunFrames += 1;
    if (this.speechRunFrames * VAD_FRAME_MS >= this.cfg.minSpeechMs) {
      this.beginSpeech(frameStartSample + FRAME_SAMPLES, events);
      return;
    }
    this.trimFrames(this.preRollFrames + this.speechRunFrames);
  }

  private beginSpeech(endSample: number, events: VadEvent[]): void {
    this.state = "speaking";
    this.speechStarted = true;
    this.speechFrames = this.speechRunFrames;
    this.silenceRunFrames = 0;
    this.speechRunFrames = 0;
    events.push({ kind: "speech_start", atMs: samplesToMs(this.firstSpeechSample) });
    this.checkSpeakingEnd(endSample, events);
  }

  private checkSpeakingEnd(endSample: number, events: VadEvent[]): void {
    const elapsedSamples = endSample - this.firstSpeechSample;
    const forced = elapsedSamples >= this.maxUtteranceSamples;
    const silenceReached = this.silenceRunFrames * VAD_FRAME_MS >= this.cfg.sentenceSilenceMs;
    if (!forced && !silenceReached) return;
    this.state = "ended";
    this.speechRunFrames = 0;
    events.push({ kind: "speech_end", atMs: samplesToMs(endSample) });
  }

  private trimFrames(maxFrames: number): void {
    while (this.frames.length > maxFrames) {
      this.frames.shift();
    }
  }
}

/** Build an endpointing accumulator for one microphone run. */
export function createAudioAccumulator(config: EndpointingConfig): AudioAccumulator {
  return new EndpointingAccumulator(config, config.preRollMs);
}
