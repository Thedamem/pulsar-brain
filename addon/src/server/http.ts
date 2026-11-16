/**
 * HTTP API for the addon (docs/contracts.md §4) on Fastify 5.
 *
 * Responsibilities: Bearer/ingress auth for /api/*, zod validation of every external
 * input, secret masking in responses, a uniform {"error":{code,message}} envelope,
 * logs ring buffer + SSE, a text/audio test console and the MCP/scheduler/HA admin routes.
 *
 * The WS bridge is registered separately (server/bridge.ts) on app.server.
 * The UI bundle and SPA fallback are wired here through server/ui-static.ts.
 */

import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { ZodError, z } from "zod";
import type {
  AppConfig,
  AppServices,
  HaArea,
  HaCallServiceRequest,
  HaEntity,
  HaServiceTarget,
  LogEntry,
  LoggerLike,
  LogLevel,
  McpServerConfig,
  PcmFormat,
  ProviderHealth,
  SchedulerAction,
} from "../shared/types.js";
import type {
  ConfigResponse,
  ErrorResponse,
  HaEntitiesResponse,
  HealthResponse,
  LogsResponse,
  McpServersResponse,
  McpToolsResponse,
  ModelsResponse,
  PromptResponse,
  ProviderInfoResponse,
  SchedulesResponse,
  SessionsResponse,
  StatusResponse,
  TestAudioResponse,
  TestTextResponse,
  VoicesResponse,
} from "../shared/protocol.js";
import type { ConfigPatch } from "../config/store.js";
import {
  DEFAULT_PROMPT,
  MCP_SERVER_ID_RE,
  McpServerConfigSchema,
} from "../config/schema.js";
import { isMasked, maskSecretRecord } from "../secrets/crypto.js";
import { bearerFromAuthorization, matchesAnyToken, tokenFromQuery } from "./auth.js";
import { registerUiStatic, type UiStatic } from "./ui-static.js";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const SSE_HEARTBEAT_MS = 15_000;
const SSE_REPLAY_LIMIT = 500;
const LOGS_DEFAULT_LIMIT = 200;
const LOGS_MAX_LIMIT = 2000;
const SESSIONS_DEFAULT_LIMIT = 50;
const SESSIONS_MAX_LIMIT = 200;
const MCP_REFRESH_NOTE = "MCP tools refresh failed; configuration was saved";

export interface HttpServerDeps {
  services: AppServices;
}

export interface HttpServerOptions {
  /** UI bearer token; defaults to PULSAR_BRAIN_UI_TOKEN. */
  uiToken?: string;
  /** Static UI wiring; enabled by default. */
  ui?: { enabled?: boolean; webDistDir?: string };
  /** Request body limit in bytes; defaults to 32 MB. */
  bodyLimitBytes?: number;
}

export async function createHttpServer(
  deps: HttpServerDeps,
  options: HttpServerOptions = {},
): Promise<FastifyInstance> {
  const { services } = deps;
  const log = services.log.child("http");
  const startedAt = Date.now();
  const bodyLimit = options.bodyLimitBytes ?? MAX_BODY_BYTES;
  const uiToken = (options.uiToken ?? process.env.PULSAR_BRAIN_UI_TOKEN ?? "").trim();
  const validTokens = [services.config.bridgeToken(), uiToken].filter((token) => token.length > 0);

  const app = Fastify({
    logger: false,
    bodyLimit,
    // SSE streams are hijacked and would otherwise keep app.close() waiting on shutdown.
    forceCloseConnections: true,
  });

  await app.register(multipart, {
    limits: { fileSize: bodyLimit, files: 1, fields: 20 },
  });

  app.addHook("onRequest", async (request, reply) => {
    const path = pathnameOf(request.raw.url);
    if (!path.startsWith("/api")) return;
    if (isAuthorized(request, validTokens)) return;
    log.warn("unauthorized request", { method: request.method, path });
    return reply
      .code(401)
      .header("WWW-Authenticate", 'Bearer realm="pulsar-brain"')
      .send(errorBody("unauthorized", "Требуется Bearer-токен доступа"));
  });

  app.addHook("onResponse", async (request, reply) => {
    log.debug("request completed", {
      method: request.method,
      path: pathnameOf(request.raw.url),
      status: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    });
  });

  // ───────────────────────────────────────────────────────────── health/status ──

  app.get("/health", async (): Promise<HealthResponse> => ({
    status: "ok",
    version: services.version,
    uptimeSec: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
  }));

  app.get("/api/status", async (): Promise<StatusResponse> => services.status());

  // ──────────────────────────────────────────────────────────────────── config ──

  app.get("/api/config", async (): Promise<ConfigResponse> => buildConfigResponse(services));

  app.put("/api/config", async (request): Promise<ConfigResponse> => {
    const patch = parseJsonObject(request.body, "config");
    await updateConfig(services, patch as unknown as ConfigPatch);
    return buildConfigResponse(services);
  });

  app.get("/api/providers", async (): Promise<ProviderInfoResponse> => ({
    providers: services.providers.list().map((provider) => ({
      id: provider.id,
      label: provider.label,
      capabilities: provider.capabilities,
    })),
  }));

  app.post("/api/providers/:id/test", async (request) => {
    const { id } = parseWith(ProviderParamsSchema, request.params, "Параметры запроса");
    const provider = findProvider(services, id);
    try {
      return await provider.health(services.config.get());
    } catch (err) {
      throw upstreamError(log, err, `Провайдер ${id} недоступен`);
    }
  });

  app.get("/api/providers/:id/models", async (request): Promise<ModelsResponse> => {
    const { id } = parseWith(ProviderParamsSchema, request.params, "Параметры запроса");
    const provider = findProvider(services, id);
    try {
      return { models: await provider.listModels(services.config.get()) };
    } catch (err) {
      throw upstreamError(log, err, `Не удалось получить модели провайдера ${id}`);
    }
  });

  // ──────────────────────────────────────────────────────────────────── prompt ──

  app.get("/api/prompt", async (): Promise<PromptResponse> => promptResponse(services));

  app.put("/api/prompt", async (request): Promise<PromptResponse> => {
    const patch = parseWith(PromptPatchSchema, request.body, "Тело запроса");
    await updateConfig(services, { prompt: patch });
    return promptResponse(services);
  });

  app.get("/api/prompt/defaults", async (): Promise<{ system: string; language: string }> => ({
    system: DEFAULT_PROMPT.system,
    language: DEFAULT_PROMPT.language,
  }));

  // ─────────────────────────────────────────────────────────────────────── tts ──

  app.get("/api/tts/voices", async (): Promise<VoicesResponse> => {
    try {
      return { voices: await services.tts.listVoices() };
    } catch (err) {
      throw upstreamError(log, err, "Не удалось получить список голосов");
    }
  });

  app.post("/api/tts/preview", async (request, reply) => {
    const body = parseWith(TtsPreviewRequestSchema, request.body, "Тело запроса");
    const config = services.config.get();
    const signal = AbortSignal.timeout(Math.max(config.conversation.requestTimeoutMs, 10_000));
    const format: PcmFormat = { sampleRate: config.tts.outputSampleRate, channels: 1, width: 2 };
    const chunks: Int16Array[] = [];
    try {
      const requestedVoice = body.voice ?? "";
      const voice = requestedVoice.trim().length > 0 ? requestedVoice.trim() : undefined;
      for await (const chunk of services.tts.synthesize(body.text, signal, voice)) chunks.push(chunk);
    } catch (err) {
      throw upstreamError(log, err, "Не удалось синтезировать речь");
    }
    if (chunks.length === 0) {
      throw new HttpError(502, "tts_empty", "Синтез речи вернул пустой результат");
    }
    const wav = services.encodeWav(concatPcm(chunks), format);
    return reply
      .type("audio/wav")
      .header("Content-Disposition", 'inline; filename="pulsar-preview.wav"')
      .send(Buffer.from(wav));
  });

  // ─────────────────────────────────────────────────────────────── test console ──

  app.post("/api/test/text", async (request): Promise<TestTextResponse> => {
    const body = parseWith(TestTextRequestSchema, request.body, "Тело запроса");
    const config = services.config.get();
    if (body.keepHistory !== true) services.brain.newConversation();
    const startedAtMs = Date.now();
    const reply = await respondToText(services, log, body.text, config);
    assertBrainFinish(reply.finish);
    return {
      text: reply.text,
      speech: reply.speech,
      toolTraces: reply.toolTraces,
      timings: { llmMs: reply.durationMs, totalMs: Date.now() - startedAtMs },
      provider: config.provider.id,
    };
  });

  app.post("/api/test/audio", async (request): Promise<TestAudioResponse> => {
    if (!request.isMultipart()) {
      throw new HttpError(415, "unsupported_media_type", "Ожидается multipart/form-data с WAV-файлом");
    }
    const file = await request.file();
    if (file === undefined) {
      throw new HttpError(400, "no_file", "В запросе нет файла: добавьте поле с WAV-аудио");
    }
    let audioBytes: Buffer;
    try {
      audioBytes = await file.toBuffer();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "FST_REQ_FILE_TOO_LARGE") {
        throw new HttpError(413, "payload_too_large", "Аудиофайл больше допустимых 32 МБ");
      }
      throw err;
    }
    const audio = decodeWavPcm16(audioBytes);

    const sttStartedAt = Date.now();
    let transcript: string;
    try {
      const result = await services.stt.transcribe(audio.format, audio.pcm);
      transcript = result.text.trim();
    } catch (err) {
      throw upstreamError(log, err, "Не удалось распознать речь");
    }
    const sttMs = Date.now() - sttStartedAt;
    if (transcript.length === 0) {
      throw new HttpError(422, "no_speech", "В аудио не распознана речь");
    }

    const config = services.config.get();
    services.brain.newConversation();
    const reply = await respondToText(services, log, transcript, config);
    assertBrainFinish(reply.finish);
    const totalMs = Date.now() - sttStartedAt;
    return {
      transcript,
      text: reply.text,
      speech: reply.speech,
      toolTraces: reply.toolTraces,
      timings: { sttMs, llmMs: reply.durationMs, totalMs },
      provider: config.provider.id,
    };
  });

  // ─────────────────────────────────────────────────────────────────── sessions ──

  app.get("/api/sessions", async (request): Promise<SessionsResponse> => {
    const query = parseWith(SessionsQuerySchema, request.query, "Параметры запроса");
    return { sessions: services.sessions.recent(query.limit ?? SESSIONS_DEFAULT_LIMIT) };
  });

  app.get("/api/sessions/:id", async (request) => {
    const { id } = parseWith(SessionParamsSchema, request.params, "Параметры запроса");
    const record = services.sessions.get(id);
    if (record === undefined) {
      throw new HttpError(404, "session_not_found", `Сессия ${id} не найдена`);
    }
    return record;
  });

  // ─────────────────────────────────────────────────────────────────────── logs ──

  app.get("/api/logs", async (request): Promise<LogsResponse> => {
    const query = parseWith(LogsQuerySchema, request.query, "Параметры запроса");
    const after = query.after ?? 0;
    const entries = services.log.since(after, query.limit ?? LOGS_DEFAULT_LIMIT);
    const last = entries.at(-1);
    return { entries, nextSeq: last === undefined ? after : last.seq };
  });

  app.get("/api/logs/stream", async (request, reply) => {
    const query = parseWith(LogsStreamQuerySchema, request.query, "Параметры запроса");
    const after = query.after ?? 0;
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const writeEntry = (entry: LogEntry): void => {
      if (response.writableEnded || response.destroyed) return;
      response.write(`id: ${entry.seq}\ndata: ${JSON.stringify(entry)}\n\n`);
    };
    for (const entry of services.log.since(after, SSE_REPLAY_LIMIT)) writeEntry(entry);
    if (!response.writableEnded) response.write(": connected\n\n");

    const unsubscribe = services.log.subscribe(writeEntry);
    const heartbeat = setInterval(() => {
      if (!response.writableEnded && !response.destroyed) response.write(": ping\n\n");
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref();

    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      if (!response.writableEnded) response.end();
    };
    request.raw.on("close", cleanup);
    response.on("close", cleanup);
    response.on("error", (err) => {
      log.warn("SSE stream failed", { error: err.message });
      cleanup();
    });
  });

  // ──────────────────────────────────────────────────────────────────────── mcp ──

  app.get("/api/mcp/servers", async (): Promise<McpServersResponse> => mcpServersResponse(services));

  app.get("/api/mcp/tools", async (): Promise<McpToolsResponse> => ({ tools: services.mcp.tools() }));

  app.post("/api/mcp/servers", async (request, reply) => {
    const body = parseWith(McpCreateSchema, request.body, "Тело запроса");
    const config = services.config.get();
    const server = buildMcpServer(body);
    if (config.tools.mcp.servers.some((existing) => existing.id === server.id)) {
      throw new HttpError(409, "mcp_server_exists", `MCP-сервер с id ${server.id} уже существует`);
    }
    const servers = [...config.tools.mcp.servers, server];
    await updateConfig(services, { tools: { mcp: { servers } } }, { refreshMcp: false });
    await refreshMcpTools(services, log);
    log.info("MCP server added", { id: server.id, transport: server.transport });
    return reply.code(201).send(mcpServerResponse(server, services));
  });

  app.put("/api/mcp/servers/:id", async (request) => {
    const { id } = parseWith(McpIdParamsSchema, request.params, "Параметры запроса");
    const body = parseWith(McpUpdateSchema, request.body, "Тело запроса");
    const config = services.config.get();
    const existing = config.tools.mcp.servers.find((server) => server.id === id);
    if (existing === undefined) {
      throw new HttpError(404, "mcp_server_not_found", `MCP-сервер ${id} не найден`);
    }
    const updated = buildMcpServer({ ...body, id }, existing);
    const servers = config.tools.mcp.servers.map((server) => (server.id === id ? updated : server));
    await updateConfig(services, { tools: { mcp: { servers } } }, { refreshMcp: false });
    await refreshMcpTools(services, log);
    log.info("MCP server updated", { id });
    return mcpServerResponse(updated, services);
  });

  app.delete("/api/mcp/servers/:id", async (request) => {
    const { id } = parseWith(McpIdParamsSchema, request.params, "Параметры запроса");
    const config = services.config.get();
    if (!config.tools.mcp.servers.some((server) => server.id === id)) {
      throw new HttpError(404, "mcp_server_not_found", `MCP-сервер ${id} не найден`);
    }
    const servers = config.tools.mcp.servers.filter((server) => server.id !== id);
    await updateConfig(services, { tools: { mcp: { servers } } }, { refreshMcp: false });
    await refreshMcpTools(services, log);
    log.info("MCP server removed", { id });
    return { deleted: true };
  });

  app.post("/api/mcp/servers/:id/test", async (request) => {
    const { id } = parseWith(McpIdParamsSchema, request.params, "Параметры запроса");
    const config = services.config.get();
    const server = config.tools.mcp.servers.find((candidate) => candidate.id === id);
    if (server === undefined) {
      throw new HttpError(404, "mcp_server_not_found", `MCP-сервер ${id} не найден`);
    }
    let health: ProviderHealth;
    try {
      health = await services.mcp.test(server);
    } catch (err) {
      throw upstreamError(log, err, `Не удалось проверить MCP-сервер ${id}`);
    }
    await refreshMcpTools(services, log);
    return health;
  });

  // ────────────────────────────────────────────────────────────────── schedules ──

  app.get("/api/schedules", async (): Promise<SchedulesResponse> => schedulesResponse(services));

  app.post("/api/schedules", async (request, reply) => {
    const body = parseWith(ScheduleCreateSchema, request.body, "Тело запроса");
    const config = services.config.get();
    if (!config.tools.scheduler.enabled) {
      throw new HttpError(409, "scheduler_disabled", "Планировщик выключен в настройках");
    }
    const active = await services.scheduler.list();
    if (active.length >= config.tools.scheduler.maxActive) {
      throw new HttpError(
        409,
        "scheduler_full",
        `Достигнут лимит активных задач планировщика (${config.tools.scheduler.maxActive})`,
      );
    }
    const action = toSchedulerAction(body.action);
    const at = resolveScheduleAt({ at: body.at, inSec: body.inSec });
    const created = await services.scheduler.addOnce({
      at,
      action,
      label: body.label,
      ...(body.runId !== undefined ? { runId: body.runId } : {}),
    });
    log.info("schedule created", { id: created.id, at: created.at });
    return reply.code(201).send(scheduleEntryDto(created.id, created.at, body.label, action, body.runId));
  });

  app.put("/api/schedules/:id", async (request) => {
    const { id } = parseWith(ScheduleParamsSchema, request.params, "Параметры запроса");
    const body = parseWith(ScheduleUpdateSchema, request.body, "Тело запроса");
    if (Object.keys(body).length === 0) {
      throw new HttpError(400, "empty_update", "Нет полей для обновления задачи");
    }
    const existing = (await services.scheduler.list()).find((entry) => entry.id === id);
    if (existing === undefined) {
      throw new HttpError(404, "schedule_not_found", `Задача ${id} не найдена`);
    }
    const action = body.action === undefined ? existing.action : toSchedulerAction(body.action);
    const label = body.label ?? existing.label;
    const at = resolveScheduleAt(
      { at: body.at, inSec: body.inSec },
      existing.at,
      body.at !== undefined || body.inSec !== undefined,
    );
    const runId = body.runId ?? existing.runId;
    // SchedulerApiLike has no in-place update: replace the entry (the id changes).
    await services.scheduler.cancel(existing.id);
    const created = await services.scheduler.addOnce({
      at,
      action,
      label,
      ...(runId !== undefined ? { runId } : {}),
    });
    log.info("schedule replaced", { oldId: existing.id, newId: created.id });
    return scheduleEntryDto(created.id, created.at, label, action, runId);
  });

  app.delete("/api/schedules/:id", async (request) => {
    const { id } = parseWith(ScheduleParamsSchema, request.params, "Параметры запроса");
    return cancelSchedule(services, id);
  });

  app.post("/api/schedules/:id/cancel", async (request) => {
    const { id } = parseWith(ScheduleParamsSchema, request.params, "Параметры запроса");
    return cancelSchedule(services, id);
  });

  app.post("/api/schedules/:id/run-now", async (request) => {
    const { id } = parseWith(ScheduleParamsSchema, request.params, "Параметры запроса");
    const existing = (await services.scheduler.list()).find((entry) => entry.id === id);
    if (existing === undefined) {
      throw new HttpError(404, "schedule_not_found", `Задача ${id} не найдена`);
    }
    const scheduler = services.scheduler;
    if (scheduler.runNow === undefined) {
      throw new HttpError(409, "run_now_unsupported", "Планировщик не поддерживает немедленный запуск задач");
    }
    try {
      const result = await scheduler.runNow(existing.id);
      log.info("schedule ran now", { id, ok: result.ok });
      return { ok: result.ok, ...(result.error !== undefined ? { error: result.error } : {}) };
    } catch (err) {
      throw upstreamError(log, err, `Не удалось выполнить задачу ${id}`);
    }
  });

  // ───────────────────────────────────────────────────────────────────────── ha ──

  app.get("/api/ha/entities", async (request): Promise<HaEntitiesResponse> => {
    const query = parseWith(HaEntitiesQuerySchema, request.query, "Параметры запроса");
    let entities: HaEntity[];
    let areas: HaArea[];
    try {
      [entities, areas] = await Promise.all([
        services.ha.listEntities({
          ...(query.domain !== undefined ? { domain: query.domain } : {}),
          ...(query.q !== undefined ? { query: query.q } : {}),
        }),
        services.ha.listAreas(),
      ]);
    } catch (err) {
      throw upstreamError(log, err, "HA Core API недоступен");
    }
    return {
      entities: entities.map((entity) => ({
        entity_id: entity.entity_id,
        name: entity.name,
        state: entity.state,
        domain: entity.domain,
        ...(entity.area_id !== undefined ? { area_id: entity.area_id } : {}),
      })),
      areas,
    };
  });

  app.get("/api/ha/areas", async (): Promise<{ areas: HaArea[] }> => {
    try {
      return { areas: await services.ha.listAreas() };
    } catch (err) {
      throw upstreamError(log, err, "HA Core API недоступен");
    }
  });

  // ─────────────────────────────────────────────────────────────────── ui static ──

  let ui: UiStatic | undefined;
  if (options.ui?.enabled !== false) {
    ui = await registerUiStatic(app, {
      ...(options.ui?.webDistDir !== undefined ? { webDistDir: options.ui.webDistDir } : {}),
    });
    log.info("UI static registered", { root: ui.root, built: ui.hasUi });
  }

  app.setNotFoundHandler((request, reply) => {
    const path = pathnameOf(request.raw.url);
    if (path.startsWith("/api") || path === "/health") {
      return reply.code(404).send(errorBody("not_found", "Маршрут не найден"));
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply.code(404).send(errorBody("not_found", "Маршрут не найден"));
    }
    if (ui !== undefined && ui.hasUi) return ui.sendIndex(reply);
    return reply
      .code(404)
      .type("text/html; charset=utf-8")
      .send(
        '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Pulsar Brain</title></head><body><h1>Страница не найдена</h1><p>UI не собран; доступны <code>/health</code> и <code>/api</code>.</p></body></html>',
      );
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    const path = pathnameOf(request.raw.url);
    if (error instanceof HttpError) {
      const details = { method: request.method, path, code: error.code, error: error.message };
      if (error.statusCode >= 500) log.error("request failed", details);
      else log.warn("request rejected", details);
      return reply.code(error.statusCode).send(errorBody(error.code, error.message));
    }
    if (error instanceof ZodError) {
      log.warn("request validation failed", { method: request.method, path, issues: error.issues.length });
      return reply.code(400).send(errorBody("validation_error", describeZodError("Запрос", error)));
    }
    const statusCode = statusCodeOf(error);
    const message = errorMessageOf(error);
    if (statusCode >= 500) {
      const stack = error instanceof Error ? error.stack : undefined;
      log.error("unhandled request error", {
        method: request.method,
        path,
        error: message,
        ...(stack !== undefined ? { stack } : {}),
      });
      return reply.code(500).send(errorBody("internal_error", "Внутренняя ошибка сервера"));
    }
    log.warn("request rejected by fastify", { method: request.method, path, statusCode, error: message });
    return reply.code(statusCode).send(errorBody(codeForStatus(statusCode), messageForStatus(statusCode)));
  });

  return app;
}

// ─────────────────────────────────────────────────────────────────────── schemas ──

const ProviderParamsSchema = z.object({ id: z.string().min(1).max(100) });
const SessionParamsSchema = z.object({ id: z.string().min(1).max(200) });
const McpIdParamsSchema = z.object({ id: z.string().regex(MCP_SERVER_ID_RE, "id: допустимы латиница, цифры, _ и -") });
const ScheduleParamsSchema = z.object({ id: z.string().min(1).max(200) });

const PromptPatchSchema = z.object({
  system: z.string().max(20_000).optional(),
  language: z.string().min(2).max(20).optional(),
});

const TtsPreviewRequestSchema = z.object({
  text: z.string().min(1).max(2000),
  voice: z.string().max(200).default(""),
});

const TestTextRequestSchema = z.object({
  text: z.string().min(1).max(4000),
  keepHistory: z.boolean().optional(),
});

const SessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(SESSIONS_MAX_LIMIT).optional(),
});

const LogsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(LOGS_MAX_LIMIT).optional(),
});

const LogsStreamQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
});

const HaEntitiesQuerySchema = z.object({
  domain: z.string().min(1).max(60).optional(),
  q: z.string().min(1).max(200).optional(),
});

const McpCreateSchema = z.object({
  id: z.string().regex(MCP_SERVER_ID_RE, "id: допустимы латиница, цифры, _ и -").optional(),
  name: z.string().min(1).max(120),
  enabled: z.boolean().optional(),
  transport: z.enum(["stdio", "http", "sse"]),
  command: z.string().max(500).optional(),
  args: z.array(z.string().max(500)).max(50).optional(),
  url: z.string().max(2000).optional(),
  headers: z.record(z.string().max(4000)).optional(),
  toolTimeoutSec: z.number().int().min(1).max(600).optional(),
});

const McpUpdateSchema = z.object({
  id: z.string().regex(MCP_SERVER_ID_RE, "id: допустимы латиница, цифры, _ и -").optional(),
  name: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  transport: z.enum(["stdio", "http", "sse"]).optional(),
  command: z.string().max(500).optional(),
  args: z.array(z.string().max(500)).max(50).optional(),
  url: z.string().max(2000).optional(),
  headers: z.record(z.string().max(4000)).optional(),
  toolTimeoutSec: z.number().int().min(1).max(600).optional(),
});

const HaTargetInputSchema = z.object({
  entity_id: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  area_id: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  device_id: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
});

const SchedulerActionInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ha.call_service"),
    request: z.object({
      domain: z.string().min(1).max(100),
      service: z.string().min(1).max(100),
      target: HaTargetInputSchema.optional(),
      data: z.record(z.unknown()).optional(),
    }),
  }),
  z.object({
    kind: z.literal("announce"),
    text: z.string().min(1).max(2000),
  }),
  z.object({
    kind: z.literal("mcp.tool"),
    name: z.string().min(1).max(200),
    args: z.record(z.unknown()),
  }),
]);

const ScheduleCreateSchema = z.object({
  at: z.union([z.number(), z.string().min(1)]).optional(),
  inSec: z.number().int().min(1).max(31_536_000).optional(),
  label: z.string().min(1).max(200),
  action: SchedulerActionInputSchema,
  runId: z.string().min(1).max(200).optional(),
});

const ScheduleUpdateSchema = z.object({
  at: z.union([z.number(), z.string().min(1)]).optional(),
  inSec: z.number().int().min(1).max(31_536_000).optional(),
  label: z.string().min(1).max(200).optional(),
  action: SchedulerActionInputSchema.optional(),
  runId: z.string().min(1).max(200).optional(),
});

type McpServerPatch = z.infer<typeof McpUpdateSchema>;
type SchedulerActionInput = z.infer<typeof SchedulerActionInputSchema>;
type HaTargetInput = z.infer<typeof HaTargetInputSchema>;

// ──────────────────────────────────────────────────────────────── errors/util ──

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function errorBody(code: string, message: string): ErrorResponse {
  return { error: { code, message } };
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, "validation_error", describeZodError(label, result.error));
  }
  return result.data;
}

function describeZodError(label: string, error: ZodError): string {
  const issues = error.issues
    .slice(0, 6)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "тело";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  return `${label}: ${issues}`;
}

function parseJsonObject(body: unknown, label: string): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "invalid_body", `${label}: тело запроса должно быть JSON-объектом`);
  }
  return body as Record<string, unknown>;
}

function pathnameOf(rawUrl: string | undefined): string {
  if (rawUrl === undefined) return "/";
  const queryIndex = rawUrl.indexOf("?");
  return queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
}

const INGRESS_TRUSTED_ADDRESSES = new Set([
  "172.30.32.2", // Supervisor container on the hassio network
  "::ffff:172.30.32.2",
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

function isAuthorized(request: FastifyRequest, validTokens: readonly string[]): boolean {
  // Behind the Supervisor ingress HA has already authenticated the user; the header alone
  // must not grant access because the addon also listens on its own container interface.
  const ingressPath = request.headers["x-ingress-path"];
  if (ingressPath !== undefined && INGRESS_TRUSTED_ADDRESSES.has(request.socket.remoteAddress ?? "")) {
    return true;
  }
  const header = request.headers.authorization;
  const headerToken = bearerFromAuthorization(typeof header === "string" ? header : undefined);
  if (headerToken !== null) return matchesAnyToken(headerToken, validTokens);
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const queryToken = tokenFromQuery(request.raw.url);
  return queryToken !== null && matchesAnyToken(queryToken, validTokens);
}

function upstreamError(log: LoggerLike, err: unknown, message: string): HttpError {
  log.error("upstream call failed", { error: err instanceof Error ? err.message : String(err) });
  return new HttpError(502, "upstream_error", message);
}

function statusCodeOf(error: unknown): number {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number" && Number.isInteger(statusCode) && statusCode >= 400) {
      return statusCode;
    }
  }
  return 500;
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeForStatus(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 405:
      return "method_not_allowed";
    case 413:
      return "payload_too_large";
    case 415:
      return "unsupported_media_type";
    case 429:
      return "too_many_requests";
    default:
      return "request_error";
  }
}

function messageForStatus(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return "Некорректный запрос";
    case 401:
      return "Требуется авторизация";
    case 403:
      return "Доступ запрещён";
    case 404:
      return "Маршрут не найден";
    case 405:
      return "Метод не поддерживается";
    case 413:
      return "Слишком большой запрос";
    case 415:
      return "Неподдерживаемый тип содержимого";
    case 429:
      return "Слишком много запросов";
    default:
      return "Ошибка запроса";
  }
}

// ────────────────────────────────────────────────────────────── config/prompt ──

function buildConfigResponse(services: AppServices): ConfigResponse {
  const config = services.config.get();
  return {
    config: services.config.masked(),
    warnings: [...configWarnings(config), ...storeWarnings(services)],
    bridgeToken: services.config.bridgeToken(),
  };
}

function storeWarnings(services: AppServices): string[] {
  const store = services.config as AppServices["config"] & { warnings?: () => string[] };
  return typeof store.warnings === "function" ? store.warnings() : [];
}

function configWarnings(config: AppConfig): string[] {
  const warnings: string[] = [];
  if (config.provider.id === "openai") {
    if (config.provider.openai.apiKey.length === 0) {
      warnings.push("Провайдер openai выбран, но API-ключ не задан.");
    }
    if (config.provider.openai.baseUrl.trim().length === 0) {
      warnings.push("Провайдер openai выбран, но baseUrl не задан.");
    }
  }
  if (config.provider.id === "openclaw" && config.provider.openclaw.apiKey.length === 0) {
    warnings.push("Провайдер openclaw выбран, но API-ключ не задан.");
  }
  if (config.provider.id === "gemini-live" && config.provider.geminiLive.apiKey.length === 0) {
    warnings.push("Провайдер gemini-live выбран, но API-ключ не задан.");
  }
  if (config.tools.ha.enabled && config.tools.ha.url.trim().length === 0) {
    const supervisorToken = process.env.SUPERVISOR_TOKEN;
    if (supervisorToken === undefined || supervisorToken.length === 0) {
      warnings.push(
        "Инструменты HA включены, но нет SUPERVISOR_TOKEN и не задан tools.ha.url — управление устройствами не работает.",
      );
    }
  }
  if (config.prompt.system.trim().length === 0) {
    warnings.push("Системный промпт пуст: ассистент будет отвечать без инструкций.");
  }
  return warnings;
}

function promptResponse(services: AppServices): PromptResponse {
  const config = services.config.get();
  return {
    system: config.prompt.system,
    language: config.prompt.language,
    defaults: DEFAULT_PROMPT,
  };
}

/**
 * ConfigStoreLike.update is typed with shared DeepPartial, which does not recurse into
 * interfaces. The concrete store accepts the fully recursive ConfigPatch; narrow it here
 * instead of casting the patch at every call site.
 */
async function applyConfigPatch(services: AppServices, patch: ConfigPatch): Promise<AppConfig> {
  const store = services.config as AppServices["config"] & {
    update(candidate: ConfigPatch): Promise<AppConfig>;
  };
  return store.update(patch);
}

interface UpdateConfigOptions {
  /** MCP CRUD routes refresh tools explicitly right after the config write. */
  refreshMcp?: boolean;
}

async function updateConfig(
  services: AppServices,
  patch: ConfigPatch,
  options: UpdateConfigOptions = {},
): Promise<void> {
  const previousMcp = JSON.stringify(services.config.get().tools.mcp);
  let updated: AppConfig;
  try {
    updated = await applyConfigPatch(services, patch);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpError(400, "validation_error", describeZodError("Конфигурация", err));
    }
    throw err;
  }
  const logger = services.log as LoggerLike & { setLevel?: (level: LogLevel) => void };
  if (typeof logger.setLevel === "function") logger.setLevel(updated.logLevel);
  if (options.refreshMcp !== false && JSON.stringify(updated.tools.mcp) !== previousMcp) {
    await refreshMcpTools(services, services.log.child("http"));
  }
}

function findProvider(services: AppServices, id: string) {
  const known = services.providers.list().find((provider) => provider.id === id);
  if (known === undefined) {
    throw new HttpError(404, "provider_not_found", `Провайдер ${id} не найден`);
  }
  return services.providers.get(known.id);
}

// ───────────────────────────────────────────────────────────────── test console ──

async function respondToText(services: AppServices, log: LoggerLike, text: string, config: AppConfig) {
  try {
    return await services.brain.respond({
      text,
      runId: `test-${randomUUID()}`,
      signal: AbortSignal.timeout(config.conversation.requestTimeoutMs),
    });
  } catch (err) {
    throw upstreamError(log, err, "Провайдер LLM не смог ответить");
  }
}

function assertBrainFinish(finish: string): void {
  if (finish === "error") {
    throw new HttpError(502, "provider_error", "Провайдер LLM вернул ошибку");
  }
  if (finish === "cancelled") {
    throw new HttpError(504, "provider_timeout", "Запрос к провайдеру LLM прерван по таймауту");
  }
}

// ──────────────────────────────────────────────────────────────────── pcm/wav ──

function concatPcm(chunks: Int16Array[]): Int16Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const combined = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

interface DecodedWav {
  format: PcmFormat;
  pcm: Int16Array;
}

/** Minimal RIFF reader for the test console: PCM 16-bit mono only. */
function decodeWavPcm16(buffer: Buffer): DecodedWav {
  if (
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new HttpError(400, "invalid_wav", "Ожидается WAV-файл (RIFF/WAVE)");
  }
  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (chunkId === "fmt ") {
      if (bodyStart + 16 > buffer.length) break;
      audioFormat = buffer.readUInt16LE(bodyStart);
      channels = buffer.readUInt16LE(bodyStart + 2);
      sampleRate = buffer.readUInt32LE(bodyStart + 4);
      bitsPerSample = buffer.readUInt16LE(bodyStart + 14);
    } else if (chunkId === "data") {
      dataOffset = bodyStart;
      dataLength = Math.min(chunkSize, buffer.length - bodyStart);
      if (audioFormat !== 0) break;
    }
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }
  if (audioFormat !== 1 || bitsPerSample !== 16 || channels !== 1 || dataOffset < 0 || dataLength < 2) {
    throw new HttpError(
      400,
      "invalid_wav",
      "WAV должен быть PCM 16 бит, один канал; другой формат не поддерживается",
    );
  }
  const sampleCount = Math.floor(dataLength / 2);
  const pcm = new Int16Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    pcm[index] = buffer.readInt16LE(dataOffset + index * 2);
  }
  return { format: { sampleRate, channels, width: 2 }, pcm };
}

// ──────────────────────────────────────────────────────────────────────── mcp ──

function mcpServersResponse(services: AppServices): McpServersResponse {
  const configured = services.config.get().tools.mcp.servers;
  const maskedById = new Map(
    services.config.masked().tools.mcp.servers.map((server) => [server.id, server] as const),
  );
  const states = new Map(services.mcp.states().map((state) => [state.id, state] as const));
  return {
    servers: configured.map((server) => {
      const masked = maskedById.get(server.id) ?? { ...server, headers: maskSecretRecord(server.headers) };
      const state = states.get(server.id);
      return {
        ...masked,
        enabled: state?.enabled ?? server.enabled,
        connected: state?.connected ?? false,
        error: state?.error ?? "",
        tools: state?.tools ?? [],
      };
    }),
  };
}

function mcpServerResponse(server: McpServerConfig, services: AppServices) {
  const state = services.mcp.states().find((candidate) => candidate.id === server.id);
  return {
    ...server,
    headers: maskSecretRecord(server.headers),
    enabled: state?.enabled ?? server.enabled,
    connected: state?.connected ?? false,
    error: state?.error ?? "",
    tools: state?.tools ?? [],
  };
}

function buildMcpServer(patch: McpServerPatch, existing?: McpServerConfig): McpServerConfig {
  const transport = patch.transport ?? existing?.transport ?? "http";
  const server: McpServerConfig = {
    id: patch.id ?? existing?.id ?? `mcp-${randomUUID().slice(0, 8)}`,
    name: patch.name ?? existing?.name ?? "MCP",
    enabled: patch.enabled ?? existing?.enabled ?? true,
    transport,
    command: patch.command ?? existing?.command ?? "",
    args: patch.args ?? existing?.args ?? [],
    url: patch.url ?? existing?.url ?? "",
    headers: mergeMaskedHeaders(patch.headers, existing?.headers ?? {}),
    toolTimeoutSec: patch.toolTimeoutSec ?? existing?.toolTimeoutSec ?? 15,
  };
  if ((transport === "http" || transport === "sse") && server.url.trim().length === 0) {
    throw new HttpError(400, "invalid_mcp_server", "Для транспорта http/sse нужен URL сервера");
  }
  if (transport === "stdio" && server.command.trim().length === 0) {
    throw new HttpError(400, "invalid_mcp_server", "Для транспорта stdio нужна команда запуска");
  }
  return McpServerConfigSchema.parse(server);
}

/** "***" in a patch means "keep the stored value". */
function mergeMaskedHeaders(
  patch: Record<string, string> | undefined,
  existing: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { ...existing };
  for (const [name, value] of Object.entries(patch ?? {})) {
    if (isMasked(value)) continue;
    headers[name] = value;
  }
  return headers;
}

async function refreshMcpTools(services: AppServices, log: LoggerLike): Promise<void> {
  try {
    await services.refreshMcpTools();
  } catch (err) {
    log.error(MCP_REFRESH_NOTE, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ─────────────────────────────────────────────────────────────────── schedules ──

async function schedulesResponse(services: AppServices): Promise<SchedulesResponse> {
  const entries = await services.scheduler.list();
  let nextAt: number | null = null;
  for (const entry of entries) {
    if (nextAt === null || entry.at < nextAt) nextAt = entry.at;
  }
  return {
    entries: entries.map((entry) =>
      scheduleEntryDto(entry.id, entry.at, entry.label, entry.action, entry.runId),
    ),
    nextAt,
  };
}

function scheduleEntryDto(
  id: string,
  at: number,
  label: string,
  action: SchedulerAction,
  runId?: string,
): SchedulesResponse["entries"][number] {
  return {
    id,
    at,
    label,
    action: { ...action } as Record<string, unknown>,
    ...(runId !== undefined ? { runId } : {}),
  };
}

async function cancelSchedule(services: AppServices, id: string) {
  const existing = (await services.scheduler.list()).find((entry) => entry.id === id);
  if (existing === undefined) {
    throw new HttpError(404, "schedule_not_found", `Задача ${id} не найдена`);
  }
  const result = await services.scheduler.cancel(id);
  return { cancelled: result.cancelled };
}

function toSchedulerAction(input: SchedulerActionInput): SchedulerAction {
  switch (input.kind) {
    case "ha.call_service":
      return { kind: "ha.call_service", request: buildHaRequest(input.request) };
    case "announce":
      return { kind: "announce", text: input.text };
    case "mcp.tool":
      return { kind: "mcp.tool", name: input.name, args: input.args };
  }
}

function buildHaRequest(input: {
  domain: string;
  service: string;
  target?: HaTargetInput | undefined;
  data?: Record<string, unknown> | undefined;
}): HaCallServiceRequest {
  const request: HaCallServiceRequest = { domain: input.domain, service: input.service };
  if (input.target !== undefined) {
    const target: HaServiceTarget = {};
    if (input.target.entity_id !== undefined) target.entity_id = input.target.entity_id;
    if (input.target.area_id !== undefined) target.area_id = input.target.area_id;
    if (input.target.device_id !== undefined) target.device_id = input.target.device_id;
    request.target = target;
  }
  if (input.data !== undefined) request.data = input.data;
  return request;
}

function resolveScheduleAt(
  input: { at?: number | string | undefined; inSec?: number | undefined },
  fallback?: number,
  requireFuture = true,
): number {
  let resolved: number;
  if (input.at !== undefined) {
    if (typeof input.at === "number") {
      resolved = input.at > 1_000_000_000_000 ? input.at : input.at * 1000;
    } else {
      resolved = Date.parse(input.at);
    }
    if (!Number.isFinite(resolved)) {
      throw new HttpError(400, "invalid_schedule_time", "Не удалось разобрать время запуска (at)");
    }
  } else if (input.inSec !== undefined) {
    resolved = Date.now() + input.inSec * 1000;
  } else if (fallback !== undefined) {
    resolved = fallback;
  } else {
    throw new HttpError(400, "invalid_schedule_time", "Укажите время запуска: at или inSec");
  }
  const at = Math.round(resolved);
  if (requireFuture && at <= Date.now()) {
    throw new HttpError(400, "invalid_schedule_time", "Время запуска должно быть в будущем");
  }
  return at;
}
