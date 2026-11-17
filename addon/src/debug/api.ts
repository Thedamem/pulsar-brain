/**
 * Optional debug API (docs/contracts.md §8.5).
 *
 * Disabled unless an access token is configured in the addon options; the Supervisor ingress
 * keeps working without it. The API is meant for an administrator (or an agent acting for
 * them) to inspect discovery, probe network targets and run STT/TTS auto-detection.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { bearerFromAuthorization, matchesAnyToken } from "../server/auth.js";
import type {
  AutodetectResponse,
  DiagnosticsResponse,
  ErrorResponse,
  ProbeRequest,
  ProbeResponse,
} from "../shared/protocol.js";
import type { AppServices, LoggerLike } from "../shared/types.js";
import { probeTcp } from "../supervisor/probe.js";
import { buildDiagnostics, type DiscoverySnapshot } from "./diagnostics.js";

const TRUSTED_INGRESS_ADDRESSES = new Set([
  "172.30.32.2",
  "::ffff:172.30.32.2",
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

export interface DebugApiDeps {
  services: AppServices;
  log: LoggerLike;
  accessToken: string;
  bridgeToken: string;
  addonPort: number;
  hostname: string | null;
  startedAt: number;
  discovery: () => DiscoverySnapshot;
  rediscover: () => Promise<{ announced: boolean; reason?: string; host?: string }>;
  autodetect: () => Promise<AutodetectResponse>;
  stationName: () => string | null;
  integrationLastSeenAt: () => number | null;
  probe?: typeof probeTcp;
}

export function registerDebugApi(app: FastifyInstance, deps: DebugApiDeps): void {
  const { accessToken, bridgeToken, log } = deps;
  const allowed = [accessToken, bridgeToken].filter((token) => token.length > 0);
  const debugConfigured = accessToken.length > 0;
  const probe = deps.probe ?? probeTcp;

  const authorized = (request: FastifyRequest): "ok" | "disabled" | "denied" => {
    if (hasTrustedIngress(request)) return "ok";
    const token = bearerOf(request);
    if (token !== null && allowed.length > 0 && matchesAnyToken(token, allowed)) return "ok";
    return debugConfigured || bridgeToken.length > 0 ? "denied" : "disabled";
  };

  const guard = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const state = authorized(request);
    if (state === "ok") return true;
    if (state === "disabled") {
      reply
        .code(503)
        .send(errorBody("debug_disabled", "Задайте access_token в настройках аддона, чтобы включить API"));
      return false;
    }
    reply
      .code(401)
      .header("WWW-Authenticate", 'Bearer realm="pulsar-brain"')
      .send(errorBody("unauthorized", "Требуется Bearer-токен доступа"));
    return false;
  };

  app.get("/api/debug/diagnostics", async (request, reply): Promise<DiagnosticsResponse | FastifyReply> => {
    if (!guard(request, reply)) return reply;
    return buildDiagnostics({
      services: deps.services,
      startedAt: deps.startedAt,
      addonPort: deps.addonPort,
      hostname: deps.hostname,
      accessTokenConfigured: debugConfigured,
      discovery: deps.discovery(),
      stationName: deps.stationName(),
      integrationLastSeenAt: deps.integrationLastSeenAt(),
      log,
    });
  });

  app.post("/api/debug/rediscover", async (request, reply) => {
    if (!guard(request, reply)) return reply;
    const result = await deps.rediscover();
    log.info("debug: discovery re-announced", { ...result });
    return result;
  });

  app.post("/api/debug/probe", async (request, reply): Promise<ProbeResponse | FastifyReply> => {
    if (!guard(request, reply)) return reply;
    const body = request.body as Partial<ProbeRequest> | undefined;
    const host = typeof body?.host === "string" ? body.host.trim() : "";
    const port = typeof body?.port === "number" ? body.port : Number(body?.port);
    if (host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
      return reply.code(400).send(errorBody("validation_error", "Нужны host и port"));
    }
    const timeoutMs = typeof body?.timeoutMs === "number" ? Math.min(Math.max(body.timeoutMs, 100), 10_000) : 1500;
    return probe(host, port, timeoutMs);
  });

  app.post("/api/debug/autodetect", async (request, reply): Promise<AutodetectResponse | FastifyReply> => {
    if (!guard(request, reply)) return reply;
    return deps.autodetect();
  });

  app.get("/api/debug/ping", async (): Promise<{ ok: true }> => ({ ok: true }));
}

function bearerOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  return bearerFromAuthorization(typeof header === "string" ? header : undefined);
}

function hasTrustedIngress(request: FastifyRequest): boolean {
  const ingressPath = request.headers["x-ingress-path"];
  return (
    ingressPath !== undefined &&
    TRUSTED_INGRESS_ADDRESSES.has(request.socket.remoteAddress ?? "")
  );
}

function errorBody(code: string, message: string): ErrorResponse {
  return { error: { code, message } };
}
