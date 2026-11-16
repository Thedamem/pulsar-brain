const STORAGE_KEY = "pulsar-brain.ui.token";

export function readStoredToken(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storeToken(value: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage can be unavailable; callers keep the token in memory.
  }
}

export function clearStoredToken(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}

/** HA ingress may append ?token=; consume it once and keep the address clean. */
export function consumeUrlToken(): string | null {
  const url = new URL(window.location.href);
  const value = url.searchParams.get("token");
  if (!value) return null;
  const trimmed = value.trim();
  url.searchParams.delete("token");
  const search = url.searchParams.toString();
  window.history.replaceState(null, "", `${url.pathname}${search ? `?${search}` : ""}${url.hash}`);
  return trimmed.length > 0 ? trimmed : null;
}
