import { afterEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SYSTEM_PROMPT } from "../src/config/schema.js";
import {
  FakeSessions,
  apiRequest,
  createTestContext,
  encodeWavPcm16,
  makeSessionRecord,
  startTestHttpServer,
  type TestContext,
  type TestHttpServer,
} from "./core-helpers.js";

const contexts: TestContext[] = [];
const servers: TestHttpServer[] = [];

interface SetupOptions {
  sessions?: FakeSessions;
  schedulerRunNow?: boolean;
}

async function setup(options: SetupOptions = {}): Promise<{ ctx: TestContext; server: TestHttpServer }> {
  const sessions = options.sessions ?? new FakeSessions([makeSessionRecord()]);
  const ctx = await createTestContext({
    sessions,
    schedulerRunNow: options.schedulerRunNow ?? true,
  });
  contexts.push(ctx);
  const server = await startTestHttpServer(ctx, {
    ui: { enabled: true, webDistDir: join(ctx.dataDir, "web-dist-missing") },
  });
  servers.push(server);
  return { ctx, server };
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const ctx of contexts.splice(0)) await ctx.cleanup();
});

async function jsonBody<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function readStreamUntil(
  stream: ReadableStream<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (predicate(text)) return text;
    }
  } finally {
    await reader.cancel();
  }
  throw new Error(`stream condition not met; received: ${text}`);
}

describe("health and auth", () => {
  it("serves /health without auth and guards /api/* with Bearer", async () => {
    const { server } = await setup();

    const health = await apiRequest(server, "/health", { token: null });
    expect(health.status).toBe(200);
    const healthBody = await jsonBody<{ status: string; version: string; uptimeSec: number }>(health);
    expect(healthBody.status).toBe("ok");
    expect(healthBody.version).toBe("0.1.0-test");
    expect(typeof healthBody.uptimeSec).toBe("number");

    const anonymous = await apiRequest(server, "/api/config", { token: null });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("Bearer");
    const anonymousBody = await jsonBody<{ error: { code: string; message: string } }>(anonymous);
    expect(anonymousBody.error.code).toBe("unauthorized");

    const wrongToken = await apiRequest(server, "/api/config", { token: "wrong-token" });
    expect(wrongToken.status).toBe(401);

    const withBridgeToken = await apiRequest(server, "/api/config");
    expect(withBridgeToken.status).toBe(200);

    const ingress = await apiRequest(server, "/api/config", {
      token: null,
      headers: { "x-ingress-path": "/api/hassio_ingress/abc" },
    });
    expect(ingress.status).toBe(200);
  });

  it("returns the JSON error envelope for unknown API routes", async () => {
    const { server } = await setup();
    const response = await apiRequest(server, "/api/does-not-exist");
    expect(response.status).toBe(404);
    const body = await jsonBody<{ error: { code: string } }>(response);
    expect(body.error.code).toBe("not_found");

    const anonymous = await apiRequest(server, "/api/does-not-exist", { token: null });
    expect(anonymous.status).toBe(401);
  });
});

describe("config and prompt routes", () => {
  it("returns masked config with warnings and bridge token", async () => {
    const { ctx, server } = await setup();
    const response = await apiRequest(server, "/api/config");
    expect(response.status).toBe(200);
    const body = await jsonBody<{
      config: { provider: { openai: { apiKey: string } }; tools: { ha: { token: string } } };
      warnings: string[];
      bridgeToken: string;
    }>(response);
    expect(body.bridgeToken).toBe(ctx.store.bridgeToken());
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.config.provider.openai.apiKey).toBe("");
    expect(body.config.tools.ha.token).toBe("");
  });

  it("applies partial config updates, masks secrets and validates input", async () => {
    const { ctx, server } = await setup();

    const updated = await apiRequest(server, "/api/config", {
      method: "PUT",
      body: { provider: { openai: { temperature: 0.2, apiKey: "sk-http-secret" } } },
    });
    expect(updated.status).toBe(200);
    const body = await jsonBody<{ config: { provider: { openai: { temperature: number; apiKey: string } } } }>(
      updated,
    );
    expect(body.config.provider.openai.temperature).toBe(0.2);
    expect(body.config.provider.openai.apiKey).toBe("***");
    expect(ctx.store.get().provider.openai.temperature).toBe(0.2);
    expect(ctx.store.get().provider.openai.apiKey).toBe("sk-http-secret");

    const maskedSave = await apiRequest(server, "/api/config", {
      method: "PUT",
      body: { provider: { openai: { apiKey: "***" } } },
    });
    expect(maskedSave.status).toBe(200);
    expect(ctx.store.get().provider.openai.apiKey).toBe("sk-http-secret");

    const invalid = await apiRequest(server, "/api/config", {
      method: "PUT",
      body: { logLevel: "verbose" },
    });
    expect(invalid.status).toBe(400);
    const invalidBody = await jsonBody<{ error: { code: string } }>(invalid);
    expect(invalidBody.error.code).toBe("validation_error");

    const notObject = await apiRequest(server, "/api/config", { method: "PUT", body: "string-body" });
    expect(notObject.status).toBe(400);
    expect((await jsonBody<{ error: { code: string } }>(notObject)).error.code).toBe("invalid_body");
  });

  it("refreshes MCP tools when the mcp config section changes", async () => {
    const { ctx, server } = await setup();
    const before = ctx.calls.mcpRefresh;
    const serverConfig = {
      id: "files",
      name: "Files",
      enabled: true,
      transport: "stdio",
      command: "npx",
      args: ["-y", "files"],
      url: "",
      headers: {},
      toolTimeoutSec: 15,
    };
    const response = await apiRequest(server, "/api/config", {
      method: "PUT",
      body: { tools: { mcp: { servers: [serverConfig] } } },
    });
    expect(response.status).toBe(200);
    expect(ctx.calls.mcpRefresh).toBe(before + 1);
    expect(ctx.store.get().tools.mcp.servers[0]?.id).toBe("files");
  });

  it("reads and updates the system prompt with defaults", async () => {
    const { server } = await setup();
    const prompt = await jsonBody<{
      system: string;
      language: string;
      defaults: { system: string; language: string };
    }>(await apiRequest(server, "/api/prompt"));
    expect(prompt.system).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(prompt.defaults.system).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(prompt.language).toBe("ru");

    const updated = await apiRequest(server, "/api/prompt", {
      method: "PUT",
      body: { system: "Отвечай очень кратко." },
    });
    expect(updated.status).toBe(200);
    expect((await jsonBody<{ system: string }>(updated)).system).toBe("Отвечай очень кратко.");

    const defaults = await jsonBody<{ system: string }>(await apiRequest(server, "/api/prompt/defaults"));
    expect(defaults.system).toBe(DEFAULT_SYSTEM_PROMPT);

    const invalid = await apiRequest(server, "/api/prompt", { method: "PUT", body: { language: "" } });
    expect(invalid.status).toBe(400);
  });
});

describe("status, providers and tts routes", () => {
  it("returns status, provider registry, health and models", async () => {
    const { server } = await setup();
    const status = await apiRequest(server, "/api/status");
    expect(status.status).toBe(200);
    expect((await jsonBody<{ version: string }>(status)).version).toBe("0.1.0-test");

    const providersBody = await jsonBody<{
      providers: Array<{ id: string; capabilities: { tools: boolean } }>;
    }>(await apiRequest(server, "/api/providers"));
    expect(providersBody.providers.map((provider) => provider.id)).toEqual(["mock", "openai"]);
    expect(providersBody.providers[1]?.capabilities.tools).toBe(true);

    const tested = await apiRequest(server, "/api/providers/mock/test", { method: "POST" });
    expect(tested.status).toBe(200);
    expect(await jsonBody<{ ok: boolean }>(tested)).toMatchObject({ ok: true });

    const models = await apiRequest(server, "/api/providers/openai/models");
    expect(await jsonBody<{ models: string[] }>(models)).toEqual({ models: ["gpt-4o-mini", "gpt-4o"] });

    const unknown = await apiRequest(server, "/api/providers/nope/test", { method: "POST" });
    expect(unknown.status).toBe(404);
    expect((await jsonBody<{ error: { code: string } }>(unknown)).error.code).toBe("provider_not_found");
  });

  it("lists voices and renders a WAV preview with the requested voice", async () => {
    const { ctx, server } = await setup();
    const voices = await jsonBody<{ voices: Array<{ id: string }> }>(
      await apiRequest(server, "/api/tts/voices"),
    );
    expect(voices.voices[0]?.id).toBe("ru_RU-irina-medium");

    const preview = await apiRequest(server, "/api/tts/preview", {
      method: "POST",
      body: { text: "Привет", voice: "ru_RU-irina-medium" },
    });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toContain("audio/wav");
    const bytes = Buffer.from(await preview.arrayBuffer());
    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
    expect(bytes.length).toBe(44 + 320 * 2);
    expect(ctx.calls.ttsSynthesize[0]).toMatchObject({ text: "Привет", voice: "ru_RU-irina-medium" });

    const noVoice = await apiRequest(server, "/api/tts/preview", {
      method: "POST",
      body: { text: "Без голоса" },
    });
    expect(noVoice.status).toBe(200);
    const lastCall = ctx.calls.ttsSynthesize.at(-1);
    expect(lastCall?.text).toBe("Без голоса");
    expect(lastCall !== undefined && Object.hasOwn(lastCall, "voice")).toBe(false);
  });
});

describe("test console routes", () => {
  it("answers text through the brain and reports timings", async () => {
    const { ctx, server } = await setup();
    const response = await apiRequest(server, "/api/test/text", {
      method: "POST",
      body: { text: "включи свет" },
    });
    expect(response.status).toBe(200);
    const body = await jsonBody<{
      text: string;
      speech: string;
      toolTraces: Array<{ call: { name: string } }>;
      timings: { llmMs: number; totalMs: number };
      provider: string;
    }>(response);
    expect(body.text).toBe("Готово");
    expect(body.speech).toBe("Готово");
    expect(body.toolTraces[0]?.call.name).toBe("ha.call_service");
    expect(body.timings.llmMs).toBe(2);
    expect(body.provider).toBe("mock");
    expect(ctx.calls.brainRequests).toHaveLength(1);
    expect(ctx.calls.brainNewConversation).toBe(1);

    const keepHistory = await apiRequest(server, "/api/test/text", {
      method: "POST",
      body: { text: "а теперь выключи", keepHistory: true },
    });
    expect(keepHistory.status).toBe(200);
    expect(ctx.calls.brainNewConversation).toBe(1);
  });

  it("returns provider errors as a 502 envelope", async () => {
    const ctx = await createTestContext({ brainReply: { finish: "error", text: "" } });
    contexts.push(ctx);
    const server = await startTestHttpServer(ctx, {
      ui: { enabled: true, webDistDir: join(ctx.dataDir, "web-dist-missing") },
    });
    servers.push(server);

    const response = await apiRequest(server, "/api/test/text", {
      method: "POST",
      body: { text: "вопрос" },
    });
    expect(response.status).toBe(502);
    expect((await jsonBody<{ error: { code: string } }>(response)).error.code).toBe("provider_error");
  });

  it("transcribes an uploaded WAV through STT and answers", async () => {
    const { ctx, server } = await setup();
    const wav = encodeWavPcm16(new Int16Array(3200).fill(7));
    const form = new FormData();
    form.append("audio", new Blob([wav], { type: "audio/wav" }), "speech.wav");
    const response = await apiRequest(server, "/api/test/audio", { method: "POST", body: form });
    expect(response.status).toBe(200);
    const body = await jsonBody<{
      transcript: string;
      text: string;
      speech: string;
      toolTraces: unknown[];
      timings: { sttMs: number; llmMs: number; totalMs: number };
      provider: string;
    }>(response);
    expect(body.transcript).toBe("включи свет");
    expect(body.text).toBe("Готово");
    expect(body.toolTraces).toHaveLength(1);
    expect(body.provider).toBe("mock");
    expect(ctx.calls.sttTranscribe[0]).toMatchObject({
      format: { sampleRate: 16000, channels: 1, width: 2 },
      samples: 3200,
    });
    expect(ctx.calls.brainRequests[0]?.text).toBe("включи свет");
  });

  it("rejects non-WAV and non-multipart audio payloads", async () => {
    const { server } = await setup();
    const form = new FormData();
    form.append("audio", new Blob(["not a wav"], { type: "application/octet-stream" }), "bad.bin");
    const invalid = await apiRequest(server, "/api/test/audio", { method: "POST", body: form });
    expect(invalid.status).toBe(400);
    expect((await jsonBody<{ error: { code: string } }>(invalid)).error.code).toBe("invalid_wav");

    const jsonRequest = await apiRequest(server, "/api/test/audio", {
      method: "POST",
      body: { audio: "x" },
    });
    expect(jsonRequest.status).toBe(415);
  });
});

describe("sessions and logs routes", () => {
  it("lists sessions with a limit and returns session details", async () => {
    const sessions = new FakeSessions([makeSessionRecord(), makeSessionRecord({ id: "run-2" })]);
    const { server } = await setup({ sessions });

    const list = await jsonBody<{ sessions: Array<{ id: string }> }>(
      await apiRequest(server, "/api/sessions?limit=1"),
    );
    expect(list.sessions).toHaveLength(1);

    const detail = await jsonBody<{ id: string; transcript: string; toolCalls: unknown[] }>(
      await apiRequest(server, "/api/sessions/run-2"),
    );
    expect(detail.id).toBe("run-2");
    expect(detail.transcript).toBe("включи свет");
    expect(detail.toolCalls).toHaveLength(1);

    const missing = await apiRequest(server, "/api/sessions/unknown");
    expect(missing.status).toBe(404);
    expect((await jsonBody<{ error: { code: string } }>(missing)).error.code).toBe("session_not_found");

    const invalidLimit = await apiRequest(server, "/api/sessions?limit=abc");
    expect(invalidLimit.status).toBe(400);
  });

  it("serves the in-memory log ring and an SSE stream", async () => {
    const { ctx, server } = await setup();
    // Server setup logs its own startup entry; start from the current tail.
    const baseline = await jsonBody<{ nextSeq: number }>(await apiRequest(server, "/api/logs?after=0"));
    ctx.logger.info("first");
    ctx.logger.warn("second", { token: "should-be-masked" });

    const logs = await jsonBody<{ entries: Array<{ seq: number; msg: string; data?: { token: string } }>; nextSeq: number }>(
      await apiRequest(server, `/api/logs?after=${baseline.nextSeq}`),
    );
    const named = logs.entries.filter((entry) => entry.msg === "first" || entry.msg === "second");
    expect(named.map((entry) => entry.msg)).toEqual(["first", "second"]);
    expect(named[1]?.data?.token).toBe("***");
    expect(logs.nextSeq).toBe(logs.entries.at(-1)?.seq);

    const secondSeq = named[1]?.seq ?? 0;
    const page = await jsonBody<{ entries: Array<{ msg: string }> }>(
      await apiRequest(server, `/api/logs?after=${secondSeq - 1}`),
    );
    expect(page.entries.filter((entry) => entry.msg === "second")).toHaveLength(1);
    expect(page.entries.some((entry) => entry.msg === "first")).toBe(false);

    const response = await fetch(`${server.baseUrl}/api/logs/stream?after=0&token=${server.token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    if (response.body === null) throw new Error("SSE response has no body");
    const streamText = await readStreamUntil(response.body, (text) => text.includes('"msg":"second"'));
    expect(streamText).toContain("data:");

    ctx.logger.info("live-entry");
    // The stream reader is closed by readStreamUntil, so open a second stream for the live part.
    const live = await fetch(`${server.baseUrl}/api/logs/stream?after=${logs.nextSeq}&token=${server.token}`);
    if (live.body === null) throw new Error("SSE response has no body");
    const liveText = await readStreamUntil(live.body, (text) => text.includes("live-entry"));
    expect(liveText).toContain("live-entry");

    const unauthorized = await fetch(`${server.baseUrl}/api/logs/stream`);
    expect(unauthorized.status).toBe(401);
    expect((await jsonBody<{ error: { code: string } }>(unauthorized)).error.code).toBe("unauthorized");
  });
});

describe("mcp routes", () => {
  it("creates, masks, updates, tests and deletes MCP servers", async () => {
    const { ctx, server } = await setup();
    expect(ctx.calls.mcpRefresh).toBe(0);

    const created = await apiRequest(server, "/api/mcp/servers", {
      method: "POST",
      body: {
        id: "files",
        name: "Files",
        transport: "stdio",
        command: "npx",
        args: ["-y", "files-server"],
        headers: { Authorization: "Bearer secret-header" },
      },
    });
    expect(created.status).toBe(201);
    const createdBody = await jsonBody<{ id: string; headers: Record<string, string>; enabled: boolean }>(created);
    expect(createdBody.id).toBe("files");
    expect(createdBody.headers.Authorization).toBe("***");
    expect(createdBody.enabled).toBe(true);
    expect(ctx.calls.mcpRefresh).toBe(1);

    const list = await jsonBody<{ servers: Array<{ id: string; headers: Record<string, string> }> }>(
      await apiRequest(server, "/api/mcp/servers"),
    );
    expect(list.servers.map((candidate) => candidate.id)).toEqual(["files"]);

    const duplicate = await apiRequest(server, "/api/mcp/servers", {
      method: "POST",
      body: { id: "files", name: "Copy", transport: "stdio", command: "npx" },
    });
    expect(duplicate.status).toBe(409);

    const badId = await apiRequest(server, "/api/mcp/servers", {
      method: "POST",
      body: { id: "bad id!", name: "Bad", transport: "stdio", command: "npx" },
    });
    expect(badId.status).toBe(400);

    const badTransport = await apiRequest(server, "/api/mcp/servers", {
      method: "POST",
      body: { id: "remote", name: "Remote", transport: "http" },
    });
    expect(badTransport.status).toBe(400);
    expect((await jsonBody<{ error: { code: string } }>(badTransport)).error.code).toBe("invalid_mcp_server");

    const updated = await apiRequest(server, "/api/mcp/servers/files", {
      method: "PUT",
      body: { name: "Files 2", headers: { Authorization: "***" } },
    });
    expect(updated.status).toBe(200);
    expect(await jsonBody<{ name: string }>(updated)).toMatchObject({ name: "Files 2" });
    expect(ctx.store.get().tools.mcp.servers[0]?.headers.Authorization).toBe("Bearer secret-header");

    const tested = await apiRequest(server, "/api/mcp/servers/files/test", { method: "POST" });
    expect(tested.status).toBe(200);
    expect(await jsonBody<{ ok: boolean }>(tested)).toMatchObject({ ok: true });
    expect(ctx.calls.mcpTest).toHaveLength(1);

    const tools = await jsonBody<{ tools: unknown[] }>(await apiRequest(server, "/api/mcp/tools"));
    expect(tools.tools).toEqual([]);

    const removed = await apiRequest(server, "/api/mcp/servers/files", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(await jsonBody<{ deleted: boolean }>(removed)).toMatchObject({ deleted: true });
    expect(ctx.store.get().tools.mcp.servers).toEqual([]);
  });
});

describe("scheduler routes", () => {
  const action = { kind: "ha.call_service", request: { domain: "light", service: "turn_on" } };

  it("creates, lists, replaces, cancels and runs schedules", async () => {
    const { ctx, server } = await setup({ schedulerRunNow: true });

    const created = await apiRequest(server, "/api/schedules", {
      method: "POST",
      body: { inSec: 120, label: "Свет", action, runId: "run-1" },
    });
    expect(created.status).toBe(201);
    const createdBody = await jsonBody<{ id: string; at: number; label: string }>(created);
    expect(createdBody.id).toBe("sched-1");
    expect(createdBody.at).toBeGreaterThan(Date.now());
    expect(ctx.calls.schedulerAdd[0]?.action.kind).toBe("ha.call_service");

    const list = await jsonBody<{ entries: Array<{ id: string; runId?: string }>; nextAt: number | null }>(
      await apiRequest(server, "/api/schedules"),
    );
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]?.runId).toBe("run-1");
    expect(list.nextAt).toBe(createdBody.at);

    const replaced = await apiRequest(server, "/api/schedules/sched-1", {
      method: "PUT",
      body: { label: "Свет вечером", inSec: 60 },
    });
    expect(replaced.status).toBe(200);
    const replacedBody = await jsonBody<{ id: string; label: string }>(replaced);
    expect(replacedBody.label).toBe("Свет вечером");
    expect(replacedBody.id).not.toBe("sched-1");
    expect(ctx.calls.schedulerCancel).toContain("sched-1");

    const ran = await apiRequest(server, `/api/schedules/${replacedBody.id}/run-now`, { method: "POST" });
    expect(ran.status).toBe(200);
    expect(await jsonBody<{ ok: boolean }>(ran)).toMatchObject({ ok: true });
    expect(ctx.calls.schedulerRunNow).toContain(replacedBody.id);

    const cancelled = await apiRequest(server, `/api/schedules/${replacedBody.id}/cancel`, { method: "POST" });
    expect(cancelled.status).toBe(200);
    expect(await jsonBody<{ cancelled: number }>(cancelled)).toEqual({ cancelled: 1 });

    const missing = await apiRequest(server, "/api/schedules/unknown/cancel", { method: "POST" });
    expect(missing.status).toBe(404);
  });

  it("validates schedule input and run-now support", async () => {
    const { server } = await setup({ schedulerRunNow: false });
    const past = await apiRequest(server, "/api/schedules", {
      method: "POST",
      body: { at: Date.now() - 60_000, label: "Прошлое", action },
    });
    expect(past.status).toBe(400);
    expect((await jsonBody<{ error: { code: string } }>(past)).error.code).toBe("invalid_schedule_time");

    const invalidAction = await apiRequest(server, "/api/schedules", {
      method: "POST",
      body: { inSec: 60, label: "Плохое", action: { kind: "unknown" } },
    });
    expect(invalidAction.status).toBe(400);

    const created = await apiRequest(server, "/api/schedules", {
      method: "POST",
      body: { inSec: 60, label: "Без runNow", action },
    });
    expect(created.status).toBe(201);
    const id = (await jsonBody<{ id: string }>(created)).id;
    const runNow = await apiRequest(server, `/api/schedules/${id}/run-now`, { method: "POST" });
    expect(runNow.status).toBe(409);
    expect((await jsonBody<{ error: { code: string } }>(runNow)).error.code).toBe("run_now_unsupported");
  });

  it("refuses new schedules when the scheduler is disabled", async () => {
    const { ctx, server } = await setup();
    await ctx.store.update({ tools: { scheduler: { enabled: false } } });
    const response = await apiRequest(server, "/api/schedules", {
      method: "POST",
      body: { inSec: 60, label: "Свет", action },
    });
    expect(response.status).toBe(409);
    expect((await jsonBody<{ error: { code: string } }>(response)).error.code).toBe("scheduler_disabled");
  });
});

describe("ha routes", () => {
  it("lists entities with filters and areas", async () => {
    const { ctx, server } = await setup();
    const entities = await jsonBody<{
      entities: Array<{ entity_id: string; area_id?: string }>;
      areas: Array<{ area_id: string }>;
    }>(await apiRequest(server, "/api/ha/entities?domain=light&q=свет"));
    expect(entities.entities.map((entity) => entity.entity_id)).toEqual(["light.kitchen"]);
    expect(entities.entities[0]?.area_id).toBe("kitchen");
    expect(entities.areas[0]?.area_id).toBe("kitchen");
    expect(ctx.calls.haListEntities[0]).toEqual({ domain: "light", query: "свет" });

    const areas = await jsonBody<{ areas: Array<{ name: string }> }>(
      await apiRequest(server, "/api/ha/areas"),
    );
    expect(areas.areas[0]?.name).toBe("Кухня");
  });
});

describe("ui static", () => {
  it("answers / with an explicit not-built page when web/dist is missing", async () => {
    const { server } = await setup();
    const root = await fetch(`${server.baseUrl}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(await root.text()).toContain("UI не собран");

    const deepLink = await fetch(`${server.baseUrl}/sessions`);
    expect(deepLink.status).toBe(404);
  });

  it("serves the built SPA with client-side routing fallback", async () => {
    const ctx = await createTestContext();
    contexts.push(ctx);
    const distDir = join(ctx.dataDir, "web-dist");
    await mkdir(join(distDir, "assets"), { recursive: true });
    await writeFile(join(distDir, "index.html"), "<html><body>PULSAR SPA</body></html>");
    await writeFile(join(distDir, "assets", "app.js"), "console.log('spa');");
    const server = await startTestHttpServer(ctx, { ui: { enabled: true, webDistDir: distDir } });
    servers.push(server);

    const root = await fetch(`${server.baseUrl}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("PULSAR SPA");

    const asset = await fetch(`${server.baseUrl}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("spa");

    const deepLink = await fetch(`${server.baseUrl}/logs`);
    expect(deepLink.status).toBe(200);
    expect(await deepLink.text()).toContain("PULSAR SPA");
    expect(deepLink.headers.get("cache-control")).toContain("no-cache");
  });

  it("can be disabled for API-only deployments", async () => {
    const ctx = await createTestContext();
    contexts.push(ctx);
    const server = await startTestHttpServer(ctx, { ui: { enabled: false } });
    servers.push(server);

    const root = await fetch(`${server.baseUrl}/`);
    expect(root.status).toBe(404);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(await root.text()).toContain("Страница не найдена");
    expect((await apiRequest(server, "/health", { token: null })).status).toBe(200);
  });
});

