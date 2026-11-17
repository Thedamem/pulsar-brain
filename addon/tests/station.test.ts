import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AppConfig,
  ConfigStoreLike,
  HaCallServiceRequest,
  HaClientLike,
  HaEntity,
  HaArea,
  HaState,
  LogEntry,
  LogLevel,
  LoggerLike,
} from "../src/shared/types.js";
import { createStationStore } from "../src/station/store.js";
import { createStationService } from "../src/station/service.js";
import { registerStationApi } from "../src/station/api.js";
import { announceAddonDiscovery } from "../src/supervisor/discovery.js";

class TestLogger implements LoggerLike {
  readonly entries: LogEntry[] = [];
  private seq = 0;
  constructor(private readonly scope = "test") {}
  private put(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    this.seq += 1;
    this.entries.push({
      seq: this.seq,
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      msg,
      ...(data === undefined ? {} : { data }),
    });
  }
  trace(msg: string, data?: Record<string, unknown>): void {
    this.put("trace", msg, data);
  }
  debug(msg: string, data?: Record<string, unknown>): void {
    this.put("debug", msg, data);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.put("info", msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.put("warn", msg, data);
  }
  error(msg: string, data?: Record<string, unknown>): void {
    this.put("error", msg, data);
  }
  child(scope: string): LoggerLike {
    return new TestLogger(`${this.scope}.${scope}`);
  }
  since(afterSeq: number, limit = 100): LogEntry[] {
    return this.entries.filter((entry) => entry.seq > afterSeq).slice(0, limit);
  }
  subscribe(): () => void {
    return () => undefined;
  }
  text(): string {
    return this.entries.map((entry) => `${entry.level} ${entry.msg} ${JSON.stringify(entry.data ?? {})}`).join("\n");
  }
}

class FakeHa implements HaClientLike {
  readonly calls: HaCallServiceRequest[] = [];
  async callService(request: HaCallServiceRequest): Promise<void> {
    this.calls.push(request);
  }
  async getState(): Promise<HaState | null> {
    return null;
  }
  async listStates(): Promise<HaState[]> {
    return [];
  }
  async listEntities(): Promise<HaEntity[]> {
    return [];
  }
  async listAreas(): Promise<HaArea[]> {
    return [];
  }
  async listServices(): Promise<Array<{ domain: string; service: string }>> {
    return [];
  }
  async available(): Promise<boolean> {
    return true;
  }
}

function fakeConfigStore(_dataDir: string): ConfigStoreLike {
  const config = {
    tools: { ha: { enabled: true, url: "", token: "" } },
  } as unknown as AppConfig;
  return {
    get: () => config,
    update: async () => config,
    masked: () => config,
    onChange: () => () => undefined,
    bridgeToken: () => "bridge-token",
  } as ConfigStoreLike & { dataDir?: string } as ConfigStoreLike;
}

const dirs: string[] = [];
async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pb-station-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

const STATION = {
  entry_id: "01ESP",
  name: "yandex-lite2-000001",
  host: "192.0.2.61",
  port: 6053,
  mac: "02:00:00:00:00:01",
};

describe("station store", () => {
  it("persists the station list and encrypts the PSK", async () => {
    const dir = await makeDir();
    const log = new TestLogger();
    const store = createStationStore(dir, log);
    await store.load();
    await store.saveStations([STATION]);
    await store.setBinding({
      mode: "manual",
      entry_id: "",
      name: "Станция",
      host: "192.0.2.61",
      port: 6053,
      noise_psk: "super-secret-psk",
      bound_at: 1_700_000_000_000,
    });
    const raw = await readFile(join(dir, "station.json"), "utf8");
    expect(raw).toContain("enc:v1:");
    expect(raw).not.toContain("super-secret-psk");
    const reloaded = createStationStore(dir, log);
    await reloaded.load();
    expect(reloaded.getStations()).toEqual([STATION]);
    expect(reloaded.getBinding()?.noise_psk).toBe("super-secret-psk");
    expect(log.text()).not.toContain("super-secret-psk");
  });
});

describe("station service", () => {
  it("binds a discovered station and calls the HA service without the PSK", async () => {
    const dir = await makeDir();
    const ha = new FakeHa();
    const service = createStationService({
      configStore: fakeConfigStore(dir),
      ha,
      log: new TestLogger(),
      dataDir: dir,
      now: () => 1_700_000_000_000,
    });
    await service.start();
    await service.setStations([STATION]);
    expect(service.stationsResponse().integration_connected).toBe(true);
    const response = await service.bind({ entry_id: STATION.entry_id });
    expect(response.binding).toMatchObject({ mode: "discovered", name: STATION.name, host: STATION.host });
    expect(ha.calls.at(-1)).toMatchObject({
      domain: "pulsar_brain",
      service: "set_station",
      data: { entry_id: STATION.entry_id, name: STATION.name, host: STATION.host, port: 6053 },
    });
    expect(ha.calls.at(-1)?.data?.noise_psk).toBeUndefined();
  });

  it("binds manually, encrypts the PSK and clears the binding", async () => {
    const dir = await makeDir();
    const ha = new FakeHa();
    const service = createStationService({
      configStore: fakeConfigStore(dir),
      ha,
      log: new TestLogger(),
      dataDir: dir,
    });
    await service.start();
    const bound = await service.bind({ name: "Моя станция", host: "192.0.2.61", port: 6053, noise_psk: "psk-1" });
    expect(bound.binding?.mode).toBe("manual");
    expect(bound.binding?.has_psk).toBe(true);
    const raw = await readFile(join(dir, "station.json"), "utf8");
    expect(raw).not.toContain("psk-1");
    const cleared = await service.clear();
    expect(cleared.binding).toBeNull();
    expect(ha.calls.at(-1)?.data?.clear).toBe(true);
  });

  it("rejects an unknown discovered entry and an incomplete manual target", async () => {
    const dir = await makeDir();
    const service = createStationService({
      configStore: fakeConfigStore(dir),
      ha: new FakeHa(),
      log: new TestLogger(),
      dataDir: dir,
    });
    await service.start();
    await service.setStations([STATION]);
    await expect(service.bind({ entry_id: "missing" })).rejects.toMatchObject({ code: "station_not_found" });
    await expect(service.bind({ name: "", host: "" })).rejects.toMatchObject({ code: "validation_error" });
  });
});

describe("station API", () => {
  async function makeApi(): Promise<{ app: ReturnType<typeof Fastify>; service: ReturnType<typeof createStationService> }> {
    const dir = await makeDir();
    const service = createStationService({
      configStore: fakeConfigStore(dir),
      ha: new FakeHa(),
      log: new TestLogger(),
      dataDir: dir,
    });
    await service.start();
    await service.setStations([STATION]);
    const app = Fastify();
    registerStationApi(app, {
      service,
      bridgeToken: "bridge-token",
      uiToken: "",
      log: new TestLogger(),
    });
    return { app, service };
  }

  it("protects UI routes but accepts the bridge token", async () => {
    const { app } = await makeApi();
    expect((await app.inject({ method: "GET", url: "/api/stations" })).statusCode).toBe(401);
    const ok = await app.inject({
      method: "GET",
      url: "/api/stations",
      headers: { authorization: "Bearer bridge-token" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().stations).toHaveLength(1);
  });

  it("accepts trusted Supervisor ingress without a token", async () => {
    const { app } = await makeApi();
    const response = await app.inject({
      method: "GET",
      url: "/api/stations",
      remoteAddress: "172.30.32.2",
      headers: { "x-ingress-path": "/api/hassio_ingress/x" },
    });
    expect(response.statusCode).toBe(200);
  });

  it("lets only the bridge push the station list", async () => {
    const { app } = await makeApi();
    const body = { stations: [STATION] };
    const forbidden = await app.inject({ method: "POST", url: "/api/stations", payload: body });
    expect(forbidden.statusCode).toBe(401);
    const accepted = await app.inject({
      method: "POST",
      url: "/api/stations",
      headers: { authorization: "Bearer bridge-token" },
      payload: body,
    });
    expect(accepted.statusCode).toBe(200);
    const bound = await app.inject({
      method: "POST",
      url: "/api/station",
      headers: { authorization: "Bearer bridge-token" },
      payload: { entry_id: STATION.entry_id },
    });
    expect(bound.statusCode).toBe(200);
    expect(bound.json().binding.mode).toBe("discovered");
    const cleared = await app.inject({
      method: "DELETE",
      url: "/api/station",
      headers: { authorization: "Bearer bridge-token" },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().binding).toBeNull();
  });
});

describe("supervisor discovery", () => {
  it("announces the addon hostname and the bridge token to the Supervisor", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    type FetchInput = Parameters<typeof fetch>[0];
    const fakeFetch = (async (input: FetchInput, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push(init === undefined ? { url } : { url, init });
      if (url.endsWith("/addons/self/info")) {
        return new Response(JSON.stringify({ result: "ok", data: { hostname: "local_pulsar_brain" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: "ok" }), { status: 200 });
    }) as typeof fetch;

    const result = await announceAddonDiscovery({
      log: new TestLogger(),
      bridgeToken: "bridge-token",
      version: "0.2.0",
      addonPort: 8097,
      supervisorToken: "supervisor-token",
      fetchImpl: fakeFetch,
      retryDelaysMs: [],
    });
    expect(result).toEqual({ announced: true, host: "local_pulsar_brain" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("http://supervisor/addons/self/info");
    expect(calls[1]?.url).toBe("http://supervisor/discovery");
    const payload = JSON.parse(String(calls[1]?.init?.body)) as {
      service: string;
      config: { host: string; port: number; bridge_token: string; version: string };
    };
    expect(payload.service).toBe("pulsar_brain");
    expect(payload.config).toMatchObject({
      host: "local_pulsar_brain",
      port: 8097,
      bridge_token: "bridge-token",
      version: "0.2.0",
    });
  });

  it("skips discovery outside the Supervisor", async () => {
    const result = await announceAddonDiscovery({
      log: new TestLogger(),
      bridgeToken: "bridge-token",
      version: "0.2.0",
      addonPort: 8097,
    });
    expect(result).toEqual({ announced: false, reason: "not_supervisor" });
  });
});
