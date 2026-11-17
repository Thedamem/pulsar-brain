/**
 * Supervisor discovery for the addon (docs/contracts.md §8.1).
 *
 * When the addon runs under Home Assistant, Supervisor exposes how HA can reach it: GET
 * /addons/self/info returns the container hostname on the hassio network. The addon then POSTs
 * /discovery with its host, port, bridge token and version, and the pulsar_brain integration
 * creates its config entry without asking the user for any of those values.
 *
 * Outside Supervisor (dev stand) there is no SUPERVISOR_TOKEN and discovery is skipped.
 * The bridge token is sent in the discovery payload, never written to the logs.
 */

import type { LoggerLike } from "../shared/types.js";

const SUPERVISOR_BASE = "http://supervisor";
const SELF_INFO_URL = `${SUPERVISOR_BASE}/addons/self/info`;
const DISCOVERY_URL = `${SUPERVISOR_BASE}/discovery`;
const DISCOVERY_SERVICE = "pulsar_brain";
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_HOST_LENGTH = 255;

export interface DiscoveryDeps {
  log: LoggerLike;
  bridgeToken: string;
  version: string;
  addonPort: number;
  /** SUPERVISOR_TOKEN; empty or absent outside the Supervisor. */
  supervisorToken?: string;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Delays before each retry; defaults to 1/2/4 s, so three retries after the first attempt. */
  retryDelaysMs?: readonly number[];
}

export type DiscoveryResult =
  | { announced: true; host: string }
  | { announced: false; reason: "not_supervisor" | "discovery_failed" };

interface FailedRequest {
  ok: false;
  status: number;
}

interface SuccessfulRequest {
  ok: true;
  response: Response;
}

type RequestOutcome = SuccessfulRequest | FailedRequest;

export async function announceAddonDiscovery(deps: DiscoveryDeps): Promise<DiscoveryResult> {
  const token = (deps.supervisorToken ?? "").trim();
  const log = deps.log.child("discovery");
  if (token === "") {
    log.debug("supervisor token is not set, discovery skipped");
    return { announced: false, reason: "not_supervisor" };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const retryDelays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const host = await resolveHost(fetchImpl, token, retryDelays, log);
  const payload = {
    service: DISCOVERY_SERVICE,
    config: {
      host,
      port: deps.addonPort,
      bridge_token: deps.bridgeToken,
      version: deps.version,
    },
  };

  const outcome = await requestWithRetry(
    fetchImpl,
    DISCOVERY_URL,
    {
      method: "POST",
      headers: buildHeaders(token, true),
      body: JSON.stringify(payload),
    },
    retryDelays,
    log,
    "discovery announce",
  );
  if (!outcome.ok) {
    // Never log the payload or response body: both may contain the bridge token.
    log.error("supervisor discovery failed", { status: outcome.status });
    return { announced: false, reason: "discovery_failed" };
  }

  log.info("addon announced to supervisor discovery", { host, port: deps.addonPort });
  return { announced: true, host };
}

async function resolveHost(
  fetchImpl: typeof fetch,
  token: string,
  retryDelays: readonly number[],
  log: LoggerLike,
): Promise<string> {
  const outcome = await requestWithRetry(
    fetchImpl,
    SELF_INFO_URL,
    { method: "GET", headers: buildHeaders(token, false) },
    retryDelays,
    log,
    "supervisor self info",
  );
  if (!outcome.ok) {
    log.warn("supervisor self info is unavailable, using the fallback hostname", {
      status: outcome.status,
    });
    return fallbackHost();
  }

  let text: string;
  try {
    text = await outcome.response.text();
  } catch (err) {
    log.warn("supervisor self info body is unreadable, using the fallback hostname", {
      error: errorText(err),
    });
    return fallbackHost();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    log.warn("supervisor self info is not JSON, using the fallback hostname", {
      error: errorText(err),
    });
    return fallbackHost();
  }

  const host = hostnameFromSelfInfo(raw);
  if (host === null) {
    log.warn("supervisor self info has no hostname, using the fallback hostname");
    return fallbackHost();
  }
  return host;
}

async function requestWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  retryDelays: readonly number[],
  log: LoggerLike,
  label: string,
): Promise<RequestOutcome> {
  const attempts = retryDelays.length + 1;
  let lastStatus = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response;
    try {
      // A fresh signal per attempt: one overall timeout would already be expired on a retry.
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      lastStatus = 0;
      if (attempt < attempts) {
        log.warn("supervisor request failed, retrying", {
          label,
          attempt,
          error: errorText(err),
        });
        await sleep(retryDelay(retryDelays, attempt));
        continue;
      }
      log.warn("supervisor request failed", { label, attempt, error: errorText(err) });
      break;
    }

    if (response.ok) return { ok: true, response };

    lastStatus = response.status;
    await discardBody(response, log);
    if (response.status < 500) {
      log.warn("supervisor request was rejected", { label, status: response.status });
      break;
    }
    if (attempt < attempts) {
      log.warn("supervisor request returned a server error, retrying", {
        label,
        attempt,
        status: response.status,
      });
      await sleep(retryDelay(retryDelays, attempt));
    }
  }

  return { ok: false, status: lastStatus };
}

/** The Supervisor response nests data: {result:"ok", data:{hostname:"..."}}. */
function hostnameFromSelfInfo(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const nested = raw.data;
  const candidate = isRecord(nested) ? nested.hostname : raw.hostname;
  if (typeof candidate !== "string") return null;
  const host = candidate.trim().slice(0, MAX_HOST_LENGTH);
  return host.length > 0 ? host : null;
}

function fallbackHost(): string {
  const envHost = process.env.HOSTNAME?.trim();
  if (envHost !== undefined && envHost.length > 0) return envHost;
  return "pulsar_brain";
}

function buildHeaders(token: string, withJsonBody: boolean): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(withJsonBody ? { "Content-Type": "application/json" } : {}),
  };
}

function retryDelay(delays: readonly number[], attempt: number): number {
  const delay = delays[attempt - 1] ?? 0;
  return delay > 0 ? delay : 0;
}

async function discardBody(response: Response, log: LoggerLike): Promise<void> {
  try {
    await response.text();
  } catch (err) {
    log.debug("supervisor error body is unreadable", { error: errorText(err) });
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
