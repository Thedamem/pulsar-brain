/**
 * Voice run / turn state machine.
 *
 * One run = one ESPHome voice request: pump microphone PCM through VAD and STT, hand the text
 * to the brain, synthesise a complete WAV answer and hand it to the bridge sink. Pulsar plays
 * the answer from a URL and starts follow-up turns as brand-new runs, so this manager never
 * keeps a run open across turns.
 */

import type {
  AudioAccumulator,
  BrainLike,
  BrainReply,
  ConfigStoreLike,
  DeviceEvent,
  EndpointingConfig,
  LoggerLike,
  PcmFormat,
  RunEndReason,
  RunHandleLike,
  RunRequest,
  RunSink,
  SessionManagerLike,
  SessionRecord,
  SttLike,
  SttResult,
  SttSession,
  TtsLike,
  VadEvent,
  WavEncoder,
} from "../shared/types.js";
import { createSessionStore, normalizeTranscript, type SessionStore } from "./history.js";

export interface SessionDeps {
  configStore: ConfigStoreLike;
  log: LoggerLike;
  stt: SttLike;
  tts: TtsLike;
  brain: BrainLike;
  createVad: (config: EndpointingConfig) => AudioAccumulator;
  encodeWav: WavEncoder;
  store: SessionStore;
  now?: () => number;
}

const PCM_16K_MONO: PcmFormat = { sampleRate: 16000, channels: 1, width: 2 };
const NO_SPEECH_TIMEOUT_MS = 10_000;
const STT_FINISH_TIMEOUT_MS = 30_000;
const TTS_TIMEOUT_MS = 30_000;
const PROGRESS_INTERVAL_MS = 8_000;

type RunState = "listening" | "processing" | "speaking" | "finished";

interface RunTimings {
  sttMs?: number;
  llmMs?: number;
  ttsMs?: number;
  totalMs?: number;
}

interface ActiveRun {
  request: RunRequest;
  sink: RunSink;
  state: RunState;
  startedAt: number;
  vad: AudioAccumulator | null;
  stt: SttSession | null;
  sttStarting: boolean;
  abort: AbortController;
  ended: boolean;
  speechStarted: boolean;
  noSpeechTimer: ReturnType<typeof setTimeout> | null;
  progressTimer: ReturnType<typeof setInterval> | null;
  timings: RunTimings;
  record: SessionRecord;
}

function concatPcm(chunks: Int16Array[]): Int16Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }
  const out = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

export function createSessionManager(deps: SessionDeps): SessionManagerLike {
  const { log } = deps;
  const active = new Map<string, ActiveRun>();
  const store: SessionStore = deps.store;

  const now = (): number => (deps.now === undefined ? Date.now() : deps.now());

  const config = () => deps.configStore.get();

  const emit = (run: ActiveRun, event: DeviceEvent["event"], data: Record<string, string>): void => {
    if (run.ended) {
      return;
    }
    try {
      run.sink.emit({ event, data });
    } catch (err) {
      log.error("session: sink emit failed", { runId: run.request.runId, event, error: errorText(err) });
    }
  };

  const stopProgress = (run: ActiveRun): void => {
    if (run.progressTimer !== null) {
      clearInterval(run.progressTimer);
      run.progressTimer = null;
    }
    if (run.noSpeechTimer !== null) {
      clearTimeout(run.noSpeechTimer);
      run.noSpeechTimer = null;
    }
  };

  const startProgress = (run: ActiveRun): void => {
    stopProgress(run);
    run.progressTimer = setInterval(() => {
      if (run.ended) {
        return;
      }
      // Pulsar re-arms its 120 s processing watchdog on every accepted event.
      emit(run, "intent_progress", { tts_start_streaming: "0" });
    }, PROGRESS_INTERVAL_MS);
    run.progressTimer.unref?.();
  };

  const persist = (run: ActiveRun, state: SessionRecord["state"], reason?: RunEndReason): void => {
    run.record.state = state;
    run.record.endedAt = now();
    run.record.timings = { ...run.timings, totalMs: now() - run.startedAt };
    if (reason !== undefined) {
      run.record.endReason = reason;
    }
    store.save(run.record);
  };

  const finish = (run: ActiveRun, reason: RunEndReason, state: SessionRecord["state"] = "finished"): void => {
    if (run.ended) {
      return;
    }
    run.ended = true;
    run.state = "finished";
    stopProgress(run);
    run.abort.abort();
    if (run.stt !== null) {
      try {
        run.stt.cancel();
      } catch (err) {
        log.warn("session: stt cancel failed", { runId: run.request.runId, error: errorText(err) });
      }
      run.stt = null;
    }
    persist(run, state, reason);
    active.delete(run.request.runId);
    try {
      run.sink.end(reason);
    } catch (err) {
      log.error("session: sink end failed", { runId: run.request.runId, error: errorText(err) });
    }
    log.debug("session: run finished", {
      runId: run.request.runId,
      reason,
      transcript: run.record.transcript,
      response: run.record.response,
      timings: run.record.timings,
    });
  };

  const cancel = (run: ActiveRun, reason: RunEndReason): void => {
    if (run.ended) {
      return;
    }
    log.info("session: cancelling run", { runId: run.request.runId, reason });
    finish(run, reason, "cancelled");
  };

  const speak = async (run: ActiveRun, reply: BrainReply): Promise<void> => {
    run.state = "speaking";
    const ttsStarted = now();
    let pcm: Int16Array;
    if (reply.audio.length > 0) {
      pcm = concatPcm(reply.audio);
    } else {
      const chunks: Int16Array[] = [];
      const synthesize = async (): Promise<void> => {
        for await (const chunk of deps.tts.synthesize(reply.speech, run.abort.signal)) {
          if (run.ended) {
            return;
          }
          chunks.push(chunk);
        }
      };
      await withTimeout(synthesize(), TTS_TIMEOUT_MS, "tts");
      pcm = concatPcm(chunks);
    }
    if (run.ended) {
      return;
    }
    if (pcm.length === 0) {
      log.warn("session: empty tts result", { runId: run.request.runId });
      emit(run, "error", { code: "tts-empty", message: "Синтез речи вернул пустой звук" });
      finish(run, "error", "failed");
      return;
    }
    run.timings.ttsMs = now() - ttsStarted;
    const wav = deps.encodeWav(pcm, { ...PCM_16K_MONO, sampleRate: config().tts.outputSampleRate });
    run.sink.tts(wav, reply.speech);
    finish(run, "done");
  };

  const turn = async (run: ActiveRun, text: string): Promise<void> => {
    if (run.ended) {
      return;
    }
    run.state = "processing";
    run.record.transcript = text;
    emit(run, "intent_start", {});
    startProgress(run);
    const llmStarted = now();
    let reply: BrainReply;
    try {
      reply = await deps.brain.respond({
        text,
        runId: run.request.runId,
        signal: run.abort.signal,
      });
    } catch (err) {
      if (!run.ended) {
        log.error("session: brain failed", { runId: run.request.runId, error: errorText(err) });
        emit(run, "error", { code: "llm-error", message: "Не удалось получить ответ" });
        finish(run, "error", "failed");
      }
      return;
    }
    if (run.ended) {
      return;
    }
    run.timings.llmMs = now() - llmStarted;
    run.record.response = reply.speech;
    run.record.toolCalls = reply.toolTraces.map((trace) => ({
      name: trace.call.name,
      args: trace.call.argumentsJson,
      ok: trace.result.ok,
    }));
    if (reply.finish === "error") {
      emit(run, "error", { code: "llm-error", message: "Провайдер вернул ошибку" });
      finish(run, "error", "failed");
      return;
    }
    const continueConversation = config().conversation.followUpTimeoutMs > 0 && reply.finish === "stop";
    emit(run, "intent_end", {
      speech: reply.speech,
      continue_conversation: continueConversation ? "1" : "0",
    });
    try {
      await speak(run, reply);
    } catch (err) {
      if (!run.ended) {
        log.error("session: tts failed", { runId: run.request.runId, error: errorText(err) });
        emit(run, "error", { code: "tts-error", message: "Не удалось озвучить ответ" });
        finish(run, "error", "failed");
      }
    }
  };

  const startStt = (run: ActiveRun): void => {
    if (run.stt !== null || run.sttStarting || run.ended) {
      return;
    }
    run.sttStarting = true;
    const language = config().stt.language;
    deps.stt
      .transcribeStream(PCM_16K_MONO, language)
      .then((session) => {
        run.sttStarting = false;
        if (run.ended) {
          session.cancel();
          return;
        }
        run.stt = session;
        const buffered = run.vad === null ? new Int16Array(0) : run.vad.utterance();
        if (buffered.length > 0) {
          session.write(buffered);
        }
      })
      .catch((err: unknown) => {
        run.sttStarting = false;
        log.error("session: stt stream failed", { runId: run.request.runId, error: errorText(err) });
        emit(run, "error", { code: "stt-unavailable", message: "Распознавание речи недоступно" });
        finish(run, "error", "failed");
      });
  };

  const finalizeStt = async (run: ActiveRun): Promise<void> => {
    run.state = "processing";
    const sttStarted = now();
    const session = run.stt;
    run.stt = null;
    let result: SttResult;
    try {
      if (session === null) {
        throw new Error("stt session was not started");
      }
      result = await withTimeout(session.finish(), STT_FINISH_TIMEOUT_MS, "stt");
    } catch (err) {
      if (run.ended) {
        return;
      }
      log.error("session: stt finish failed", { runId: run.request.runId, error: errorText(err) });
      emit(run, "error", { code: "stt-error", message: "Не удалось распознать речь" });
      finish(run, "error", "failed");
      return;
    }
    if (run.ended) {
      return;
    }
    run.timings.sttMs = now() - sttStarted;
    const text = normalizeTranscript(result.text);
    emit(run, "stt_end", { text });
    if (text.length === 0) {
      // Pulsar ends a follow-up conversation quietly on this code.
      emit(run, "error", { code: "stt-no-text-recognized", message: "Речь не распознана" });
      finish(run, "no_speech");
      return;
    }
    await turn(run, text);
  };

  const handleVadEvents = (run: ActiveRun, events: VadEvent[]): void => {
    for (const event of events) {
      if (event.kind === "speech_start") {
        if (run.speechStarted) {
          continue;
        }
        run.speechStarted = true;
        if (run.noSpeechTimer !== null) {
          clearTimeout(run.noSpeechTimer);
          run.noSpeechTimer = null;
        }
        emit(run, "stt_vad_start", {});
        startStt(run);
      } else {
        if (!run.speechStarted) {
          continue;
        }
        emit(run, "stt_vad_end", {});
        void finalizeStt(run);
      }
    }
  };

  const startRun = (request: RunRequest): RunHandleLike => {
    for (const existing of active.values()) {
      if (!existing.ended) {
        cancel(existing, "barge_in");
      }
    }
    const cfg = config();
    const startedAt = now();
    const record: SessionRecord = {
      id: request.runId,
      startedAt,
      device: request.device,
      transcript: "",
      response: "",
      toolCalls: [],
      state: "running",
      timings: {},
    };
    const run: ActiveRun = {
      request,
      sink: request.sink,
      state: "listening",
      startedAt,
      vad: null,
      stt: null,
      sttStarting: false,
      abort: new AbortController(),
      ended: false,
      speechStarted: false,
      noSpeechTimer: null,
      progressTimer: null,
      timings: {},
      record,
    };
    active.set(request.runId, run);
    if (request.wakeWordPhrase.trim().length > 0) {
      deps.brain.newConversation();
    }
    log.info("session: run started", {
      runId: request.runId,
      device: request.device.name,
      wakeWordPhrase: request.wakeWordPhrase,
      text: request.text !== undefined,
    });

    if (request.text !== undefined && request.text.trim().length > 0) {
      emit(run, "stt_start", {});
      emit(run, "stt_end", { text: request.text });
      void turn(run, request.text.trim());
    } else {
      run.vad = deps.createVad(cfg.stt.endpointing);
      // Pulsar arms its follow-up window on STT_START of a new run.
      emit(run, "stt_start", {});
      run.noSpeechTimer = setTimeout(() => {
        if (run.ended || run.speechStarted) {
          return;
        }
        emit(run, "error", { code: "stt-no-text-recognized", message: "Речь не распознана" });
        finish(run, "no_speech");
      }, NO_SPEECH_TIMEOUT_MS);
      run.noSpeechTimer.unref?.();
    }

    return {
      onAudio(chunk: Int16Array): void {
        if (run.ended || run.state !== "listening" || run.vad === null) {
          return;
        }
        if (chunk.length === 0) {
          return;
        }
        const events = run.vad.push(chunk);
        const sawSpeechStart = events.some((event) => event.kind === "speech_start");
        if (sawSpeechStart) {
          // speech_start created the STT session and wrote the utterance including this chunk.
          startStt(run);
        } else if (run.speechStarted && run.stt !== null) {
          run.stt.write(chunk);
        }
        handleVadEvents(run, events);
      },
      onText(text: string): void {
        if (run.ended || run.state !== "listening") {
          return;
        }
        if (run.noSpeechTimer !== null) {
          clearTimeout(run.noSpeechTimer);
          run.noSpeechTimer = null;
        }
        const trimmed = text.trim();
        if (trimmed.length === 0) {
          emit(run, "error", { code: "stt-no-text-recognized", message: "Пустой текст" });
          finish(run, "no_speech");
          return;
        }
        emit(run, "stt_end", { text: trimmed });
        void turn(run, trimmed);
      },
      onVadHint(): void {
        // The bridge only reports energy hints; endpointing is owned by addon-audio's VAD.
      },
      cancel(reason: RunEndReason): void {
        cancel(run, reason === "done" ? "cancelled" : reason);
      },
      deviceStopped(): void {
        cancel(run, "device_stop");
      },
    };
  };

  const toRecord = (run: ActiveRun): SessionRecord => ({ ...run.record });

  return {
    startRun,
    active(): Array<{ runId: string; startedAt: number; state: string }> {
      return [...active.values()].map((run) => ({
        runId: run.request.runId,
        startedAt: run.startedAt,
        state: run.state,
      }));
    },
    recent(limit: number): SessionRecord[] {
      const live = [...active.values()].map(toRecord);
      const persisted = store.list(limit);
      const merged = [...live, ...persisted].sort((a, b) => b.startedAt - a.startedAt);
      return merged.slice(0, Math.max(1, limit));
    },
    get(runId: string): SessionRecord | undefined {
      const live = active.get(runId);
      if (live !== undefined) {
        return toRecord(live);
      }
      return store.get(runId);
    },
  };
}

export function createSessionStoreFor(deps: Pick<SessionDeps, "log">, dbPath: string): SessionStore {
  return createSessionStore(dbPath, deps.log);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
