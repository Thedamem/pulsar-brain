/**
 * Persistent configuration store.
 *
 * Layout of the data directory:
 *   config.json       AppConfig with secrets encrypted as "enc:v1:..." (mode 0600)
 *   master.key        AES-256-GCM key, generated on first start (mode 0600)
 *   bridge-token.json bridge bearer token, generated on first start (mode 0600)
 *
 * Secrets are encrypted on disk and decrypted transparently by get(). Env variables
 * override the effective config without being persisted (development outside Supervisor).
 * Updates are serialized, validated with zod and written atomically (temp file + rename).
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  AppConfig,
  ConfigStoreLike,
  McpServerConfig,
  ProviderId,
} from "../shared/types.js";
import {
  createSecretCipher,
  isMasked,
  maskSecret,
  maskSecretRecord,
  type SecretCipher,
} from "../secrets/crypto.js";
import { AppConfigSchema, DEFAULT_CONFIG } from "./schema.js";

const CONFIG_FILE = "config.json";
const BRIDGE_TOKEN_FILE = "bridge-token.json";
const CURRENT_CONFIG_VERSION = 1;
const BRIDGE_TOKEN_BYTES = 32;
const MAX_WARNINGS = 50;

/**
 * Recursive partial config patch. shared/types.ts DeepPartial stops recursing into
 * interfaces (conditional types see no index signature), so this module defines its
 * own patch type: objects are optional all the way down, arrays replace as a whole.
 */
type DeepPatch<T> = {
  [K in keyof T]?:
    | (T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPatch<T[K]> : T[K])
    | undefined;
};

export type ConfigPatch = DeepPatch<AppConfig>;

export interface ConfigStore extends ConfigStoreLike {
  /** Recursive partial update (shared DeepPartial stops at interface boundaries). */
  update(patch: ConfigPatch): Promise<AppConfig>;
  readonly dataDir: string;
  readonly configFile: string;
  readonly bridgeTokenFile: string;
  /** Non-fatal load problems (corrupted file, undecryptable secret, invalid env override). */
  warnings(): string[];
}

export interface ConfigStoreOptions {
  /** Data directory; defaults to PULSAR_BRAIN_DATA_DIR or ./data. */
  dataDir?: string;
  /** Environment source; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Cipher override for tests. */
  cipher?: SecretCipher;
}

export async function createConfigStore(options: ConfigStoreOptions = {}): Promise<ConfigStore> {
  const env = options.env ?? process.env;
  const dataDir = resolve(options.dataDir ?? env.PULSAR_BRAIN_DATA_DIR ?? "./data");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const cipher = options.cipher ?? createSecretCipher(dataDir);
  const warnings: string[] = [];

  const configFile = join(dataDir, CONFIG_FILE);
  const bridgeTokenFile = join(dataDir, BRIDGE_TOKEN_FILE);

  const loaded = await loadConfig(configFile, cipher, warnings);
  let base = loaded.config;
  if (loaded.needsPersist) {
    await writeConfig(configFile, cipher, base);
  }

  const token = await loadOrCreateBridgeToken(bridgeTokenFile, warnings);
  const listeners = new Set<(config: AppConfig) => void>();

  const warn = (message: string): void => {
    if (warnings.length >= MAX_WARNINGS) warnings.shift();
    warnings.push(message);
  };

  const effective = (): AppConfig => applyEnvOverrides(base, env, warn);

  const notify = (config: AppConfig): void => {
    for (const listener of listeners) {
      try {
        listener(config);
      } catch (err) {
        warn(`Подписчик конфигурации завершился с ошибкой: ${(err as Error).message}`);
      }
    }
  };

  // Updates run one at a time: read-modify-write must not interleave.
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation, operation);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    dataDir,
    configFile,
    bridgeTokenFile,
    get(): AppConfig {
      return effective();
    },
    async update(patch: ConfigPatch): Promise<AppConfig> {
      return serialize(async () => {
        const sanitized = stripMaskedSecrets(patch);
        const merged = mergeConfig(base, sanitized);
        base = merged;
        await writeConfig(configFile, cipher, merged);
        const next = applyEnvOverrides(merged, env, warn);
        notify(next);
        return next;
      });
    },
    masked(): AppConfig {
      return maskSecrets(effective());
    },
    onChange(listener: (config: AppConfig) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    bridgeToken(): string {
      const envToken = env.PULSAR_BRAIN_BRIDGE_TOKEN?.trim();
      return envToken && envToken.length > 0 ? envToken : token;
    },
    warnings(): string[] {
      return [...warnings];
    },
  };
}

// ─────────────────────────────────────────────────────────────── loading ──

interface LoadedConfig {
  config: AppConfig;
  /** True when first run or version migration requires writing the file back. */
  needsPersist: boolean;
}

async function loadConfig(
  configFile: string,
  cipher: SecretCipher,
  warnings: string[],
): Promise<LoadedConfig> {
  const text = await readTextFile(configFile);
  if (text === null) {
    return { config: structuredClone(DEFAULT_CONFIG), needsPersist: true };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    warnings.push(
      `Файл ${CONFIG_FILE} повреждён (${(err as Error).message}); используются значения по умолчанию.`,
    );
    return { config: structuredClone(DEFAULT_CONFIG), needsPersist: false };
  }
  const rawVersion = readVersion(raw);
  const migrated = migrateConfig(raw);
  const parsed = AppConfigSchema.safeParse(migrated);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .slice(0, 5)
      .map((issue) => issue.path.join(".") || "(root)")
      .join(", ");
    warnings.push(
      `Файл ${CONFIG_FILE} не соответствует схеме (${fields}); используются значения по умолчанию.`,
    );
    return { config: structuredClone(DEFAULT_CONFIG), needsPersist: false };
  }
  const config = decryptSecrets(parsed.data, cipher, warnings);
  return { config, needsPersist: rawVersion < CURRENT_CONFIG_VERSION };
}

function readVersion(raw: unknown): number {
  if (isRecord(raw) && typeof raw.version === "number" && Number.isInteger(raw.version)) {
    return raw.version;
  }
  return 0;
}

type Migration = (config: Record<string, unknown>) => void;

/**
 * Version migrations run before schema validation; schema defaults fill fields added
 * by newer versions. Only version 1 exists today, so the table documents the pattern
 * and normalizes a missing/invalid version field.
 */
const MIGRATIONS: Record<number, Migration> = {
  1: (config) => {
    config.version = 1;
  },
};

function migrateConfig(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const migrated: Record<string, unknown> = { ...raw };
  let version = readVersion(raw);
  while (version < CURRENT_CONFIG_VERSION) {
    const next = MIGRATIONS[version + 1];
    if (next === undefined) break;
    next(migrated);
    version += 1;
  }
  return migrated;
}

// ────────────────────────────────────────────────────────────── secrets ──

function decryptSecrets(config: AppConfig, cipher: SecretCipher, warnings: string[]): AppConfig {
  const decrypted: AppConfig = structuredClone(config);
  const safe = (value: string, field: string): string => {
    try {
      return cipher.decrypt(value);
    } catch (err) {
      warnings.push(`Не удалось расшифровать секрет ${field}: ${(err as Error).message}`);
      return "";
    }
  };
  decrypted.provider.openai.apiKey = safe(config.provider.openai.apiKey, "provider.openai.apiKey");
  decrypted.provider.openclaw.apiKey = safe(config.provider.openclaw.apiKey, "provider.openclaw.apiKey");
  decrypted.provider.geminiLive.apiKey = safe(
    config.provider.geminiLive.apiKey,
    "provider.geminiLive.apiKey",
  );
  decrypted.tools.ha.token = safe(config.tools.ha.token, "tools.ha.token");
  decrypted.tools.mcp.servers = config.tools.mcp.servers.map((server) => ({
    ...server,
    headers: decryptHeaders(server.headers, cipher, `tools.mcp.servers[${server.id}].headers`, warnings),
  }));
  return decrypted;
}

function decryptHeaders(
  headers: Record<string, string>,
  cipher: SecretCipher,
  field: string,
  warnings: string[],
): Record<string, string> {
  const decrypted: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    try {
      decrypted[name] = cipher.decrypt(value);
    } catch (err) {
      warnings.push(`Не удалось расшифровать заголовок ${field}.${name}: ${(err as Error).message}`);
    }
  }
  return decrypted;
}

function encryptSecrets(config: AppConfig, cipher: SecretCipher): AppConfig {
  const encrypted: AppConfig = structuredClone(config);
  encrypted.provider.openai.apiKey = cipher.encrypt(encrypted.provider.openai.apiKey);
  encrypted.provider.openclaw.apiKey = cipher.encrypt(encrypted.provider.openclaw.apiKey);
  encrypted.provider.geminiLive.apiKey = cipher.encrypt(encrypted.provider.geminiLive.apiKey);
  encrypted.tools.ha.token = cipher.encrypt(encrypted.tools.ha.token);
  encrypted.tools.mcp.servers = encrypted.tools.mcp.servers.map((server) => ({
    ...server,
    headers: encryptHeaders(server.headers, cipher),
  }));
  return encrypted;
}

function encryptHeaders(
  headers: Record<string, string>,
  cipher: SecretCipher,
): Record<string, string> {
  const encrypted: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) encrypted[name] = cipher.encrypt(value);
  return encrypted;
}

function maskSecrets(config: AppConfig): AppConfig {
  const masked: AppConfig = structuredClone(config);
  masked.provider.openai.apiKey = maskSecret(masked.provider.openai.apiKey);
  masked.provider.openclaw.apiKey = maskSecret(masked.provider.openclaw.apiKey);
  masked.provider.geminiLive.apiKey = maskSecret(masked.provider.geminiLive.apiKey);
  masked.tools.ha.token = maskSecret(masked.tools.ha.token);
  masked.tools.mcp.servers = masked.tools.mcp.servers.map((server) => ({
    ...server,
    headers: maskSecretRecord(server.headers),
  }));
  return masked;
}

/** Drops "***" placeholders from a patch so a masked config can be PUT back unchanged. */
function stripMaskedSecrets(patch: ConfigPatch): ConfigPatch {
  const cleaned: ConfigPatch = structuredClone(patch);
  if (cleaned.provider?.openai && isMaskedValue(cleaned.provider.openai.apiKey)) {
    delete cleaned.provider.openai.apiKey;
  }
  if (cleaned.provider?.openclaw && isMaskedValue(cleaned.provider.openclaw.apiKey)) {
    delete cleaned.provider.openclaw.apiKey;
  }
  if (cleaned.provider?.geminiLive && isMaskedValue(cleaned.provider.geminiLive.apiKey)) {
    delete cleaned.provider.geminiLive.apiKey;
  }
  if (cleaned.tools?.ha && isMaskedValue(cleaned.tools.ha.token)) {
    delete cleaned.tools.ha.token;
  }
  if (cleaned.tools?.mcp?.servers) {
    cleaned.tools.mcp.servers = cleaned.tools.mcp.servers.map((server) => ({
      ...server,
      headers: stripMaskedHeaders(server.headers),
    }));
  }
  return cleaned;
}

function isMaskedValue(value: string | undefined): boolean {
  return typeof value === "string" && isMasked(value);
}

function stripMaskedHeaders(headers: Record<string, string>): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!isMasked(value)) cleaned[name] = value;
  }
  return cleaned;
}

// ────────────────────────────────────────────────────────────── merge ──

function mergeConfig(base: AppConfig, patch: ConfigPatch): AppConfig {
  const merged = mergeDeep(base, patch);
  if (!isRecord(merged)) {
    throw new Error("Configuration patch produced a non-object value");
  }
  const typed = merged as unknown as AppConfig;
  if (patch.tools?.mcp?.servers !== undefined) {
    typed.tools.mcp.servers = mergeMcpServers(base.tools.mcp.servers, patch.tools.mcp.servers);
  }
  return AppConfigSchema.parse(typed);
}

/** Deep-merges plain objects; arrays and primitives replace the previous value. */
function mergeDeep(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (isRecord(base) && isRecord(patch)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      merged[key] = mergeDeep(base[key], value);
    }
    return merged;
  }
  return patch;
}

/**
 * The servers array in a patch replaces the stored list (so removals work), while
 * per-id merge preserves secrets hidden behind "***" placeholders from the UI.
 */
function mergeMcpServers(base: McpServerConfig[], patch: McpServerConfig[]): McpServerConfig[] {
  const byId = new Map(base.map((server) => [server.id, server] as const));
  return patch.map((server) => {
    const existing = byId.get(server.id);
    if (existing === undefined) return server;
    return { ...existing, ...server, headers: { ...existing.headers, ...server.headers } };
  });
}

// ────────────────────────────────────────────────────────── env overrides ──

const PROVIDER_IDS: ReadonlySet<string> = new Set(["openai", "openclaw", "gemini-live", "mock"]);

/**
 * Dev overrides (outside Supervisor). Applied to the effective config only; updates and
 * the config file stay untouched, so removing the variable restores persisted values.
 */
function applyEnvOverrides(
  config: AppConfig,
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
): AppConfig {
  const overridden: AppConfig = structuredClone(config);
  const haUrl = env.PULSAR_BRAIN_HA_URL?.trim();
  if (haUrl) overridden.tools.ha.url = haUrl;
  const haToken = env.PULSAR_BRAIN_HA_TOKEN?.trim();
  if (haToken) overridden.tools.ha.token = haToken;
  const sttHost = env.PULSAR_BRAIN_STT_HOST?.trim();
  if (sttHost) overridden.stt.host = sttHost;
  const sttPort = parsePort(env.PULSAR_BRAIN_STT_PORT, "PULSAR_BRAIN_STT_PORT", warn);
  if (sttPort !== undefined) overridden.stt.port = sttPort;
  const ttsHost = env.PULSAR_BRAIN_TTS_HOST?.trim();
  if (ttsHost) overridden.tts.piper.host = ttsHost;
  const ttsPort = parsePort(env.PULSAR_BRAIN_TTS_PORT, "PULSAR_BRAIN_TTS_PORT", warn);
  if (ttsPort !== undefined) overridden.tts.piper.port = ttsPort;
  const providerId = env.PULSAR_BRAIN_PROVIDER_ID?.trim();
  if (providerId) {
    if (PROVIDER_IDS.has(providerId)) {
      overridden.provider.id = providerId as ProviderId;
    } else {
      warn(`PULSAR_BRAIN_PROVIDER_ID="${providerId}" не распознан; используется ${overridden.provider.id}.`);
    }
  }
  if (env.PULSAR_BRAIN_MOCK === "1") overridden.provider.id = "mock";
  return overridden;
}

function parsePort(value: string | undefined, name: string, warn: (message: string) => void): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    warn(`${name}="${trimmed}" не является номером порта; значение проигнорировано.`);
    return undefined;
  }
  return port;
}

// ───────────────────────────────────────────────────────── file handling ──

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeConfig(configFile: string, cipher: SecretCipher, config: AppConfig): Promise<void> {
  const encrypted = encryptSecrets(config, cipher);
  const serialized = `${JSON.stringify(encrypted, null, 2)}\n`;
  const tempFile = `${configFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempFile, serialized, { mode: 0o600 });
    await rename(tempFile, configFile);
  } finally {
    await rm(tempFile, { force: true });
  }
}

interface BridgeTokenFile {
  token: string;
  createdAt: string;
}

async function loadOrCreateBridgeToken(
  bridgeTokenFile: string,
  warnings: string[],
): Promise<string> {
  const text = await readTextFile(bridgeTokenFile);
  if (text !== null) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && typeof parsed.token === "string" && parsed.token.trim().length > 0) {
        return parsed.token.trim();
      }
      warnings.push(`Файл ${BRIDGE_TOKEN_FILE} не содержит token; токен моста перегенерирован.`);
    } catch (err) {
      warnings.push(
        `Файл ${BRIDGE_TOKEN_FILE} повреждён (${(err as Error).message}); токен моста перегенерирован.`,
      );
    }
  }
  const token = randomBytes(BRIDGE_TOKEN_BYTES).toString("hex");
  const payload: BridgeTokenFile = { token, createdAt: new Date().toISOString() };
  await writeFile(bridgeTokenFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return token;
}

// ───────────────────────────────────────────────────────────────── helpers ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
