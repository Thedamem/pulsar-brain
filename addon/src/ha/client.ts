/**
 * Home Assistant Core REST client.
 *
 * Addon (Supervisor) mode: base URL http://supervisor/core/api, bearer token from
 * SUPERVISOR_TOKEN. Dev mode overrides both through config.tools.ha.
 *
 * HA Core REST does not expose the area registry (it is a WebSocket-only API), so
 * listAreas() probes the optional /api/areas endpoint and falls back to an empty
 * list instead of inventing area data.
 */

import type {
  ConfigStoreLike,
  HaArea,
  HaCallServiceRequest,
  HaClientLike,
  HaEntity,
  HaServiceTarget,
  HaState,
  LoggerLike,
} from "../shared/types.js";

const DEFAULT_API_BASE = "http://supervisor/core/api";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ERROR_DETAIL = 200;

export type HaErrorCode =
  | "no_token"
  | "invalid_request"
  | "timeout"
  | "network"
  | "http"
  | "invalid_response"
  | "unsafe_token_target";

export class HaError extends Error {
  readonly code: HaErrorCode;
  readonly status: number | undefined;

  constructor(code: HaErrorCode, message: string, status?: number) {
    super(message);
    this.name = "HaError";
    this.code = code;
    this.status = status;
  }
}

export function createHaClient(configStore: ConfigStoreLike, parentLog: LoggerLike): HaClientLike {
  const log = parentLog.child("ha");

  function settings(): { apiBase: string; token: string } {
    const ha = configStore.get().tools.ha;
    const configToken = ha.token.trim();
    const envToken = (process.env.SUPERVISOR_TOKEN ?? "").trim();
    const apiBase = resolveApiBase(ha.url);
    if (configToken === "" && envToken !== "" && !isSupervisorBase(apiBase)) {
      throw new HaError(
        "unsafe_token_target",
        "SUPERVISOR_TOKEN нельзя отправлять на заданный tools.ha.url: укажите отдельный tools.ha.token",
      );
    }
    return { apiBase, token: configToken !== "" ? configToken : envToken };
  }

  async function requestJson(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const { apiBase, token } = settings();
    if (token === "") {
      throw new HaError("no_token", "HA token не настроен: задайте tools.ha.token или SUPERVISOR_TOKEN");
    }
    const url = `${apiBase}${path}`;
    // Only idempotent GETs are retried; a service call must never run twice.
    const maxAttempts = method === "GET" ? 2 : 1;
    let lastError = new HaError("network", `HA запрос не выполнен: ${method} ${path}`);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      try {
        const init: RequestInit = {
          method,
          headers: buildHeaders(token, body !== undefined),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        };
        const response = await fetch(url, init);

        if (!response.ok) {
          const detail = await readErrorDetail(response, log);
          const httpError = new HaError(
            "http",
            `HA ${method} ${path} вернул ${response.status}${detail === "" ? "" : `: ${detail}`}`,
            response.status,
          );
          if (method === "GET" && response.status >= 500 && attempt < maxAttempts) {
            log.warn("HA GET failed, retrying", {
              method,
              path,
              status: response.status,
              attempt,
            });
            lastError = httpError;
            continue;
          }
          throw httpError;
        }

        const payload = await parseResponse(response, path);
        log.debug("HA request ok", {
          method,
          path,
          status: response.status,
          durationMs: Date.now() - startedAt,
        });
        return payload;
      } catch (err) {
        if (err instanceof HaError) throw err;

        const timedOut = errorName(err) === "TimeoutError";
        lastError = timedOut
          ? new HaError("timeout", `HA не ответил за ${REQUEST_TIMEOUT_MS} мс: ${method} ${path}`)
          : new HaError("network", `HA недоступен: ${method} ${path}: ${describeError(err)}`);

        if (method === "GET" && !timedOut && attempt < maxAttempts) {
          log.warn("HA GET network error, retrying", {
            method,
            path,
            attempt,
            error: describeError(err),
          });
          continue;
        }
        throw lastError;
      }
    }

    throw lastError;
  }

  async function callService(req: HaCallServiceRequest): Promise<void> {
    const domain = req.domain.trim();
    const service = req.service.trim();
    if (domain === "" || service === "") {
      throw new HaError("invalid_request", "HA callService: domain и service обязательны");
    }
    const body: Record<string, unknown> = { ...(req.data ?? {}) };
    const target: HaServiceTarget = req.target ?? {};
    if (target.entity_id !== undefined) body.entity_id = target.entity_id;
    if (target.area_id !== undefined) body.area_id = target.area_id;
    if (target.device_id !== undefined) body.device_id = target.device_id;
    await requestJson(
      "POST",
      `/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`,
      body,
    );
  }

  async function listStates(domain?: string): Promise<HaState[]> {
    const payload = await requestJson("GET", "/states");
    if (!Array.isArray(payload)) {
      throw new HaError("invalid_response", "HA /states вернул не массив");
    }
    const states: HaState[] = [];
    for (const item of payload) {
      const state = toHaState(item);
      if (state === null) {
        throw new HaError("invalid_response", "HA /states содержит некорректную сущность");
      }
      states.push(state);
    }
    if (domain === undefined || domain.trim() === "") return states;
    const wanted = domain.trim();
    return states.filter((state) => entityDomain(state.entity_id) === wanted);
  }

  async function getState(entityId: string): Promise<HaState | null> {
    const id = entityId.trim();
    if (id === "") {
      throw new HaError("invalid_request", "HA getState: entity_id обязателен");
    }
    try {
      const payload = await requestJson("GET", `/states/${encodeURIComponent(id)}`);
      const state = toHaState(payload);
      if (state === null) {
        throw new HaError("invalid_response", `HA /states/${id} вернул некорректную сущность`);
      }
      return state;
    } catch (err) {
      if (err instanceof HaError && err.status === 404) return null;
      throw err;
    }
  }

  async function listEntities(
    filter: { domain?: string; query?: string; areaId?: string } = {},
  ): Promise<HaEntity[]> {
    const states = await listStates();
    const wantedDomain = filter.domain?.trim() ?? "";
    const query = filter.query?.trim().toLowerCase() ?? "";
    const entities: HaEntity[] = [];

    for (const state of states) {
      const domain = entityDomain(state.entity_id);
      if (wantedDomain !== "" && domain !== wantedDomain) continue;
      const friendlyName = state.attributes.friendly_name;
      const name = typeof friendlyName === "string" && friendlyName !== "" ? friendlyName : state.entity_id;
      if (
        query !== "" &&
        !name.toLowerCase().includes(query) &&
        !state.entity_id.toLowerCase().includes(query)
      ) {
        continue;
      }
      const entity: HaEntity = {
        entity_id: state.entity_id,
        name,
        domain,
        state: state.state,
      };
      const areaId = state.attributes.area_id;
      if (typeof areaId === "string") entity.area_id = areaId;
      const deviceId = state.attributes.device_id;
      if (typeof deviceId === "string") entity.device_id = deviceId;
      entities.push(entity);
    }

    const wantedAreaId = filter.areaId?.trim() ?? "";
    if (wantedAreaId !== "") {
      // /api/states has no area registry data; only explicit area_id attributes can match.
      log.debug("HA listEntities area filter uses attributes.area_id only", {
        areaId: wantedAreaId,
      });
      return entities.filter((entity) => entity.area_id === wantedAreaId);
    }
    return entities;
  }

  async function listAreas(): Promise<HaArea[]> {
    try {
      const payload = await requestJson("GET", "/areas");
      if (!Array.isArray(payload)) {
        throw new HaError("invalid_response", "HA /areas вернул не массив");
      }
      const areas: HaArea[] = [];
      for (const item of payload) {
        const areaId = isRecord(item) ? item.area_id : undefined;
        const name = isRecord(item) ? item.name : undefined;
        if (typeof areaId !== "string" || typeof name !== "string") {
          throw new HaError("invalid_response", "HA /areas содержит некорректную зону");
        }
        areas.push({ area_id: areaId, name });
      }
      return areas;
    } catch (err) {
      const status = err instanceof HaError ? err.status : undefined;
      if (status === 404 || status === 405) {
        log.debug("HA has no REST area endpoint, listAreas returns empty", { status });
      } else {
        log.warn("HA areas are not available over REST, listAreas returns empty", {
          error: describeError(err),
        });
      }
      return [];
    }
  }

  async function listServices(): Promise<Array<{ domain: string; service: string }>> {
    const payload = await requestJson("GET", "/services");
    if (!Array.isArray(payload)) {
      throw new HaError("invalid_response", "HA /services вернул не массив");
    }
    const services: Array<{ domain: string; service: string }> = [];
    for (const item of payload) {
      if (!isRecord(item) || typeof item.domain !== "string" || !isRecord(item.services)) {
        throw new HaError("invalid_response", "HA /services содержит некорректный домен");
      }
      for (const service of Object.keys(item.services)) {
        services.push({ domain: item.domain, service });
      }
    }
    return services;
  }

  async function available(): Promise<boolean> {
    try {
      await requestJson("GET", "/");
      return true;
    } catch (err) {
      log.debug("HA is not available", { error: describeError(err) });
      return false;
    }
  }

  return { callService, getState, listStates, listEntities, listAreas, listServices, available };
}

/** Accepts either http://host:8123 or http://host:8123/api and returns the API base. */
function isSupervisorBase(apiBase: string): boolean {
  return /^http:\/\/supervisor(?::\d+)?\//i.test(apiBase);
}

function resolveApiBase(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (trimmed === "") return DEFAULT_API_BASE;
  return /\/api$/i.test(trimmed) ? trimmed : `${trimmed}/api`;
}

function buildHeaders(token: string, withJsonBody: boolean): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(withJsonBody ? { "Content-Type": "application/json" } : {}),
  };
}

async function parseResponse(response: Response, path: string): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new HaError("invalid_response", `HA вернул не-JSON для ${path}: ${describeError(err)}`);
  }
}

async function readErrorDetail(response: Response, log: LoggerLike): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    log.debug("HA error body is unreadable", { error: describeError(err) });
    return "";
  }
  const trimmed = text.trim();
  if (trimmed === "") return "";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed) && typeof parsed.message === "string") {
      return parsed.message.slice(0, MAX_ERROR_DETAIL);
    }
  } catch (err) {
    log.debug("HA error body is not JSON", { error: describeError(err) });
  }
  return trimmed.slice(0, MAX_ERROR_DETAIL);
}

function toHaState(value: unknown): HaState | null {
  if (!isRecord(value)) return null;
  const entityId = value.entity_id;
  const state = value.state;
  const attributes = value.attributes;
  if (
    typeof entityId !== "string" ||
    entityId.indexOf(".") <= 0 ||
    typeof state !== "string" ||
    !isRecord(attributes)
  ) {
    return null;
  }
  const result: HaState = { entity_id: entityId, state, attributes };
  if (typeof value.last_changed === "string") result.last_changed = value.last_changed;
  return result;
}

function entityDomain(entityId: string): string {
  const dot = entityId.indexOf(".");
  return dot > 0 ? entityId.slice(0, dot) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorName(err: unknown): string {
  if (isRecord(err) && typeof err.name === "string") return err.name;
  return "";
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? `: ${err.cause.message}` : "";
    return `${err.message}${cause}`.slice(0, MAX_ERROR_DETAIL);
  }
  return String(err).slice(0, MAX_ERROR_DETAIL);
}
