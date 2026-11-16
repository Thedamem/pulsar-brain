import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZodError } from "zod";
import { createConfigStore } from "../src/config/store.js";
import { DEFAULT_CONFIG, DEFAULT_SYSTEM_PROMPT } from "../src/config/schema.js";

const createdDirs: string[] = [];

async function newDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pulsar-config-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fileMode(path: string): Promise<number> {
  const info = await stat(path);
  return info.mode & 0o777;
}

describe("config defaults", () => {
  it("creates the documented defaults on first start", async () => {
    const dir = await newDataDir();
    const store = await createConfigStore({ dataDir: dir, env: {} });
    const config = store.get();

    expect(config.version).toBe(1);
    expect(config.logLevel).toBe("info");
    expect(config.provider.id).toBe("mock");
    expect(config.provider.openai.baseUrl).toBe("https://api.openai.com/v1");
    expect(config.provider.openai.model).toBe("gpt-4o-mini");
    expect(config.provider.openai.temperature).toBe(0.3);
    expect(config.provider.openai.maxTokens).toBe(800);

    expect(config.stt).toMatchObject({
      provider: "wyoming",
      host: "localhost",
      port: 10300,
      language: "ru",
      model: "auto",
    });
    expect(config.stt.endpointing).toEqual({
      silenceThresholdDb: -45,
      sentenceSilenceMs: 700,
      minSpeechMs: 200,
      maxUtteranceMs: 15000,
      preRollMs: 300,
    });

    expect(config.tts.mode).toBe("auto");
    expect(config.tts.piper).toEqual({ host: "localhost", port: 10200, voice: "ru_RU-irina-medium" });
    expect(config.tts.provider).toEqual({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      format: "wav",
      language: "ru",
    });
    expect(config.tts.outputSampleRate).toBe(16000);

    expect(config.conversation).toEqual({
      maxHistoryTurns: 8,
      followUpTimeoutMs: 8000,
      bargeIn: true,
      llmMaxToolIterations: 6,
      requestTimeoutMs: 30000,
    });

    expect(config.tools.ha).toEqual({ enabled: true, url: "", token: "" });
    expect(config.tools.scheduler).toEqual({ enabled: true, maxActive: 50, confirmBeforeSchedule: false });
    expect(config.tools.mcp.servers).toEqual([]);
    expect(config.aliases).toEqual({});

    expect(config.prompt.language).toBe("ru");
    expect(config.prompt.system).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(config.prompt.system).toContain("ассистент");
    expect(config.prompt.system.length).toBeGreaterThan(300);
  });

  it("writes config, master key and bridge token with restrictive permissions", async () => {
    const dir = await newDataDir();
    const store = await createConfigStore({ dataDir: dir, env: {} });

    expect(await fileMode(join(dir, "config.json"))).toBe(0o600);
    expect(await fileMode(join(dir, "master.key"))).toBe(0o600);
    expect(await fileMode(join(dir, "bridge-token.json"))).toBe(0o600);

    const token = store.bridgeToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const reopened = await createConfigStore({ dataDir: dir, env: {} });
    expect(reopened.bridgeToken()).toBe(token);
    expect(reopened.get()).toEqual(store.get());
    expect(reopened.get()).toEqual(DEFAULT_CONFIG);
  });

  it("rejects invalid config updates and keeps the previous value", async () => {
    const dir = await newDataDir();
    const store = await createConfigStore({ dataDir: dir, env: {} });
    const before = store.get();

    await expect(store.update({ provider: { openai: { temperature: 99 } } })).rejects.toBeInstanceOf(
      ZodError,
    );
    expect(store.get()).toEqual(before);
  });
});

describe("config deep merge and subscribers", () => {
  it("deep-merges nested updates without dropping sibling fields", async () => {
    const dir = await newDataDir();
    const store = await createConfigStore({ dataDir: dir, env: {} });

    const updated = await store.update({
      provider: { openai: { model: "gpt-5-mini" } },
      conversation: { maxHistoryTurns: 3 },
      aliases: { свет: "light.kitchen" },
    });
    expect(updated.provider.openai.model).toBe("gpt-5-mini");
    expect(updated.provider.openai.baseUrl).toBe("https://api.openai.com/v1");
    expect(updated.provider.openai.apiKey).toBe("");
    expect(updated.provider.id).toBe("mock");
    expect(updated.conversation.maxHistoryTurns).toBe(3);
    expect(updated.conversation.requestTimeoutMs).toBe(30000);
    expect(updated.aliases).toEqual({ свет: "light.kitchen" });

    await store.update({ aliases: { телевизор: "media_player.tv" } });
    expect(store.get().aliases).toEqual({ свет: "light.kitchen", телевизор: "media_player.tv" });

    const reopened = await createConfigStore({ dataDir: dir, env: {} });
    expect(reopened.get().provider.openai.model).toBe("gpt-5-mini");
    expect(reopened.get().conversation.maxHistoryTurns).toBe(3);
  });

  it("notifies subscribers and stops after unsubscribe", async () => {
    const dir = await newDataDir();
    const store = await createConfigStore({ dataDir: dir, env: {} });
    const seen: string[] = [];
    const unsubscribe = store.onChange((config) => seen.push(config.provider.openai.model));

    await store.update({ provider: { openai: { model: "first" } } });
    await store.update({ provider: { openai: { model: "second" } } });
    expect(seen).toEqual(["first", "second"]);

    unsubscribe();
    await store.update({ provider: { openai: { model: "third" } } });
    expect(seen).toEqual(["first", "second"]);
  });
});

describe("config secrets", () => {
  it("encrypts secrets on disk, decrypts transparently and masks API responses", async () => {
    const dir = await newDataDir();
    const store = await createConfigStore({ dataDir: dir, env: {} });
    await store.update({
      provider: {
        openai: { apiKey: "sk-test-123" },
        openclaw: { apiKey: "openclaw-key" },
        geminiLive: { apiKey: "gemini-key" },
      },
      tools: {
        ha: { token: "ha-secret-token" },
        mcp: {
          servers: [
            {
              id: "files",
              name: "Files",
              enabled: true,
              transport: "stdio",
              command: "npx",
              args: ["-y", "server"],
              url: "",
              headers: { Authorization: "Bearer secret-header" },
              toolTimeoutSec: 15,
            },
          ],
        },
      },
    });

    const config = store.get();
    expect(config.provider.openai.apiKey).toBe("sk-test-123");
    expect(config.provider.openclaw.apiKey).toBe("openclaw-key");
    expect(config.provider.geminiLive.apiKey).toBe("gemini-key");
    expect(config.tools.ha.token).toBe("ha-secret-token");
    expect(config.tools.mcp.servers[0]?.headers.Authorization).toBe("Bearer secret-header");

    const raw = await readFile(join(dir, "config.json"), "utf8");
    expect(raw).not.toContain("sk-test-123");
    expect(raw).not.toContain("openclaw-key");
    expect(raw).not.toContain("gemini-key");
    expect(raw).not.toContain("ha-secret-token");
    expect(raw).not.toContain("Bearer secret-header");
    expect(raw).toContain("enc:v1:");
    const stored = JSON.parse(raw) as {
      provider: { openai: { apiKey: string } };
      tools: { ha: { token: string }; mcp: { servers: Array<{ headers: Record<string, string> }> } };
    };
    expect(stored.provider.openai.apiKey.startsWith("enc:v1:")).toBe(true);
    expect(stored.tools.ha.token.startsWith("enc:v1:")).toBe(true);
    expect(stored.tools.mcp.servers[0]?.headers.Authorization?.startsWith("enc:v1:")).toBe(true);

    const masked = store.masked();
    expect(masked.provider.openai.apiKey).toBe("***");
    expect(masked.provider.openclaw.apiKey).toBe("***");
    expect(masked.provider.geminiLive.apiKey).toBe("***");
    expect(masked.tools.ha.token).toBe("***");
    expect(masked.tools.mcp.servers[0]?.headers.Authorization).toBe("***");

    const reopened = await createConfigStore({ dataDir: dir, env: {} });
    expect(reopened.get().provider.openai.apiKey).toBe("sk-test-123");
    expect(reopened.get().tools.ha.token).toBe("ha-secret-token");
    expect(reopened.get().tools.mcp.servers[0]?.headers.Authorization).toBe("Bearer secret-header");
  });

  it("keeps stored secrets when a masked config is saved back", async () => {
    const dir = await newDataDir();
    const store = await createConfigStore({ dataDir: dir, env: {} });
    await store.update({
      provider: { openai: { apiKey: "sk-keep-me" } },
      tools: { ha: { token: "ha-keep-me" } },
    });

    const masked = store.masked();
    await store.update({
      provider: { openai: { apiKey: masked.provider.openai.apiKey } },
      tools: { ha: { token: masked.tools.ha.token } },
    });
    expect(store.get().provider.openai.apiKey).toBe("sk-keep-me");
    expect(store.get().tools.ha.token).toBe("ha-keep-me");

    await store.update({ provider: { openai: { apiKey: "" } } });
    expect(store.get().provider.openai.apiKey).toBe("");
    expect(store.masked().provider.openai.apiKey).toBe("");
  });

  it("migrates version 0 files and re-encrypts legacy plaintext secrets", async () => {
    const dir = await newDataDir();
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({
        version: 0,
        logLevel: "debug",
        provider: { id: "openai", openai: { apiKey: "legacy-plain-key" } },
      }),
      { mode: 0o600 },
    );

    const store = await createConfigStore({ dataDir: dir, env: {} });
    const config = store.get();
    expect(config.version).toBe(1);
    expect(config.logLevel).toBe("debug");
    expect(config.provider.id).toBe("openai");
    expect(config.provider.openai.apiKey).toBe("legacy-plain-key");
    expect(config.provider.openai.model).toBe("gpt-4o-mini");

    const raw = await readFile(join(dir, "config.json"), "utf8");
    expect(raw).not.toContain("legacy-plain-key");
    expect(raw).toContain("enc:v1:");

    const reopened = await createConfigStore({ dataDir: dir, env: {} });
    expect(reopened.get().provider.openai.apiKey).toBe("legacy-plain-key");
  });

  it("falls back to defaults with a warning for a corrupted config file", async () => {
    const dir = await newDataDir();
    await writeFile(join(dir, "config.json"), "{ this is not json", { mode: 0o600 });
    const store = await createConfigStore({ dataDir: dir, env: {} });
    expect(store.get()).toEqual(DEFAULT_CONFIG);
    expect(store.warnings().length).toBeGreaterThan(0);
    expect(store.warnings().join(" ")).toContain("повреждён");
  });

  it("falls back to defaults with a warning for a schema-invalid config file", async () => {
    const dir = await newDataDir();
    await writeFile(join(dir, "config.json"), JSON.stringify({ logLevel: "verbose" }), { mode: 0o600 });
    const store = await createConfigStore({ dataDir: dir, env: {} });
    expect(store.get()).toEqual(DEFAULT_CONFIG);
    expect(store.warnings().join(" ")).toContain("не соответствует схеме");
  });
});

describe("config env overrides", () => {
  it("applies dev overrides without persisting them", async () => {
    const dir = await newDataDir();
    const store = await createConfigStore({
      dataDir: dir,
      env: {
        PULSAR_BRAIN_HA_URL: "http://127.0.0.1:8124",
        PULSAR_BRAIN_HA_TOKEN: "env-ha-token",
        PULSAR_BRAIN_STT_HOST: "whisper.local",
        PULSAR_BRAIN_STT_PORT: "10399",
        PULSAR_BRAIN_TTS_HOST: "piper.local",
        PULSAR_BRAIN_TTS_PORT: "10299",
        PULSAR_BRAIN_PROVIDER_ID: "openai",
        PULSAR_BRAIN_MOCK: "1",
      },
    });

    const config = store.get();
    expect(config.provider.id).toBe("mock");
    expect(config.tools.ha.url).toBe("http://127.0.0.1:8124");
    expect(config.tools.ha.token).toBe("env-ha-token");
    expect(config.stt.host).toBe("whisper.local");
    expect(config.stt.port).toBe(10399);
    expect(config.tts.piper.host).toBe("piper.local");
    expect(config.tts.piper.port).toBe(10299);

    await store.update({ tools: { ha: { url: "http://persisted" } } });
    expect(store.get().tools.ha.url).toBe("http://127.0.0.1:8124");

    const withoutEnv = await createConfigStore({ dataDir: dir, env: {} });
    expect(withoutEnv.get().tools.ha.url).toBe("http://persisted");
    expect(withoutEnv.get().provider.id).toBe("mock");
  });

  it("warns about invalid port overrides and keeps defaults", async () => {
    const dir = await newDataDir();
    const store = await createConfigStore({
      dataDir: dir,
      env: { PULSAR_BRAIN_STT_PORT: "not-a-port" },
    });
    expect(store.get().stt.port).toBe(10300);
    expect(store.warnings().join(" ")).toContain("не является номером порта");
  });

  it("uses the bridge token from env when set", async () => {
    const dir = await newDataDir();
    const store = await createConfigStore({
      dataDir: dir,
      env: { PULSAR_BRAIN_BRIDGE_TOKEN: "env-bridge-token" },
    });
    expect(store.bridgeToken()).toBe("env-bridge-token");

    const tokenFile = JSON.parse(await readFile(join(dir, "bridge-token.json"), "utf8")) as {
      token: string;
    };
    expect(tokenFile.token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenFile.token).not.toBe("env-bridge-token");
  });
});
