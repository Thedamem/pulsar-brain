/**
 * Composition root.
 *
 * Creates every service, wires the dependency graph and starts the HTTP/WS server.
 * Nothing here owns business logic: modules receive their dependencies from this file and
 * read live configuration through ConfigStoreLike. Shutdown is ordered and idempotent.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import packageJson from "../package.json" with { type: "json" };
import type { LogLevel } from "./shared/types.js";
import type { FastifyInstance } from "fastify";
import type {
  AppConfig,
  AppServices,
  ConfigStoreLike,
  HaClientLike,
  LoggerLike,
  ProviderHealth,
  StatusSnapshot,
  TtsLike,
} from "./shared/types.js";
import { createConfigStore, type ConfigStore } from "./config/store.js";
import { createLogger } from "./log/logger.js";
import { createHaClient } from "./ha/client.js";
import { createToolRegistry } from "./tools/registry.js";
import { registerHaTools } from "./tools/ha.js";
import { createMcpManager } from "./mcp/manager.js";
import { createMcpTools } from "./tools/mcp.js";
import { createWyomingStt } from "./asr/wyoming.js";
import { createWyomingTts } from "./tts/wyoming.js";
import { createProviderTts, type ProviderTtsConfig } from "./tts/provider.js";
import { createAudioAccumulator } from "./audio/vad.js";
import { encodeWav } from "./audio/pcm.js";
import { createProviderRegistry } from "./llm/registry.js";
import { createBrain } from "./brain/orchestrator.js";
import { createSessionManager } from "./session/manager.js";
import { createSessionStore } from "./session/history.js";
import { createSchedulerStore, defaultSchedulerDbPath } from "./scheduler/store.js";
import { createActionExecutor } from "./scheduler/runner.js";
import { createSchedulerService } from "./scheduler/service.js";
import { createRecurringRunner } from "./schedule/recurring-runner.js";
import { createAllSchedulerTools } from "./tools/scheduler.js";
import { createHaRestAutomationWriter } from "./schedule/recurring.js";
import { createHttpServer } from "./server/http.js";
import { createBridgeServer } from "./server/bridge.js";
import { createStationService } from "./station/service.js";
import { registerStationApi } from "./station/api.js";
import { announceAddonDiscovery } from "./supervisor/discovery.js";
import { autodetectAudioServices } from "./supervisor/probe.js";
import { registerDebugApi } from "./debug/api.js";
import type { DiscoverySnapshot } from "./debug/diagnostics.js";

const VERSION: string = packageJson.version;
const DEFAULT_PORT = 8097;

async function main(): Promise<void> {
  const addonOptions = applyAddonOptions();
  const logger = createLogger({});
  const log = logger.child("main");
  const startedAt = Date.now();

  const configStore = await createConfigStore();
  if (addonOptions.autoDetect) {
    const detected = await autodetectAudioServices(configStore, {
      log: logger.child("autodetect"),
    });
    log.info("audio services autodetect", { applied: detected.applied, details: detected.details });
  }
  const initialConfig = configStore.get();
  log.info("config loaded", {
    dataDir: configStore.dataDir,
    provider: initialConfig.provider.id,
    warnings: configStore.warnings().length,
  });

  const ha = createHaClient(configStore, logger);
  const stationService = createStationService({
    configStore,
    ha,
    log: logger.child("station"),
    dataDir: configStore.dataDir,
  });
  await stationService.start();
  const stt = createWyomingStt(initialConfig.stt, logger.child("stt"));
  const providers = createProviderRegistry(initialConfig, logger);
  const tts = createTtsRouter(configStore, logger);
  const mcp = createMcpManager(configStore, logger);

  // Tool registry: HA first, then scheduler one-shots and the recurring tool.
  const tools = createToolRegistry(logger.child("tools"));
  registerHaTools(tools, configStore, logger.child("tools.ha"));

  const schedulerStore = createSchedulerStore(defaultSchedulerDbPath(), logger);
  const announce = createAnnounceCallback(ha);
  const executor = createActionExecutor({
    ha,
    mcp,
    announce,
    log: logger.child("scheduler"),
  });
  const scheduler = createSchedulerService({
    store: schedulerStore,
    execute: executor,
    log: logger.child("scheduler"),
    maxActive: () => configStore.get().tools.scheduler.maxActive,
  });
  const recurring = createRecurringRunner({
    store: schedulerStore,
    runner: scheduler.runner(),
    log: logger.child("scheduler.recurring"),
  });
  scheduler.attachRecurring(recurring);

  const automationWriter = createAutomationWriter(configStore, logger);
  for (const tool of createAllSchedulerTools({
    ha,
    log: logger.child("tools.scheduler"),
    recurring,
    ...(automationWriter === undefined ? {} : { writer: automationWriter }),
  })) {
    tools.register(tool);
  }

  const syncMcpTools = (): void => {
    tools.removeByPrefix("mcp.");
    for (const tool of createMcpTools(mcp)) {
      if (tools.get(tool.name) === undefined) {
        tools.register(tool);
      }
    }
  };
  const refreshMcpTools = async (): Promise<void> => {
    await mcp.reload(configStore.get());
    syncMcpTools();
  };
  await mcp.start(configStore.get());
  syncMcpTools();

  const brain = createBrain({
    configStore,
    providers,
    tools,
    ha,
    scheduler,
    mcp,
    log: logger.child("brain"),
  });

  const sessionStore = createSessionStore(join(configStore.dataDir, "sessions.db"), logger);
  const sessions = createSessionManager({
    configStore,
    log: logger.child("session"),
    stt,
    tts,
    brain,
    createVad: createAudioAccumulator,
    encodeWav,
    store: sessionStore,
  });

  let bridge: ReturnType<typeof createBridgeServer> | null = null;
  const bridgeInfo = (): { connected: boolean; lastRunAt: number | null } => {
    // The addon only sees the bridge through per-run WebSocket connections, so "connected"
    // means "the bridge has served at least one run since the addon started"; a live run also
    // counts. An empty lastRunAt means no voice request has reached the addon yet.
    const lastRunAt = bridge?.lastRunAt() ?? null;
    return {
      connected: (bridge?.connections() ?? 0) > 0 || lastRunAt !== null,
      lastRunAt,
    };
  };
  const status = createStatusProvider({
    configStore,
    startedAt,
    ha,
    stt,
    tts,
    providers,
    mcp,
    scheduler,
    sessions,
    bridgeInfo,
  });

  const services: AppServices = {
    config: configStore,
    log: logger,
    ha,
    stt,
    tts,
    brain,
    providers,
    tools,
    mcp,
    refreshMcpTools,
    scheduler,
    sessions,
    status,
    encodeWav,
    version: VERSION,
  };

  await scheduler.start();
  const accessToken = addonOptions.accessToken;
  const app = await startHttp(services, accessToken);
  registerStationApi(app, {
    service: stationService,
    bridgeToken: configStore.bridgeToken(),
    uiToken: accessToken,
    log: logger.child("station.api"),
  });

  const port = numberFromEnv("PULSAR_BRAIN_PORT", DEFAULT_PORT);
  const host = process.env.PULSAR_BRAIN_HOST?.trim() || "0.0.0.0";
  const supervisorToken = (process.env.SUPERVISOR_TOKEN ?? "").trim();
  let discoverySnapshot: DiscoverySnapshot = {
    state: supervisorToken.length > 0 ? "pending" : "not_supervisor",
    at: null,
    host: null,
    reason: supervisorToken.length > 0 ? "ещё не отправлено" : "нет SUPERVISOR_TOKEN",
  };

  const runDiscovery = async (): Promise<{ announced: boolean; reason?: string; host?: string }> => {
    if (supervisorToken.length === 0) {
      discoverySnapshot = { state: "not_supervisor", at: Date.now(), host: null, reason: "нет SUPERVISOR_TOKEN" };
      return { announced: false, reason: "not_supervisor" };
    }
    const result = await announceAddonDiscovery({
      log: logger.child("supervisor"),
      bridgeToken: configStore.bridgeToken(),
      version: VERSION,
      addonPort: port,
      supervisorToken,
    });
    discoverySnapshot = result.announced
      ? { state: "announced", at: Date.now(), host: result.host, reason: "" }
      : { state: "failed", at: Date.now(), host: null, reason: result.reason };
    log.info("supervisor discovery", { ...result });
    return result;
  };

  // Debug routes must be registered before the Fastify instance starts listening.
  registerDebugApi(app, {
    services,
    log: logger.child("debug"),
    accessToken,
    bridgeToken: configStore.bridgeToken(),
    addonPort: port,
    hostname: discoverySnapshot.host,
    startedAt,
    discovery: () => discoverySnapshot,
    rediscover: runDiscovery,
    autodetect: async () => {
      const detected = await autodetectAudioServices(configStore, {
        log: logger.child("autodetect"),
      });
      return { applied: detected.applied, details: detected.details };
    },
    stationName: () => stationService.bindingName(),
    integrationLastSeenAt: () => stationService.integrationLastSeenAt(),
  });

  bridge = createBridgeServer(app.server, {
    services,
    bridgeToken: configStore.bridgeToken(),
  });

  await app.listen({ port, host });
  log.info("addon started", {
    version: VERSION,
    port,
    host,
    bridgeTokenConfigured: configStore.bridgeToken().length > 0,
    providers: providers.list().map((provider) => provider.id),
  });

  await runDiscovery();
  const discoveryTimer = setInterval(() => {
    if (discoverySnapshot.state !== "announced") {
      void runDiscovery();
    }
  }, 5 * 60_000);
  discoveryTimer.unref();
  let discoveryTimerRef: ReturnType<typeof setInterval> | null = discoveryTimer;

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info("shutting down", { signal });
    try {
      await bridge?.close();
    } catch (err) {
      log.warn("bridge close failed", { error: errorText(err) });
    }
    if (discoveryTimerRef !== null) {
      clearInterval(discoveryTimerRef);
      discoveryTimerRef = null;
    }
    try {
      await app.close();
    } catch (err) {
      log.warn("http close failed", { error: errorText(err) });
    }
    try {
      await scheduler.stop();
    } catch (err) {
      log.warn("scheduler stop failed", { error: errorText(err) });
    }
    try {
      await mcp.stop();
    } catch (err) {
      log.warn("mcp stop failed", { error: errorText(err) });
    }
    try {
      schedulerStore.close();
    } catch (err) {
      log.warn("scheduler store close failed", { error: errorText(err) });
    }
    try {
      sessionStore.close();
    } catch (err) {
      log.warn("session store close failed", { error: errorText(err) });
    }
    log.info("stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

/**
 * TTS router: the voice pipeline asks for plain text synthesis, while the admin UI preview
 * always uses Piper with an explicit voice. Provider TTS is used when configured; otherwise
 * Piper. Gemini Live native audio never reaches this router (it comes back as brain audio).
 */
function createTtsRouter(configStore: ConfigStoreLike, parentLog: LoggerLike): TtsLike {
  const log = parentLog.child("tts");
  const piper = createWyomingTts(configStore.get().tts, log);
  const provider = createProviderTts(() => providerTtsConfig(configStore.get()), log);

  const useProvider = (config: AppConfig): boolean => {
    if (config.tts.mode === "provider") {
      return true;
    }
    if (config.tts.mode !== "auto") {
      return false;
    }
    return config.provider.id === "openai" && config.provider.openai.apiKey.length > 0;
  };

  return {
    async *synthesize(text: string, signal: AbortSignal, voice?: string) {
      const config = configStore.get();
      if (useProvider(config)) {
        yield* provider.synthesize(text, signal);
        return;
      }
      yield* piper.synthesize(text, signal, voice);
    },
    listVoices() {
      return piper.listVoices();
    },
    async health(): Promise<ProviderHealth> {
      const config = configStore.get();
      const target = useProvider(config) ? provider : piper;
      const health = await target.health();
      if (health.ok) {
        return health;
      }
      const fallback = await piper.health();
      return {
        ok: fallback.ok,
        detail: `${health.detail}; Piper: ${fallback.detail}`,
      };
    },
  };
}

function providerTtsConfig(config: AppConfig): ProviderTtsConfig {
  const result: ProviderTtsConfig = {
    baseUrl: config.provider.openai.baseUrl,
    apiKey: config.provider.openai.apiKey,
    model: config.tts.provider.model,
    voice: config.tts.provider.voice,
    format: config.tts.provider.format,
  };
  if (Object.keys(config.provider.openai.extraHeaders).length > 0) {
    result.extraHeaders = config.provider.openai.extraHeaders;
  }
  if (config.tts.provider.format === "pcm") {
    result.sampleRate = 24_000;
  }
  if (config.tts.provider.language.length > 0) {
    result.language = config.tts.provider.language;
  }
  return result;
}

/**
 * Pulsar announcements are played by the satellite entity, not by the addon, so the
 * scheduler needs the first assist_satellite entity found in HA.
 */
function createAnnounceCallback(ha: HaClientLike): (text: string) => Promise<void> {
  return async (text: string): Promise<void> => {
    const satellites = await ha.listStates("assist_satellite");
    const target = satellites.find((state) => state.state !== "unavailable")?.entity_id;
    if (target === undefined) {
      throw new Error("assist_satellite entity is not available in Home Assistant");
    }
    await ha.callService({
      domain: "assist_satellite",
      service: "announce",
      target: { entity_id: target },
      data: { message: text },
    });
  };
}

function createAutomationWriter(
  configStore: ConfigStoreLike,
  log: LoggerLike,
): ReturnType<typeof createHaRestAutomationWriter> | undefined {
  const config = configStore.get();
  const token = config.tools.ha.token.trim() || (process.env.SUPERVISOR_TOKEN ?? "").trim();
  const configured = config.tools.ha.url.trim();
  // The REST automation endpoint lives under /api, the same root the HA client uses.
  const baseUrl =
    configured.length === 0
      ? "http://supervisor/core/api"
      : configured.endsWith("/api")
        ? configured
        : `${configured.replace(/\/+$/u, "")}/api`;
  if (token.length === 0) {
    log.warn("HA automation REST writer is disabled: no HA token configured");
    return undefined;
  }
  try {
    return createHaRestAutomationWriter({ baseUrl, token });
  } catch (err) {
    log.warn("HA automation REST writer is disabled", { error: errorText(err) });
    return undefined;
  }
}

async function startHttp(services: AppServices, uiToken: string): Promise<FastifyInstance> {
  return createHttpServer(
    { services },
    uiToken.length === 0 ? {} : { uiToken },
  );
}

interface StatusDeps {
  configStore: ConfigStore;
  startedAt: number;
  ha: HaClientLike;
  stt: AppServices["stt"];
  tts: AppServices["tts"];
  providers: AppServices["providers"];
  mcp: AppServices["mcp"];
  scheduler: AppServices["scheduler"] & { activeCount(): number; nextAt(): number | null };
  sessions: AppServices["sessions"];
  bridgeInfo(): { connected: boolean; lastRunAt: number | null };
}

function createStatusProvider(deps: StatusDeps): () => Promise<StatusSnapshot> {
  return async (): Promise<StatusSnapshot> => {
    const config = deps.configStore.get();
    const [sttHealth, ttsHealth, haHealth, providerHealth] = await Promise.all([
      safeHealth(deps.stt.health(), "распознавание речи"),
      safeHealth(deps.tts.health(), "синтез речи"),
      haHealthCheck(deps.ha),
      safeHealth(deps.providers.get(config.provider.id).health(config), "провайдер"),
    ]);
    return {
      version: VERSION,
      uptimeSec: Math.floor((Date.now() - deps.startedAt) / 1000),
      bridge: deps.bridgeInfo(),
      activeRuns: deps.sessions.active(),
      health: {
        stt: sttHealth,
        tts: ttsHealth,
        ha: haHealth,
        provider: providerHealth,
        mcp: deps.mcp.states().map((state) => ({
          id: state.id,
          connected: state.connected,
          error: state.error,
        })),
      },
      scheduler: {
        active: deps.scheduler.activeCount(),
        nextAt: deps.scheduler.nextAt(),
      },
      configWarnings: deps.configStore.warnings(),
    };
  };
}

async function safeHealth(promise: Promise<ProviderHealth>, what: string): Promise<ProviderHealth> {
  try {
    return await promise;
  } catch (err) {
    return { ok: false, detail: `${what}: ${errorText(err)}` };
  }
}

async function haHealthCheck(ha: HaClientLike): Promise<ProviderHealth> {
  try {
    const ok = await ha.available();
    return ok ? { ok: true, detail: "Home Assistant доступен" } : { ok: false, detail: "нет связи с HA" };
  } catch (err) {
    return { ok: false, detail: `Home Assistant: ${errorText(err)}` };
  }
}

/**
 * Home Assistant writes the addon options to /data/options.json. The only option we expose is
 * log_level; it is translated into the environment variable the logger already understands.
 */
interface AddonOptions {
  accessToken: string;
  autoDetect: boolean;
}

function applyAddonOptions(): AddonOptions {
  const dataDir = process.env.PULSAR_BRAIN_DATA_DIR?.trim() || "/data";
  let raw: string;
  const result: AddonOptions = { accessToken: "", autoDetect: true };
  try {
    raw = readFileSync(join(dataDir, "options.json"), "utf8");
  } catch {
    return { ...result, accessToken: process.env.PULSAR_BRAIN_UI_TOKEN?.trim() ?? "" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...result, accessToken: process.env.PULSAR_BRAIN_UI_TOKEN?.trim() ?? "" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ...result, accessToken: process.env.PULSAR_BRAIN_UI_TOKEN?.trim() ?? "" };
  }
  const options = parsed as { log_level?: unknown; access_token?: unknown; auto_detect?: unknown };
  const valid: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error"];
  if (typeof options.log_level === "string" && (valid as readonly string[]).includes(options.log_level)) {
    process.env.PULSAR_BRAIN_LOG_LEVEL = options.log_level;
  }
  if (typeof options.access_token === "string" && options.access_token.trim().length > 0) {
    result.accessToken = options.access_token.trim();
    // The UI and the debug API share one bearer token.
    process.env.PULSAR_BRAIN_UI_TOKEN = result.accessToken;
  } else if ((process.env.PULSAR_BRAIN_UI_TOKEN ?? "").trim().length > 0) {
    result.accessToken = (process.env.PULSAR_BRAIN_UI_TOKEN ?? "").trim();
  }
  if (typeof options.auto_detect === "boolean") {
    result.autoDetect = options.auto_detect;
  }
  return result;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

await main();
