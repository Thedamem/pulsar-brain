/**
 * HTTP endpoints for station discovery and binding (docs/contracts.md §8.4).
 *
 * Registered by the composition root on the shared Fastify instance. Auth is enforced here
 * as well as in the global /api hook: the bridge token is the only credential the integration
 * may use to push the station list, while UI routes accept the UI token, the bridge token
 * (when PULSAR_BRAIN_UI_TOKEN is unset) or a trusted Supervisor ingress request.
 *
 * Errors use the addon-wide {"error":{code,message}} envelope and never include the PSK.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { bearerFromAuthorization, matchesAnyToken } from "../server/auth.js";
import type { ErrorResponse } from "../shared/protocol.js";
import type { LoggerLike } from "../shared/types.js";
import { SetStationRequestSchema, StationsBodySchema, describeZodError } from "./schema.js";
import { StationError, type StationService } from "./service.js";

/** 100 stations with long names fit comfortably; the global 32 MB limit is too permissive here. */
const STATIONS_BODY_LIMIT = 128 * 1024;

const INGRESS_TRUSTED_ADDRESSES = new Set([
  "172.30.32.2", // Supervisor container on the hassio network
  "::ffff:172.30.32.2",
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

export interface StationApiDeps {
  service: StationService;
  bridgeToken: string;
  /** May be empty: the bridge token and trusted ingress remain valid UI credentials. */
  uiToken: string;
  log: LoggerLike;
}

export function registerStationApi(app: FastifyInstance, deps: StationApiDeps): void {
  const { service, bridgeToken, uiToken, log } = deps;
  const allowedUiTokens = [uiToken, bridgeToken].filter((token) => token.length > 0);

  const authorizedUi = (request: FastifyRequest): boolean => {
    if (hasTrustedIngress(request)) return true;
    const token = bearerOf(request);
    return token !== null && matchesAnyToken(token, allowedUiTokens);
  };

  const authorizedBridge = (request: FastifyRequest): boolean => {
    const token = bearerOf(request);
    return token !== null && bridgeToken.length > 0 && matchesAnyToken(token, [bridgeToken]);
  };

  app.get("/api/stations", async (request, reply) => {
    if (!authorizedUi(request)) return rejectUnauthorized(reply, log, request.method);
    return service.stationsResponse();
  });

  app.post(
    "/api/stations",
    { bodyLimit: STATIONS_BODY_LIMIT },
    async (request, reply) => {
      if (!authorizedBridge(request)) return rejectUnauthorized(reply, log, request.method);
      const parsed = StationsBodySchema.safeParse(request.body);
      if (!parsed.success) {
        log.warn("station list rejected", { issues: parsed.error.issues.length });
        return reply
          .code(400)
          .send(errorBody("validation_error", describeZodError("Список станций", parsed.error)));
      }
      try {
        await service.setStations(parsed.data.stations, parsed.data.current);
      } catch (err) {
        return rejectServiceError(reply, log, err);
      }
      return { ok: true };
    },
  );

  app.post("/api/station", async (request, reply) => {
    if (!authorizedUi(request)) return rejectUnauthorized(reply, log, request.method);
    const parsed = SetStationRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      log.warn("station bind request rejected", { issues: parsed.error.issues.length });
      return reply
        .code(400)
        .send(errorBody("validation_error", describeZodError("Привязка станции", parsed.error)));
    }
    try {
      return await service.bind(parsed.data);
    } catch (err) {
      return rejectServiceError(reply, log, err);
    }
  });

  app.delete("/api/station", async (request, reply) => {
    if (!authorizedUi(request)) return rejectUnauthorized(reply, log, request.method);
    try {
      return await service.clear();
    } catch (err) {
      return rejectServiceError(reply, log, err);
    }
  });
}

function bearerOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  return bearerFromAuthorization(typeof header === "string" ? header : undefined);
}

/** Mirrors the global hook in server/http.ts: HA already authenticated an ingress user. */
function hasTrustedIngress(request: FastifyRequest): boolean {
  const ingressPath = request.headers["x-ingress-path"];
  return (
    ingressPath !== undefined && INGRESS_TRUSTED_ADDRESSES.has(request.socket.remoteAddress ?? "")
  );
}

function rejectUnauthorized(
  reply: FastifyReply,
  log: LoggerLike,
  method: string,
): FastifyReply {
  log.warn("unauthorized station request", { method });
  return reply
    .code(401)
    .header("WWW-Authenticate", 'Bearer realm="pulsar-brain"')
    .send(errorBody("unauthorized", "Требуется Bearer-токен доступа"));
}

function rejectServiceError(reply: FastifyReply, log: LoggerLike, err: unknown): FastifyReply {
  if (err instanceof StationError) {
    const status = err.code === "station_not_found" ? 404 : 400;
    log.warn("station request rejected", { code: err.code, error: err.message });
    return reply.code(status).send(errorBody(err.code, err.message));
  }
  log.error("station request failed", { error: errorText(err) });
  return reply.code(500).send(errorBody("internal_error", "Внутренняя ошибка сервера"));
}

function errorBody(code: string, message: string): ErrorResponse {
  return { error: { code, message } };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
