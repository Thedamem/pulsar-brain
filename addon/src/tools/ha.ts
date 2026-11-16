/**
 * Home Assistant backed tools: service calls, state reads, entity listing,
 * media control and satellite announcements. Speech text is produced by the
 * brain, so tools only report success data.
 */

import type {
  ConfigStoreLike,
  HaCallServiceRequest,
  HaServiceTarget,
  JsonSchema,
  LoggerLike,
  Tool,
  ToolContext,
  ToolRegistryLike,
  ToolResult,
} from "../shared/types.js";

const MAX_ENTITIES = 50;

function fail(error: string): ToolResult {
  return { ok: false, error };
}

function fromError(err: unknown): ToolResult {
  if (err instanceof Error) return { ok: false, error: err.message };
  return { ok: false, error: "HA request failed" };
}

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Service targets accept one id or a list; null means the field has an unusable type. */
function readTargetField(
  args: Record<string, unknown>,
  key: string,
): string | string[] | undefined | null {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") return null;
    ids.push(item.trim());
  }
  return ids.length === 0 ? null : ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function callHaService(
  ctx: ToolContext,
  domain: string,
  service: string,
  target: HaServiceTarget,
  data?: Record<string, unknown>,
): Promise<void> {
  const request: HaCallServiceRequest = { domain, service, target };
  if (data !== undefined) request.data = data;
  await ctx.ha.callService(request);
}

// ──────────────────────────────────────────────────────────────── schemas ──

const callServiceParameters: JsonSchema = {
  type: "object",
  properties: {
    domain: { type: "string", description: "Домен сервиса, например light" },
    service: { type: "string", description: "Имя сервиса, например turn_on" },
    entity_id: {
      type: "string",
      description: "Сущность или список сущностей, например light.kitchen",
    },
    area_id: { type: "string", description: "Зона (area) или список зон как цель вызова" },
    device_id: { type: "string", description: "Устройство (device) или список устройств как цель вызова" },
    data: {
      type: "object",
      description: "Данные сервиса, например {brightness: 128}",
      additionalProperties: true,
    },
  },
  required: ["domain", "service"],
  additionalProperties: false,
};

const getStateParameters: JsonSchema = {
  type: "object",
  properties: {
    entity_id: { type: "string", description: "Сущность, например sensor.temperature" },
  },
  required: ["entity_id"],
  additionalProperties: false,
};

const listEntitiesParameters: JsonSchema = {
  type: "object",
  properties: {
    domain: { type: "string", description: "Фильтр по домену: light, switch, media_player…" },
    query: { type: "string", description: "Подстрока в имени или entity_id" },
  },
  additionalProperties: false,
};

const mediaPlayParameters: JsonSchema = {
  type: "object",
  properties: {
    entity_id: { type: "string", description: "media_player, на котором играть" },
    media_content_id: {
      type: "string",
      description: "URL или идентификатор медиа; без него плеер просто включается",
    },
    media_content_type: {
      type: "string",
      description: "Тип медиа HA (music, video, url…), по умолчанию music",
    },
  },
  required: ["entity_id"],
  additionalProperties: false,
};

const mediaPauseParameters: JsonSchema = {
  type: "object",
  properties: {
    entity_id: { type: "string", description: "media_player для паузы" },
  },
  required: ["entity_id"],
  additionalProperties: false,
};

const mediaVolumeParameters: JsonSchema = {
  type: "object",
  properties: {
    entity_id: { type: "string", description: "media_player для изменения громкости" },
    level: { type: "number", description: "Громкость от 0 до 1" },
  },
  required: ["entity_id", "level"],
  additionalProperties: false,
};

const announceParameters: JsonSchema = {
  type: "object",
  properties: {
    entity_id: {
      type: "string",
      description: "Сателлит Assist, например assist_satellite.kitchen",
    },
    text: { type: "string", description: "Текст объявления" },
  },
  required: ["text"],
  additionalProperties: false,
};

// ────────────────────────────────────────────────────────────────── tools ──

const callServiceTool: Tool = {
  name: "ha.call_service",
  description:
    "Вызвать сервис Home Assistant: свет, розетки, сцены, климат и т. п. Цель передаётся через entity_id/area_id/device_id, параметры сервиса — в data.",
  parameters: callServiceParameters,
  async execute(args, ctx) {
    const domain = readString(args, "domain");
    const service = readString(args, "service");
    if (domain === undefined || service === undefined) {
      return fail("ha.call_service: нужны domain и service");
    }
    if (DENIED_SERVICE_DOMAINS.has(domain)) {
      return fail(`ha.call_service: домен «${domain}» запрещён из голосовых команд`);
    }
    const target: HaServiceTarget = {};
    const entityId = readTargetField(args, "entity_id");
    if (entityId === null) return fail("ha.call_service: entity_id должен быть строкой или списком строк");
    if (entityId !== undefined) target.entity_id = entityId;
    const areaId = readTargetField(args, "area_id");
    if (areaId === null) return fail("ha.call_service: area_id должен быть строкой или списком строк");
    if (areaId !== undefined) target.area_id = areaId;
    const deviceId = readTargetField(args, "device_id");
    if (deviceId === null) {
      return fail("ha.call_service: device_id должен быть строкой или списком строк");
    }
    if (deviceId !== undefined) target.device_id = deviceId;
    const data = args.data;
    if (data !== undefined && !isRecord(data)) {
      return fail("ha.call_service: data должен быть объектом");
    }
    try {
      await callHaService(ctx, domain, service, target, data);
      return { ok: true, data: { done: true } };
    } catch (err) {
      return fromError(err);
    }
  },
};

/**
 * Services that execute arbitrary code or control the host must never be reachable from a
 * voice phrase or a prompt-injected model. Scripts/scenes stay allowed; shell and Python
 * execution plus Supervisor/Core control do not.
 */
const DENIED_SERVICE_DOMAINS = new Set(["shell_command", "python_script", "hassio", "homeassistant"]);

const getStateTool: Tool = {
  name: "ha.get_state",
  description: "Получить состояние сущности Home Assistant и её атрибуты.",
  parameters: getStateParameters,
  async execute(args, ctx) {
    const entityId = readString(args, "entity_id");
    if (entityId === undefined) return fail("ha.get_state: нужен entity_id");
    try {
      const state = await ctx.ha.getState(entityId);
      if (state === null) return fail(`сущность не найдена: ${entityId}`);
      return {
        ok: true,
        data: {
          entity_id: state.entity_id,
          state: state.state,
          attributes: state.attributes,
        },
      };
    } catch (err) {
      return fromError(err);
    }
  },
};

const listEntitiesTool: Tool = {
  name: "ha.list_entities",
  description:
    "Найти сущности Home Assistant по домену и/или подстроке в имени. Возвращает не больше 50 штук.",
  parameters: listEntitiesParameters,
  async execute(args, ctx) {
    if (args.domain !== undefined && typeof args.domain !== "string") {
      return fail("ha.list_entities: domain должен быть строкой");
    }
    if (args.query !== undefined && typeof args.query !== "string") {
      return fail("ha.list_entities: query должен быть строкой");
    }
    const domain = readString(args, "domain");
    const query = readString(args, "query");
    try {
      const entities = await ctx.ha.listEntities({
        ...(domain === undefined ? {} : { domain }),
        ...(query === undefined ? {} : { query }),
      });
      return {
        ok: true,
        data: { entities: entities.slice(0, MAX_ENTITIES) },
      };
    } catch (err) {
      return fromError(err);
    }
  },
};

const mediaPlayTool: Tool = {
  name: "media.play",
  description:
    "Включить воспроизведение на media_player: play_media по media_content_id или обычное включение плеера без него.",
  parameters: mediaPlayParameters,
  async execute(args, ctx) {
    const entityId = readString(args, "entity_id");
    if (entityId === undefined) return fail("media.play: нужен entity_id");
    const contentId = readString(args, "media_content_id");
    try {
      if (contentId === undefined) {
        await callHaService(ctx, "media_player", "turn_on", { entity_id: entityId });
      } else {
        const contentType = readString(args, "media_content_type") ?? "music";
        await callHaService(ctx, "media_player", "play_media", { entity_id: entityId }, {
          media_content_id: contentId,
          media_content_type: contentType,
        });
      }
      return { ok: true, data: { done: true } };
    } catch (err) {
      return fromError(err);
    }
  },
};

const mediaPauseTool: Tool = {
  name: "media.pause",
  description: "Поставить воспроизведение на media_player на паузу.",
  parameters: mediaPauseParameters,
  async execute(args, ctx) {
    const entityId = readString(args, "entity_id");
    if (entityId === undefined) return fail("media.pause: нужен entity_id");
    try {
      await callHaService(ctx, "media_player", "media_pause", { entity_id: entityId });
      return { ok: true, data: { done: true } };
    } catch (err) {
      return fromError(err);
    }
  },
};

const mediaVolumeTool: Tool = {
  name: "media.volume",
  description: "Установить громкость media_player (0..1).",
  parameters: mediaVolumeParameters,
  async execute(args, ctx) {
    const entityId = readString(args, "entity_id");
    if (entityId === undefined) return fail("media.volume: нужен entity_id");
    const level = args.level;
    if (typeof level !== "number" || !Number.isFinite(level) || level < 0 || level > 1) {
      return fail("media.volume: level должен быть числом от 0 до 1");
    }
    try {
      await callHaService(ctx, "media_player", "volume_set", { entity_id: entityId }, {
        volume_level: level,
      });
      return { ok: true, data: { done: true } };
    } catch (err) {
      return fromError(err);
    }
  },
};

const announceTool: Tool = {
  name: "announce.say",
  description:
    "Объявить текст через Assist-сателлит (assist_satellite.announce). Требуется настроенный сателлит Assist и его entity_id в Home Assistant.",
  parameters: announceParameters,
  async execute(args, ctx) {
    const text = readString(args, "text");
    if (text === undefined) return fail("announce.say: нужен text");
    const entityId = readString(args, "entity_id");
    if (entityId === undefined) {
      return fail(
        "announce.say: нужен entity_id сателлита Assist (например, assist_satellite.kitchen); сначала настройте Assist-сателлит в Home Assistant",
      );
    }
    try {
      await callHaService(ctx, "assist_satellite", "announce", { entity_id: entityId }, {
        message: text,
      });
      return { ok: true, data: { done: true } };
    } catch (err) {
      return fromError(err);
    }
  },
};

const HA_TOOLS: Tool[] = [
  callServiceTool,
  getStateTool,
  listEntitiesTool,
  mediaPlayTool,
  mediaPauseTool,
  mediaVolumeTool,
  announceTool,
];

export function createHaTools(configStore: ConfigStoreLike, log: LoggerLike): Tool[] {
  const scopedLog = log.child("tools-ha");
  if (!configStore.get().tools.ha.enabled) {
    scopedLog.debug("HA tools are disabled by config");
    return [];
  }
  return [...HA_TOOLS];
}

export function registerHaTools(
  registry: ToolRegistryLike,
  configStore: ConfigStoreLike,
  log: LoggerLike,
): Tool[] {
  const tools = createHaTools(configStore, log);
  for (const tool of tools) registry.register(tool);
  return tools;
}
