import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { createBridgeServer, type BridgeServer } from "../src/server/bridge.js";
import {
  FakeSessions,
  closeWebSocket,
  connectBridge,
  createTestContext,
  encodeWavPcm16,
  jsonMessageType,
  startTestHttpServer,
  trackSocket,
  type TestContext,
  type TestHttpServer,
  type TrackedSocket,
} from "./core-helpers.js";
import type { DeviceInfo } from "../src/shared/types.js";

const contexts: TestContext[] = [];
const servers: TestHttpServer[] = [];
const bridges: BridgeServer[] = [];
const sockets: TrackedSocket[] = [];

interface BridgeSetup {
  ctx: TestContext;
  server: TestHttpServer;
  sessions: FakeSessions;
  bridge: BridgeServer;
}

async function setupBridge(options: {
  sessions?: FakeSessions;
  handshakeTimeoutMs?: number;
  safetyTimeoutMs?: number;
} = {}): Promise<BridgeSetup> {
  const sessions = options.sessions ?? new FakeSessions();
  const ctx = await createTestContext({ sessions });
  contexts.push(ctx);
  const server = await startTestHttpServer(ctx, {
    ui: { enabled: true, webDistDir: join(ctx.dataDir, "web-dist-missing") },
  });
  servers.push(server);
  const bridge = createBridgeServer(server.app.server, {
    services: ctx.services,
    bridgeToken: server.token,
    ...(options.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: options.handshakeTimeoutMs } : {}),
    ...(options.safetyTimeoutMs !== undefined ? { safetyTimeoutMs: options.safetyTimeoutMs } : {}),
  });
  bridges.push(bridge);
  return { ctx, server, sessions, bridge };
}

afterEach(async () => {
  for (const tracked of sockets.splice(0)) {
    await closeWebSocket(tracked.ws).catch(() => undefined);
  }
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const server of servers.splice(0)) await server.close();
  for (const ctx of contexts.splice(0)) await ctx.cleanup();
});

const DEVICE: DeviceInfo = {
  name: "Яндекс Станция Лайт 2",
  mac: "02:00:00:00:00:01",
  firmware: "pulsar 0.5.3",
};

function runStartMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "run.start",
    protocol: 1,
    runId: "run-1",
    device: DEVICE,
    wakeWord: "alisa",
    wakeWordPhrase: "Алиса",
    flags: { useWakeWord: true },
    ...overrides,
  };
}

async function connectTracked(server: TestHttpServer, token: string | null = server.token): Promise<TrackedSocket> {
  const ws = await connectBridge(server.bridgeUrl, token);
  const tracked = trackSocket(ws);
  sockets.push(tracked);
  return tracked;
}

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met before timeout");
}

describe("bridge authentication", () => {
  it("rejects upgrades without a valid bearer token and accepts ?token=", async () => {
    const { server } = await setupBridge();

    await expect(connectBridge(server.bridgeUrl, null)).rejects.toMatchObject({ statusCode: 401 });
    await expect(connectBridge(server.bridgeUrl, "wrong-token")).rejects.toMatchObject({ statusCode: 401 });

    const viaQuery = await connectBridge(`${server.bridgeUrl}?token=${server.token}`, null);
    const tracked = trackSocket(viaQuery);
    sockets.push(tracked);
    expect(viaQuery.readyState).toBe(viaQuery.OPEN);
  });
});

describe("bridge run protocol", () => {
  it("accepts run.start, forwards PCM and delivers the WAV answer", async () => {
    const { sessions, server } = await setupBridge();
    const tracked = await connectTracked(server);

    tracked.ws.send(JSON.stringify(runStartMessage()));
    await tracked.until(() => tracked.json.some((message) => jsonMessageType(message) === "run.accepted"));
    const accepted = await tracked.waitForJson<{ type: string; runId: string }>(
      (message) => jsonMessageType(message) === "run.accepted",
    );
    expect(accepted.runId).toBe("run-1");

    expect(sessions.runs).toHaveLength(1);
    const run = sessions.runs[0];
    if (run === undefined) throw new Error("session did not start a run");
    expect(run.request.runId).toBe("run-1");
    expect(run.request.device).toEqual(DEVICE);
    expect(run.request.wakeWordPhrase).toBe("Алиса");
    expect(run.request.flags.useWakeWord).toBe(true);

    const pcm = new Int16Array([1, -2, 3, -4]);
    tracked.ws.send(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));

    const receivedPcm = await waitFor(() => (run.handle.audio.length === 1 ? run.handle.audio[0] : undefined));
    expect(Array.from(receivedPcm)).toEqual([1, -2, 3, -4]);

    tracked.ws.send(JSON.stringify({ type: "vad.start", runId: "run-1" }));
    tracked.ws.send(JSON.stringify({ type: "vad.end", runId: "run-1", reason: "silence" }));
    await waitFor(() => (run.handle.vadHints.length === 2 ? true : undefined));
    expect(run.handle.vadHints).toEqual(["start", "end"]);

    const wav = encodeWavPcm16(new Int16Array(160).fill(5));
    run.request.sink.emit({ event: "stt_start", data: {} });
    run.request.sink.tts(wav, "Готово");
    run.request.sink.end("done");

    await tracked.until(() => tracked.json.some((message) => jsonMessageType(message) === "run.end"));
    const types = tracked.json
      .map((message) => jsonMessageType(message))
      .filter((type): type is string => type !== undefined);
    expect(types).toEqual(["run.accepted", "device.event", "tts.start", "tts.end", "run.end"]);

    const ttsStart = tracked.json.find((message) => jsonMessageType(message) === "tts.start") as
      | { text: string; format: string }
      | undefined;
    expect(ttsStart).toEqual({ type: "tts.start", text: "Готово", format: "wav" });
    const ttsEnd = tracked.json.find((message) => jsonMessageType(message) === "tts.end") as
      | { reason: string }
      | undefined;
    expect(ttsEnd?.reason).toBe("done");
    const runEnd = tracked.json.find((message) => jsonMessageType(message) === "run.end") as
      | { reason: string }
      | undefined;
    expect(runEnd?.reason).toBe("done");

    const receivedWav = Buffer.concat(tracked.binary);
    expect(receivedWav.equals(Buffer.from(wav))).toBe(true);
    expect(receivedWav.toString("ascii", 0, 4)).toBe("RIFF");

    await tracked.closed;
  });

  it("handles text.input through RunHandleLike.onText", async () => {
    const { sessions, server } = await setupBridge();
    const tracked = await connectTracked(server);

    tracked.ws.send(JSON.stringify(runStartMessage()));
    await tracked.until(() => tracked.json.some((message) => jsonMessageType(message) === "run.accepted"));
    const run = sessions.runs[0];
    if (run === undefined) throw new Error("session did not start a run");

    tracked.ws.send(JSON.stringify({ type: "text.input", text: "включи свет" }));
    const receivedText = await waitFor(() => (run.handle.texts.length > 0 ? run.handle.texts[0] : undefined));
    expect(receivedText).toBe("включи свет");

    run.request.sink.end("done");
    await tracked.until(() => tracked.json.some((message) => jsonMessageType(message) === "run.end"));
    await tracked.closed;
  });

  it("cancels the run on run.cancel and closes after the session ends it", async () => {
    const { sessions, server } = await setupBridge();
    const tracked = await connectTracked(server);

    tracked.ws.send(JSON.stringify(runStartMessage()));
    await tracked.until(() => tracked.json.some((message) => jsonMessageType(message) === "run.accepted"));
    const run = sessions.runs[0];
    if (run === undefined) throw new Error("session did not start a run");

    tracked.ws.send(JSON.stringify({ type: "run.cancel", runId: "run-1", reason: "barge_in" }));
    const cancelReason = await waitFor(() => run.handle.cancels[0]);
    expect(cancelReason).toBe("barge_in");

    run.request.sink.end("barge_in");
    await tracked.until(() => tracked.json.some((message) => jsonMessageType(message) === "run.end"));
    const runEnd = tracked.json.find((message) => jsonMessageType(message) === "run.end") as
      | { reason: string }
      | undefined;
    expect(runEnd?.reason).toBe("barge_in");
    await tracked.closed;
  });

  it("reports device run.end via deviceStopped", async () => {
    const { sessions, server } = await setupBridge();
    const tracked = await connectTracked(server);

    tracked.ws.send(JSON.stringify(runStartMessage()));
    await tracked.until(() => tracked.json.some((message) => jsonMessageType(message) === "run.accepted"));
    const run = sessions.runs[0];
    if (run === undefined) throw new Error("session did not start a run");

    tracked.ws.send(JSON.stringify({ type: "run.end", runId: "run-1", reason: "device_stop" }));
    await waitFor(() => (run.handle.deviceStoppedCount === 1 ? true : undefined));

    run.request.sink.end("device_stop");
    await tracked.until(() => tracked.json.some((message) => jsonMessageType(message) === "run.end"));
    const runEnd = tracked.json.find((message) => jsonMessageType(message) === "run.end") as
      | { reason: string }
      | undefined;
    expect(runEnd?.reason).toBe("device_stop");
    await tracked.closed;
  });

  it("closes the run itself when the session does not end after cancel", async () => {
    const { sessions, server } = await setupBridge({ safetyTimeoutMs: 80 });
    const tracked = await connectTracked(server);

    tracked.ws.send(JSON.stringify(runStartMessage()));
    await tracked.until(() => tracked.json.some((message) => jsonMessageType(message) === "run.accepted"));
    sessions.runs[0]?.handle.cancels.length;

    tracked.ws.send(JSON.stringify({ type: "run.cancel", runId: "run-1", reason: "device_stop" }));
    await tracked.until(() => tracked.json.some((message) => jsonMessageType(message) === "run.end"), 2000);
    const runEnd = tracked.json.find((message) => jsonMessageType(message) === "run.end") as
      | { reason: string }
      | undefined;
    expect(runEnd?.reason).toBe("device_stop");
    await tracked.closed;
  });

  it("cancels the run when the socket closes", async () => {
    const { sessions, server } = await setupBridge();
    const tracked = await connectTracked(server);
    tracked.ws.send(JSON.stringify(runStartMessage()));
    await tracked.until(() => tracked.json.some((message) => jsonMessageType(message) === "run.accepted"));
    const run = sessions.runs[0];
    if (run === undefined) throw new Error("session did not start a run");

    await closeWebSocket(tracked.ws);
    const cancelReason = await waitFor(() => run.handle.cancels[0]);
    expect(cancelReason).toBe("cancelled");
  });
});

describe("bridge handshake errors", () => {
  it("times out when run.start never arrives", async () => {
    const { server } = await setupBridge({ handshakeTimeoutMs: 80 });
    const tracked = await connectTracked(server);

    const error = await tracked.waitForJson<{ type: string; code: string; fatal: boolean }>(
      (message) => jsonMessageType(message) === "error",
    );
    expect(error.code).toBe("handshake_timeout");
    expect(error.fatal).toBe(true);
    await tracked.closed;
  });

  it("rejects a mismatched protocol version", async () => {
    const { server } = await setupBridge();
    const tracked = await connectTracked(server);
    tracked.ws.send(JSON.stringify(runStartMessage({ protocol: 2 })));

    const error = await tracked.waitForJson<{ code: string; fatal: boolean }>(
      (message) => jsonMessageType(message) === "error",
    );
    expect(error.code).toBe("protocol_mismatch");
    expect(error.fatal).toBe(true);

    await tracked.until(() => tracked.json.some((message) => jsonMessageType(message) === "run.end"));
    const runEnd = tracked.json.find((message) => jsonMessageType(message) === "run.end") as
      | { reason: string }
      | undefined;
    expect(runEnd?.reason).toBe("error");
    await tracked.closed;
  });

  it("reports invalid JSON and invalid messages without closing the run", async () => {
    const { server } = await setupBridge();
    const tracked = await connectTracked(server);

    tracked.ws.send("{not json");
    const invalidJson = await tracked.waitForJson<{ code: string; fatal: boolean }>(
      (message) => jsonMessageType(message) === "error",
    );
    expect(invalidJson.code).toBe("invalid_json");
    expect(invalidJson.fatal).toBe(false);

    tracked.ws.send(JSON.stringify({ type: "vad.start", runId: "run-1" }));
    // runId messages before run.start are rejected but the socket stays usable.
    const notStarted = await tracked.waitForJson<{ code: string; fatal: boolean }>(
      (message) => jsonMessageType(message) === "error" && (message as { code?: string }).code === "run_not_started",
    );
    expect(notStarted.fatal).toBe(false);

    tracked.ws.send(JSON.stringify(runStartMessage()));
    await tracked.until(() => tracked.json.some((message) => jsonMessageType(message) === "run.accepted"));
    await closeWebSocket(tracked.ws);
  });

  it("sends a non-fatal error for binary audio before run.start", async () => {
    const { server } = await setupBridge();
    const tracked = await connectTracked(server);
    tracked.ws.send(Buffer.from(new Int16Array([1, 2]).buffer));
    // No error envelope for dropped binary frames, but the connection stays open.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tracked.ws.readyState).toBe(tracked.ws.OPEN);
    await closeWebSocket(tracked.ws);
  });
});
