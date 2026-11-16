/**
 * WebSocket bridge endpoint (docs/contracts.md §3): one run per connection.
 *
 * Inbound: run.start / text.input / vad.* / run.cancel / run.end plus binary s16le PCM
 * capture (16 kHz mono). Outbound: device.event for the session's device events,
 * tts.start + binary WAV frames + tts.end for the synthesized answer, then run.end and
 * a clean close once the session ends the run.
 *
 * No pacing: pulsar plays the answer by the URL the Python bridge publishes, so the
 * addon only has to deliver the complete WAV. All outbound messages go through one
 * ordered queue and binary frames use send callbacks (natural backpressure).
 */

import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import type {
  AppServices,
  LoggerLike,
  RunEndReason,
  RunHandleLike,
  RunSink,
} from "../shared/types.js";
import { PROTOCOL_VERSION } from "../shared/protocol.js";
import type {
  AddonDeviceEvent,
  AddonError,
  AddonRunAccepted,
  AddonRunEnd,
  AddonTtsEnd,
  AddonTtsStart,
  BridgeInbound,
} from "../shared/protocol.js";
import { bearerFromAuthorization, matchesAnyToken, tokenFromQuery } from "./auth.js";

export const BRIDGE_WS_PATH = "/api/bridge/ws";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000;
const DEFAULT_SAFETY_TIMEOUT_MS = 3000;
const WAV_FRAME_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const SEND_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 2000;

export interface BridgeServerDeps {
  services: AppServices;
  /** Bridge bearer token (services.config.bridgeToken()). */
  bridgeToken: string;
  /** How long the bridge may take to send run.start; defaults to 5 s. */
  handshakeTimeoutMs?: number;
  /** How long to wait for the session to end the run after cancel/device end; defaults to 3 s. */
  safetyTimeoutMs?: number;
}

export interface BridgeServer {
  /** Live bridge connections. */
  connections(): number;
  /** Timestamp (ms) of the last accepted run.start, or null. */
  lastRunAt(): number | null;
  close(): Promise<void>;
}

export function createBridgeServer(server: HttpServer, deps: BridgeServerDeps): BridgeServer {
  const log = deps.services.log.child("bridge");
  const handshakeTimeoutMs = deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const safetyTimeoutMs = deps.safetyTimeoutMs ?? DEFAULT_SAFETY_TIMEOUT_MS;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  let activeConnections = 0;
  let lastRunAtMs: number | null = null;

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (pathnameOf(request.url) !== BRIDGE_WS_PATH) {
      socket.destroy();
      return;
    }
    if (!isAuthorized(request, deps.bridgeToken)) {
      writeHttpRejection(socket, 401, {
        error: { code: "unauthorized", message: "Требуется Bearer-токен моста" },
      });
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  };

  server.on("upgrade", onUpgrade);

  wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
    activeConnections += 1;
    const state: ConnectionState = {
      ws,
      log,
      started: false,
      finished: false,
      handle: null,
      runId: null,
      abortRequested: false,
      ttsEndReason: null,
      ttsQueued: false,
      queue: Promise.resolve(),
      handshakeTimer: undefined,
      safetyTimer: undefined,
    };
    log.debug("bridge connection opened", { peer: peerOf(request) });

    const sink = createRunSink(state);

    state.handshakeTimer = setTimeout(() => {
      if (state.started || state.finished) return;
      log.warn("bridge handshake timed out", { peer: peerOf(request) });
      sendError(state, "handshake_timeout", "Мост не прислал run.start", true);
      finalize(state, "error");
    }, handshakeTimeoutMs);
    state.handshakeTimer.unref();

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (state.finished) return;
      try {
        if (isBinary) {
          handleBinary(state, data);
        } else {
          handleTextMessage(state, data, sink);
        }
      } catch (err) {
        log.error("bridge message handling failed", {
          runId: state.runId,
          error: err instanceof Error ? err.message : String(err),
        });
        sendError(state, "internal_error", "Ошибка обработки сообщения", false);
      }
    });

    ws.on("error", (err) => {
      log.warn("bridge socket error", {
        runId: state.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    ws.on("close", () => {
      activeConnections -= 1;
      clearTimers(state);
      if (state.handle !== null && !state.finished) {
        log.info("bridge connection closed; cancelling run", { runId: state.runId });
        state.handle.cancel("cancelled");
      }
      state.finished = true;
    });
  });

  return {
    connections(): number {
      return activeConnections;
    },
    lastRunAt(): number | null {
      return lastRunAtMs;
    },
    close(): Promise<void> {
      server.off("upgrade", onUpgrade);
      for (const client of wss.clients) client.terminate();
      return new Promise((resolve) => {
        wss.close(() => resolve());
      });
    },
  };

  // ───────────────────────────────────────────────────────────────── inbound ──

  function handleBinary(state: ConnectionState, data: RawData): void {
    if (!state.started || state.handle === null) {
      state.log.warn("binary frame before run.start ignored");
      return;
    }
    if (state.abortRequested) return;
    const pcm = toPcm16(data);
    if (pcm === null) {
      sendError(state, "invalid_audio", "Бинарный фрейм должен содержать PCM s16le", false);
      return;
    }
    state.handle.onAudio(pcm);
  }

  function handleTextMessage(state: ConnectionState, data: RawData, sink: RunSink): void {
    const text = rawDataToString(data);
    if (text === null) {
      sendError(state, "invalid_message", "Ожидается JSON-сообщение", false);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      sendError(state, "invalid_json", `Некорректный JSON: ${(err as Error).message}`, false);
      return;
    }
    if (isRecord(parsed) && parsed.type === "speech.final") {
      state.log.debug("speech.final ignored (bridge does not do STT)");
      return;
    }
    const result = BridgeInboundSchema.safeParse(parsed);
    if (!result.success) {
      const details = result.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "сообщение"}: ${issue.message}`)
        .join("; ");
      sendError(state, "invalid_message", `Некорректное сообщение: ${details}`, false);
      return;
    }
    const message = result.data;
    switch (message.type) {
      case "run.start":
        onRunStart(state, message, sink);
        return;
      case "text.input":
        handleTextInput(state, message.text);
        return;
      case "vad.start":
        handleVad(state, message.runId, "start");
        return;
      case "vad.end":
        handleVad(state, message.runId, "end");
        return;
      case "run.cancel":
        handleRunCancel(state, message.runId, message.reason);
        return;
      case "run.end":
        handleRunEnd(state, message.runId);
        return;
    }
  }

  function onRunStart(
    state: ConnectionState,
    message: Extract<BridgeInbound, { type: "run.start" }>,
    sink: RunSink,
  ): void {
    if (state.started) {
      sendError(state, "duplicate_run_start", "run.start уже получен на этом соединении", true);
      finalize(state, "error");
      return;
    }
    if (message.protocol !== PROTOCOL_VERSION) {
      sendError(
        state,
        "protocol_mismatch",
        `Ожидается протокол ${PROTOCOL_VERSION}, получен ${message.protocol}`,
        true,
      );
      finalize(state, "error");
      return;
    }
    clearHandshakeTimer(state);
    state.started = true;
    state.runId = message.runId;
    lastRunAtMs = Date.now();
    state.log.info("run.start accepted", {
      runId: message.runId,
      device: message.device.name,
      wakeWordPhrase: message.wakeWordPhrase,
    });

    const accepted: AddonRunAccepted = { type: "run.accepted", runId: message.runId };
    sendJsonSync(state, accepted);

    try {
      state.handle = deps.services.sessions.startRun({
        runId: message.runId,
        device: message.device,
        flags: message.flags,
        wakeWordPhrase: message.wakeWordPhrase,
        sink,
      });
    } catch (err) {
      state.log.error("sessions.startRun failed", {
        runId: message.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      sendError(state, "run_start_failed", "Не удалось начать run", true);
      finalize(state, "error");
    }
  }

  function handleTextInput(state: ConnectionState, text: string): void {
    if (state.handle === null) {
      sendError(state, "run_not_started", "text.input до run.start", true);
      finalize(state, "error");
      return;
    }
    state.handle.onText(text);
  }

  function handleVad(state: ConnectionState, runId: string, kind: "start" | "end"): void {
    if (!ensureRun(state, runId)) return;
    state.handle?.onVadHint(kind);
  }

  function handleRunCancel(
    state: ConnectionState,
    runId: string,
    reason: "barge_in" | "device_stop" | "timeout" | "client",
  ): void {
    if (!ensureRun(state, runId)) return;
    const cancelReason: RunEndReason = reason === "client" ? "cancelled" : reason;
    state.abortRequested = true;
    state.ttsEndReason = "cancelled";
    state.handle?.cancel(cancelReason);
    scheduleSafetyFinalize(state, cancelReason);
  }

  function handleRunEnd(state: ConnectionState, runId: string): void {
    if (!ensureRun(state, runId)) return;
    if (state.abortRequested) return;
    state.abortRequested = true;
    state.ttsEndReason = "cancelled";
    state.handle?.deviceStopped();
    scheduleSafetyFinalize(state, "device_stop");
  }

  function ensureRun(state: ConnectionState, runId: string): boolean {
    if (!state.started || state.runId === null) {
      sendError(state, "run_not_started", "Сообщение до run.start", false);
      return false;
    }
    if (state.runId !== runId) {
      state.log.warn("message runId mismatch ignored", { expected: state.runId, received: runId });
      sendError(state, "run_id_mismatch", "runId не совпадает с текущим run", false);
      return false;
    }
    return true;
  }

  // ──────────────────────────────────────────────────────────────── outbound ──

  function createRunSink(state: ConnectionState): RunSink {
    return {
      emit(event) {
        if (state.finished) return;
        const message: AddonDeviceEvent = {
          type: "device.event",
          event: event.event,
          data: event.data,
        };
        enqueue(state, async () => {
          if (state.finished && !state.started) return;
          if (isOpen(state.ws)) await sendJsonAsync(state, message);
        });
      },
      tts(wav, text) {
        if (state.finished) return;
        if (state.ttsQueued) {
          state.log.warn("duplicate tts() for one turn ignored", { runId: state.runId });
          return;
        }
        state.ttsQueued = true;
        enqueue(state, () => deliverTts(state, wav, text));
      },
      end(reason) {
        finalize(state, reason);
      },
    };
  }

  function enqueue(state: ConnectionState, task: () => Promise<void>): void {
    state.queue = state.queue
      .then(task)
      .catch((err) => {
        state.log.warn("bridge outbound task failed", {
          runId: state.runId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  async function deliverTts(state: ConnectionState, wav: Uint8Array, text: string): Promise<void> {
    if (!isOpen(state.ws) || state.abortRequested) {
      state.ttsQueued = false;
      return;
    }
    const start: AddonTtsStart = { type: "tts.start", text, format: "wav" };
    await sendJsonAsync(state, start);
    let completed = true;
    for (let offset = 0; offset < wav.byteLength; offset += WAV_FRAME_BYTES) {
      if (state.abortRequested || !isOpen(state.ws)) {
        completed = false;
        break;
      }
      const end = Math.min(offset + WAV_FRAME_BYTES, wav.byteLength);
      await sendBinaryAsync(state, Buffer.from(wav.subarray(offset, end)));
    }
    if (!isOpen(state.ws)) {
      state.ttsQueued = false;
      return;
    }
    const endMessage: AddonTtsEnd = {
      type: "tts.end",
      reason: completed ? "done" : (state.ttsEndReason ?? "cancelled"),
    };
    await sendJsonAsync(state, endMessage);
    state.ttsQueued = false;
  }

  function finalize(state: ConnectionState, reason: RunEndReason): void {
    if (state.finished) return;
    state.finished = true;
    clearTimers(state);
    if (reason !== "done") {
      state.abortRequested = true;
      if (state.ttsEndReason === null) state.ttsEndReason = reason === "error" ? "error" : "cancelled";
    }
    enqueue(state, async () => {
      if (isOpen(state.ws)) {
        const endMessage: AddonRunEnd = { type: "run.end", reason };
        await sendJsonAsync(state, endMessage);
      }
      await closeSocket(state.ws, reason === "error" ? 1011 : 1000, "run_end");
    });
  }

  function scheduleSafetyFinalize(state: ConnectionState, reason: RunEndReason): void {
    if (state.safetyTimer !== undefined) return;
    state.safetyTimer = setTimeout(() => {
      if (state.finished) return;
      state.log.warn("session did not end the run in time; closing bridge", {
        runId: state.runId,
        reason,
      });
      finalize(state, reason);
    }, safetyTimeoutMs);
    state.safetyTimer.unref();
  }

  function sendError(state: ConnectionState, code: string, message: string, fatal: boolean): void {
    const error: AddonError = { type: "error", code, message, fatal };
    sendJsonSync(state, error);
    if (fatal && state.handle !== null && !state.finished) {
      state.abortRequested = true;
      state.handle.cancel("error");
    }
  }

  function sendJsonSync(state: ConnectionState, message: object): void {
    if (!isOpen(state.ws)) return;
    try {
      state.ws.send(JSON.stringify(message), (err) => {
        // ws calls the callback with null on success (types declare Error | undefined).
        if (err) state.log.warn("bridge send failed", { error: err.message });
      });
    } catch (err) {
      state.log.warn("bridge send failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  function sendJsonAsync(state: ConnectionState, message: object): Promise<void> {
    return sendWithTimeout(state.ws, JSON.stringify(message), false);
  }

  function sendBinaryAsync(state: ConnectionState, data: Buffer): Promise<void> {
    return sendWithTimeout(state.ws, data, true);
  }

  function sendWithTimeout(ws: WebSocket, data: string | Buffer, binary: boolean): Promise<void> {
    if (!isOpen(ws)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WS send timed out")), SEND_TIMEOUT_MS);
      timer.unref();
      ws.send(data, { binary }, (err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });
  }

  function closeSocket(ws: WebSocket, code: number, reason: string): Promise<void> {
    if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        ws.terminate();
        resolve();
      }, CLOSE_TIMEOUT_MS);
      timer.unref();
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      ws.once("close", done);
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate();
        done();
      }
    });
  }
}

// ─────────────────────────────────────────────────────────────────── state ──

interface ConnectionState {
  ws: WebSocket;
  log: LoggerLike;
  started: boolean;
  finished: boolean;
  handle: RunHandleLike | null;
  runId: string | null;
  abortRequested: boolean;
  ttsEndReason: "cancelled" | "error" | null;
  ttsQueued: boolean;
  queue: Promise<void>;
  handshakeTimer: NodeJS.Timeout | undefined;
  safetyTimer: NodeJS.Timeout | undefined;
}

// ───────────────────────────────────────────────────────────────── schemas ──

const DeviceInfoSchema = z.object({
  name: z.string(),
  mac: z.string(),
  firmware: z.string(),
});

const BridgeInboundSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run.start"),
    protocol: z.number().int(),
    runId: z.string().min(1).max(200),
    device: DeviceInfoSchema,
    wakeWord: z.string(),
    wakeWordPhrase: z.string(),
    flags: z.object({ useWakeWord: z.boolean() }),
  }),
  z.object({
    type: z.literal("text.input"),
    text: z.string().min(1).max(4000),
  }),
  z.object({
    type: z.literal("vad.start"),
    runId: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("vad.end"),
    runId: z.string().min(1).max(200),
    reason: z.literal("silence"),
  }),
  z.object({
    type: z.literal("run.cancel"),
    runId: z.string().min(1).max(200),
    reason: z.enum(["barge_in", "device_stop", "timeout", "client"]),
  }),
  z.object({
    type: z.literal("run.end"),
    runId: z.string().min(1).max(200),
    reason: z.string(),
  }),
]);

// ────────────────────────────────────────────────────────────────── helpers ──

function isAuthorized(request: IncomingMessage, bridgeToken: string): boolean {
  if (bridgeToken.length === 0) return false;
  const header = request.headers.authorization;
  const headerToken = bearerFromAuthorization(typeof header === "string" ? header : undefined);
  if (headerToken !== null) return matchesAnyToken(headerToken, [bridgeToken]);
  const queryToken = tokenFromQuery(request.url);
  return queryToken !== null && matchesAnyToken(queryToken, [bridgeToken]);
}

function writeHttpRejection(socket: Duplex, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  const statusText = statusCode === 401 ? "Unauthorized" : "Bad Request";
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      "Content-Type: application/json; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
      "Connection: close\r\n" +
      "\r\n" +
      payload,
  );
  socket.destroy();
}

function pathnameOf(rawUrl: string | undefined): string {
  if (rawUrl === undefined) return "/";
  const queryIndex = rawUrl.indexOf("?");
  return queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
}

function toPcm16(data: RawData): Int16Array | null {
  let buffer: Buffer;
  if (Buffer.isBuffer(data)) {
    buffer = data;
  } else if (data instanceof ArrayBuffer) {
    buffer = Buffer.from(data);
  } else if (Array.isArray(data)) {
    buffer = Buffer.concat(data);
  } else {
    return null;
  }
  const evenLength = buffer.length - (buffer.length % 2);
  if (evenLength === 0) return null;
  const pcm = new Int16Array(evenLength / 2);
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = buffer.readInt16LE(index * 2);
  }
  return pcm;
}

function rawDataToString(data: RawData): string | null {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpen(ws: WebSocket): boolean {
  return ws.readyState === WebSocket.OPEN;
}

function clearHandshakeTimer(state: ConnectionState): void {
  if (state.handshakeTimer !== undefined) {
    clearTimeout(state.handshakeTimer);
    state.handshakeTimer = undefined;
  }
}

function clearTimers(state: ConnectionState): void {
  clearHandshakeTimer(state);
  if (state.safetyTimer !== undefined) {
    clearTimeout(state.safetyTimer);
    state.safetyTimer = undefined;
  }
}

function peerOf(request: IncomingMessage): string {
  return `${request.socket.remoteAddress ?? "unknown"}:${request.socket.remotePort ?? 0}`;
}
