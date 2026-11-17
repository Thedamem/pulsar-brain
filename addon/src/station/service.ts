/**
 * Station binding service (docs/contracts.md §8.2–§8.3).
 *
 * The integration pushes its ESPHome station list here; the UI binds one station either by
 * its entry_id (the integration resolves host/port/PSK inside HA) or manually. Binding state
 * is persisted before the HA service call, so a temporarily unavailable HA does not lose the
 * user's choice: the failure is logged and reported in the response's binding as usual.
 */

import type {
  CurrentStationDto,
  SetStationRequest,
  StationBindingDto,
  StationEntryDto,
  StationsResponse,
} from "../shared/protocol.js";
import type { ConfigStoreLike, HaClientLike, LoggerLike } from "../shared/types.js";
import {
  SetStationRequestSchema,
  StationListSchema,
  describeZodError,
} from "./schema.js";
import { createStationStore, type StationBinding, type StationStore } from "./store.js";

/** The integration posts its station list every 60 s; three missed rounds mean it is gone. */
const INTEGRATION_FRESH_MS = 90_000;
const HA_DOMAIN = "pulsar_brain";
const HA_SET_STATION = "set_station";

export type StationErrorCode = "validation_error" | "station_not_found";

export class StationError extends Error {
  constructor(
    readonly code: StationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StationError";
  }
}

export interface StationServiceDeps {
  configStore: ConfigStoreLike;
  ha: HaClientLike;
  log: LoggerLike;
  dataDir: string;
  /** Injected clock for tests; defaults to Date.now. */
  now?: () => number;
}

export interface StationService {
  start(): Promise<void>;
  stationsResponse(): StationsResponse;
  bindingName(): string | null;
  integrationLastSeenAt(): number | null;
  setStations(entries: StationEntryDto[], current?: CurrentStationDto | null): Promise<void>;
  bind(request: SetStationRequest): Promise<StationsResponse>;
  clear(): Promise<StationsResponse>;
}

export function createStationService(deps: StationServiceDeps): StationService {
  const { ha, log, dataDir } = deps;
  const now = deps.now ?? (() => Date.now());
  const store: StationStore = createStationStore(dataDir, log);
  /** Null until the integration posts its first list after addon start. */
  let lastStationsAt: number | null = null;

  async function callHa(data: Record<string, unknown>): Promise<void> {
    try {
      await ha.callService({ domain: HA_DOMAIN, service: HA_SET_STATION, data });
    } catch (err) {
      // The binding is already persisted; keep it and tell the user through the logs.
      log.warn("station binding was saved, but the Home Assistant set_station call failed", {
        error: errorText(err),
        hasPsk: typeof data.noise_psk === "string" && data.noise_psk.length > 0,
      });
    }
  }

  const stationsResponse = (): StationsResponse => {
    const binding = store.getBinding();
    return {
      stations: store.getStations(),
      binding: binding === null ? null : toBindingDto(binding),
      integration_connected:
        lastStationsAt !== null && now() - lastStationsAt < INTEGRATION_FRESH_MS,
    };
  };

  const start = async (): Promise<void> => {
    await store.load();
    log.info("station service started", {
      stations: store.getStations().length,
      bound: store.getBinding() !== null,
    });
  };

  const setStations = async (
    entries: StationEntryDto[],
    current?: CurrentStationDto | null,
  ): Promise<void> => {
    const parsed = StationListSchema.safeParse(entries);
    if (!parsed.success) {
      throw new StationError("validation_error", describeZodError("Список станций", parsed.error));
    }
    await store.saveStations(parsed.data);
    lastStationsAt = now();
    if (current !== undefined && current !== null) {
      // Home Assistant is the source of truth after a set_station round-trip (and after a
      // 0.1.x upgrade migration). Keep the locally stored PSK only for the same endpoint.
      const existing = store.getBinding();
      const keepPsk =
        existing !== null && existing.host === current.host && existing.port === current.port
          ? existing.noise_psk
          : "";
      await store.setBinding({
        mode: current.mode,
        entry_id: current.entry_id,
        name: current.name,
        host: current.host,
        port: current.port,
        noise_psk: keepPsk,
        bound_at: existing?.bound_at ?? now(),
      });
    }
    log.info("station list received from the integration", {
      count: parsed.data.length,
      bound: store.getBinding() !== null,
    });
  };

  const bind = async (request: SetStationRequest): Promise<StationsResponse> => {
    const parsed = SetStationRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new StationError("validation_error", describeZodError("Привязка станции", parsed.error));
    }

    const requestedEntryId = parsed.data.entry_id ?? "";
    let binding: StationBinding;
    if (requestedEntryId.length > 0) {
      const entry = store
        .getStations()
        .find((candidate) => candidate.entry_id === requestedEntryId);
      if (entry === undefined) {
        throw new StationError(
          "station_not_found",
          `Станция ${requestedEntryId} не найдена в списке`,
        );
      }
      binding = {
        mode: "discovered",
        entry_id: entry.entry_id,
        name: entry.name,
        host: entry.host,
        port: entry.port,
        // The integration takes the PSK from the esphome config entry; it must not leave HA.
        noise_psk: "",
        bound_at: now(),
      };
    } else {
      const name = parsed.data.name ?? "";
      const host = parsed.data.host ?? "";
      if (name.length === 0 || host.length === 0) {
        throw new StationError("validation_error", "Для ручной привязки нужны name и host");
      }
      binding = {
        mode: "manual",
        entry_id: "",
        name,
        host,
        port: parsed.data.port ?? 6053,
        noise_psk: parsed.data.noise_psk ?? "",
        bound_at: now(),
      };
    }

    await store.setBinding(binding);
    log.info("station bound", {
      mode: binding.mode,
      entryId: binding.entry_id,
      host: binding.host,
      port: binding.port,
      hasPsk: binding.noise_psk.length > 0,
    });

    const data: Record<string, unknown> = {
      name: binding.name,
      host: binding.host,
      port: binding.port,
    };
    if (binding.mode === "discovered") data.entry_id = binding.entry_id;
    if (binding.noise_psk.length > 0) data.noise_psk = binding.noise_psk;
    await callHa(data);

    return stationsResponse();
  };

  const clear = async (): Promise<StationsResponse> => {
    const hadBinding = store.getBinding() !== null;
    await store.clearBinding();
    log.info("station unbound", { hadBinding });
    await callHa({ clear: true });
    return stationsResponse();
  };

  return {
    start,
    stationsResponse,
    bindingName: () => store.getBinding()?.name ?? null,
    integrationLastSeenAt: () => lastStationsAt,
    setStations,
    bind,
    clear,
  };
}

/** Public projection: the PSK becomes a boolean and the plaintext never leaves the addon. */
function toBindingDto(binding: StationBinding): StationBindingDto {
  return {
    mode: binding.mode,
    entry_id: binding.entry_id,
    name: binding.name,
    host: binding.host,
    port: binding.port,
    has_psk: binding.noise_psk.length > 0,
    bound_at: binding.bound_at,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
