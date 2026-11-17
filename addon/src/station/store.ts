/**
 * Persistent station state: <dataDir>/station.json.
 *
 * The station list is public data reported by the integration. The manual binding may carry
 * a Noise PSK; it is encrypted with the installation master key before it reaches the disk
 * and is decrypted only in memory. Writes are serialized and atomic (temp file + rename,
 * mode 0600), and no log line ever receives the plaintext PSK.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { StationEntryDto } from "../shared/protocol.js";
import type { LoggerLike } from "../shared/types.js";
import { createSecretCipher, type SecretCipher } from "../secrets/crypto.js";
import { StationEntrySchema } from "./schema.js";

export const STATION_FILE = "station.json";
export const STATION_FILE_MODE = 0o600;

const StoredBindingSchema = z.object({
  mode: z.enum(["discovered", "manual"]),
  entry_id: z.string().max(200).default(""),
  name: z.string().min(1).max(200),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  /** "enc:v1:..." envelope; never a plaintext PSK. */
  noise_psk_enc: z.string().max(4096).default(""),
  bound_at: z.number().int().nonnegative(),
});

const StoredFileSchema = z.object({
  binding: StoredBindingSchema.nullable().default(null),
  stations: z.array(StationEntrySchema).default([]),
});

export interface StationBinding {
  mode: "discovered" | "manual";
  /** Empty for a manual binding. */
  entry_id: string;
  name: string;
  host: string;
  port: number;
  /** Plaintext only in memory; persisted as noise_psk_enc. */
  noise_psk: string;
  bound_at: number;
}

export interface StationStore {
  readonly file: string;
  /** Reads the file; missing means empty state, a corrupt file is reported and ignored. */
  load(): Promise<void>;
  getStations(): StationEntryDto[];
  /** Binding with the decrypted PSK; callers must not expose it in API responses. */
  getBinding(): StationBinding | null;
  saveStations(stations: StationEntryDto[]): Promise<void>;
  setBinding(binding: StationBinding): Promise<void>;
  clearBinding(): Promise<void>;
}

export function createStationStore(dataDir: string, log: LoggerLike): StationStore {
  const dir = resolve(dataDir);
  const file = join(dir, STATION_FILE);
  const cipher: SecretCipher = createSecretCipher(dir);
  let stations: StationEntryDto[] = [];
  let binding: StationBinding | null = null;

  // Writes run one at a time: read-modify-write of the JSON document must not interleave.
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation, operation);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  async function persist(
    nextBinding: StationBinding | null,
    nextStations: StationEntryDto[],
  ): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stored = {
      binding:
        nextBinding === null
          ? null
          : {
              mode: nextBinding.mode,
              entry_id: nextBinding.entry_id,
              name: nextBinding.name,
              host: nextBinding.host,
              port: nextBinding.port,
              noise_psk_enc: cipher.encrypt(nextBinding.noise_psk),
              bound_at: nextBinding.bound_at,
            },
      stations: nextStations,
    };
    const serialized = `${JSON.stringify(stored, null, 2)}\n`;
    const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tempFile, serialized, { mode: STATION_FILE_MODE });
      await rename(tempFile, file);
    } finally {
      await rm(tempFile, { force: true });
    }
  }

  const reset = (): void => {
    stations = [];
    binding = null;
  };

  return {
    file,

    async load(): Promise<void> {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reset();
          return;
        }
        throw err;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (err) {
        log.warn("station file is corrupted, station state is empty", {
          file,
          error: errorText(err),
        });
        reset();
        return;
      }

      const parsed = StoredFileSchema.safeParse(raw);
      if (!parsed.success) {
        log.warn("station file does not match the schema, station state is empty", {
          file,
          issues: parsed.error.issues.length,
        });
        reset();
        return;
      }

      stations = parsed.data.stations.map((entry) => ({ ...entry }));
      binding = parsed.data.binding === null ? null : readBinding(parsed.data.binding, cipher, log);
      log.debug("station state loaded", {
        file,
        stations: stations.length,
        bound: binding !== null,
        hasPsk: binding !== null && binding.noise_psk.length > 0,
      });
    },

    getStations(): StationEntryDto[] {
      return stations.map((entry) => ({ ...entry }));
    },

    getBinding(): StationBinding | null {
      return binding === null ? null : { ...binding };
    },

    async saveStations(nextStations: StationEntryDto[]): Promise<void> {
      await serialize(async () => {
        const copy = nextStations.map((entry) => ({ ...entry }));
        await persist(binding, copy);
        stations = copy;
      });
    },

    async setBinding(nextBinding: StationBinding): Promise<void> {
      await serialize(async () => {
        const copy = { ...nextBinding };
        await persist(copy, stations);
        binding = copy;
        log.info("station binding persisted", {
          mode: copy.mode,
          entryId: copy.entry_id,
          host: copy.host,
          port: copy.port,
          hasPsk: copy.noise_psk.length > 0,
        });
      });
    },

    async clearBinding(): Promise<void> {
      await serialize(async () => {
        await persist(null, stations);
        binding = null;
        log.info("station binding cleared");
      });
    },
  };
}

function readBinding(
  stored: z.infer<typeof StoredBindingSchema>,
  cipher: SecretCipher,
  log: LoggerLike,
): StationBinding {
  let psk = "";
  if (stored.noise_psk_enc.length > 0) {
    try {
      psk = cipher.decrypt(stored.noise_psk_enc);
    } catch (err) {
      // A master-key mismatch must not block startup: keep the binding, report the problem.
      log.warn("stored station PSK cannot be decrypted; binding kept without PSK", {
        error: errorText(err),
      });
    }
  }
  return {
    mode: stored.mode,
    entry_id: stored.entry_id,
    name: stored.name,
    host: stored.host,
    port: stored.port,
    noise_psk: psk,
    bound_at: stored.bound_at,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
