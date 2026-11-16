/**
 * Bearer auth helpers shared by the HTTP API and the bridge WS upgrade.
 * Tokens are compared in constant time to avoid leaking a prefix through timing.
 */

import { timingSafeEqual } from "node:crypto";

const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;

export function bearerFromAuthorization(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = BEARER_RE.exec(value.trim());
  return match?.[1] ?? null;
}

export function tokensEqual(expected: string, actual: string): boolean {
  if (expected.length === 0) return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function matchesAnyToken(actual: string, expected: readonly string[]): boolean {
  for (const token of expected) {
    if (tokensEqual(token, actual)) return true;
  }
  return false;
}

/** Reads ?token=... from a raw request URL; used by SSE/EventSource clients that cannot set headers. */
export function tokenFromQuery(rawUrl: string | undefined): string | null {
  if (rawUrl === undefined) return null;
  try {
    const url = new URL(rawUrl, "http://localhost");
    const token = url.searchParams.get("token");
    return token !== null && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}
