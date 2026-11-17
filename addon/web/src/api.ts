import type {
  ConfigResponse,
  HaEntitiesResponse,
  LogsResponse,
  McpServersResponse,
  McpToolsResponse,
  ModelsResponse,
  PromptResponse,
  ProviderInfoResponse,
  SchedulesResponse,
  SessionsResponse,
  SetStationRequest,
  StationsResponse,
  StatusResponse,
  TestAudioResponse,
  TestTextResponse,
  VoicesResponse,
} from "../../src/shared/protocol";
import type {
  LogEntry,
  McpServerConfig,
  ProviderHealth,
  SessionRecord,
} from "../../src/shared/types";
import type { ErrorResponse } from "../../src/shared/protocol";
import { clearStoredToken, readStoredToken, storeToken } from "./auth";
import { BASE_PATH } from "./router";

let token = readStoredToken().trim();
let unauthorizedHandler: (() => void) | null = null;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function getToken(): string {
  return token;
}

export function setToken(next: string): void {
  token = next.trim();
  storeToken(token);
}

export function clearToken(): void {
  token = "";
  clearStoredToken();
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

/** Same-origin API path, prefixed when the UI is mounted under the HA ingress path. */
function apiUrl(path: string): string {
  if (!path.startsWith("/")) return path;
  return `${BASE_PATH}${path.slice(1)}`;
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Неизвестная ошибка";
}

function isErrorResponse(value: unknown): value is ErrorResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { error?: unknown };
  if (typeof candidate.error !== "object" || candidate.error === null) return false;
  const inner = candidate.error as { code?: unknown; message?: unknown };
  return typeof inner.code === "string" && typeof inner.message === "string";
}

function networkError(): ApiError {
  return new ApiError(0, "network", "Сервер не отвечает. Проверьте, что аддон запущен.");
}

async function readErrorResponse(response: Response): Promise<ApiError> {
  let message = `Сервер вернул ошибку ${response.status}.`;
  let code = "http_error";
  try {
    const payload: unknown = await response.json();
    if (isErrorResponse(payload)) {
      message = payload.error.message;
      code = payload.error.code;
    }
  } catch {
    // Non-JSON error bodies keep the status-based message.
  }
  return new ApiError(response.status, code, message);
}

async function request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(apiUrl(path), { ...init, headers, signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw networkError();
  }

  if (response.status === 401) {
    unauthorizedHandler?.();
    throw new ApiError(401, "unauthorized", "Требуется вход по токену.");
  }
  if (!response.ok) throw await readErrorResponse(response);
  return response;
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (text.length === 0) return undefined as T;
  return JSON.parse(text) as T;
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await request(path, { method: "GET" }, signal);
  return parseJson<T>(response);
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const response = await request(path, {
    method: "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseJson<T>(response);
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const response = await request(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseJson<T>(response);
}

export async function apiDelete<T>(path: string): Promise<T> {
  const response = await request(path, { method: "DELETE" });
  return parseJson<T>(response);
}

export async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  const response = await request(path, { method: "POST", body: form });
  return parseJson<T>(response);
}

export async function apiPostBlob(path: string, body: unknown): Promise<Blob> {
  const response = await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "audio/wav" },
    body: JSON.stringify(body),
  });
  return response.blob();
}

export async function checkToken(candidate: string): Promise<StatusResponse> {
  const headers = new Headers();
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${candidate}`);
  let response: Response;
  try {
    response = await fetch(apiUrl("/api/status"), { method: "GET", headers });
  } catch {
    throw networkError();
  }
  if (response.status === 401) {
    throw new ApiError(401, "unauthorized", "Токен не подошёл. Проверьте значение и попробуйте снова.");
  }
  if (!response.ok) throw await readErrorResponse(response);
  return parseJson<StatusResponse>(response);
}

// ───────────────────────────────────────────────────────────── endpoints ──

export const api = {
  status: (signal?: AbortSignal) => apiGet<StatusResponse>("/api/status", signal),
  config: (signal?: AbortSignal) => apiGet<ConfigResponse>("/api/config", signal),
  saveConfig: (patch: unknown) => apiPut<ConfigResponse>("/api/config", patch),
  providers: (signal?: AbortSignal) => apiGet<ProviderInfoResponse>("/api/providers", signal),
  testProvider: (id: string) => apiPost<ProviderHealth>(`/api/providers/${encodeURIComponent(id)}/test`),
  models: (id: string, signal?: AbortSignal) =>
    apiGet<ModelsResponse>(`/api/providers/${encodeURIComponent(id)}/models`, signal),
  prompt: (signal?: AbortSignal) => apiGet<PromptResponse>("/api/prompt", signal),
  promptDefaults: (signal?: AbortSignal) => apiGet<unknown>("/api/prompt/defaults", signal),
  voices: (signal?: AbortSignal) => apiGet<VoicesResponse>("/api/tts/voices", signal),
  ttsPreview: (text: string, voice: string) => apiPostBlob("/api/tts/preview", { text, voice }),
  testText: (text: string) => apiPost<TestTextResponse>("/api/test/text", { text }),
  testAudio: (file: File) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return apiPostForm<TestAudioResponse>("/api/test/audio", form);
  },
  sessions: (limit: number, signal?: AbortSignal) =>
    apiGet<SessionsResponse>(`/api/sessions?limit=${limit}`, signal),
  session: (id: string, signal?: AbortSignal) =>
    apiGet<SessionRecord>(`/api/sessions/${encodeURIComponent(id)}`, signal),
  logs: (after: number, signal?: AbortSignal) =>
    apiGet<LogsResponse>(`/api/logs?after=${after}`, signal),
  mcpServers: (signal?: AbortSignal) => apiGet<McpServersResponse>("/api/mcp/servers", signal),
  mcpTools: (signal?: AbortSignal) => apiGet<McpToolsResponse>("/api/mcp/tools", signal),
  createMcpServer: (server: McpServerConfig) =>
    apiPost<McpServersResponse>("/api/mcp/servers", server),
  updateMcpServer: (id: string, server: McpServerConfig) =>
    apiPut<McpServersResponse>(`/api/mcp/servers/${encodeURIComponent(id)}`, server),
  deleteMcpServer: (id: string) =>
    apiDelete<McpServersResponse>(`/api/mcp/servers/${encodeURIComponent(id)}`),
  testMcpServer: (id: string) =>
    apiPost<ProviderHealth>(`/api/mcp/servers/${encodeURIComponent(id)}/test`),
  schedules: (signal?: AbortSignal) => apiGet<SchedulesResponse>("/api/schedules", signal),
  runSchedule: (id: string) =>
    apiPost<RunNowResponse>(`/api/schedules/${encodeURIComponent(id)}/run-now`),
  cancelSchedule: (id: string) =>
    apiPost<unknown>(`/api/schedules/${encodeURIComponent(id)}/cancel`),
  haEntities: (signal?: AbortSignal) => apiGet<HaEntitiesResponse>("/api/ha/entities", signal),
  stations: (signal?: AbortSignal) => apiGet<StationsResponse>("/api/stations", signal),
  bindStation: (request: SetStationRequest) => apiPost<unknown>("/api/station", request),
  clearStation: () => apiDelete<unknown>("/api/station"),
};

export interface RunNowResponse {
  ok?: boolean;
  error?: string;
}

export type LogStreamState = "connecting" | "open" | "retrying" | "error";

interface ParsedPromptDefaults {
  system: string;
  language: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parsePromptDefaults(payload: unknown): ParsedPromptDefaults | null {
  if (!isRecord(payload)) return null;
  const directSystem = payload["system"];
  const directLanguage = payload["language"];
  if (typeof directSystem === "string" && typeof directLanguage === "string") {
    return { system: directSystem, language: directLanguage };
  }
  const nested = payload["defaults"];
  if (isRecord(nested)) {
    const system = nested["system"];
    const language = nested["language"];
    if (typeof system === "string" && typeof language === "string") return { system, language };
  }
  return null;
}

/**
 * Reads the log SSE endpoint with fetch: EventSource cannot attach the bearer header.
 * Reconnects with a short delay until the returned function is called.
 */
export function openLogStream(
  onEntries: (entries: LogEntry[]) => void,
  onState: (state: LogStreamState, error?: string) => void,
): () => void {
  const controller = new AbortController();
  let retryTimer: number | null = null;

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        resolve();
      }, ms);
    });

  const handleFrame = (frame: string, batch: LogEntry[]) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    try {
      const parsed: unknown = JSON.parse(data);
      if (isRecord(parsed) && typeof parsed["seq"] === "number" && typeof parsed["msg"] === "string") {
        batch.push(parsed as unknown as LogEntry);
      }
    } catch {
      // Ignore keep-alive or malformed frames instead of tearing down the stream.
    }
  };

  const run = async () => {
    while (!controller.signal.aborted) {
      try {
        onState("connecting");
        const headers = new Headers();
        headers.set("Accept", "text/event-stream");
        if (token) headers.set("Authorization", `Bearer ${token}`);
        const response = await fetch(apiUrl("/api/logs/stream"), {
          headers,
          signal: controller.signal,
        });

        if (response.status === 401) {
          unauthorizedHandler?.();
          throw new ApiError(401, "unauthorized", "Требуется вход по токену.");
        }
        if (!response.ok) throw await readErrorResponse(response);
        if (!response.body) throw new ApiError(0, "no_body", "Поток логов недоступен.");

        onState("open");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? "";
          const batch: LogEntry[] = [];
          for (const frame of frames) handleFrame(frame, batch);
          if (batch.length > 0) onEntries(batch);
        }

        if (!controller.signal.aborted) {
          onState("retrying", "Поток закрылся. Переподключаюсь.");
          await wait(2000);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          onState("error", error.message);
          return;
        }
        if (error instanceof DOMException && error.name === "AbortError") return;
        onState("retrying", errorText(error));
        await wait(3000);
      }
    }
  };

  void run();

  return () => {
    controller.abort();
    if (retryTimer !== null) window.clearTimeout(retryTimer);
  };
}
