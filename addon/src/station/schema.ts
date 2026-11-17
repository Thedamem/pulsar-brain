/**
 * Validation limits for station discovery and binding (docs/contracts.md §8).
 *
 * The integration is an external input boundary: the station list, the manual binding and
 * the persisted file all go through these schemas. Length caps keep a broken integration
 * from filling the data directory or the UI with unbounded strings.
 */

import { z } from "zod";
import type { CurrentStationDto, SetStationRequest, StationEntryDto } from "../shared/protocol.js";

export const MAX_STATIONS = 100;
export const DEFAULT_STATION_PORT = 6053;

const MAX_ENTRY_ID = 200;
const MAX_NAME = 200;
const MAX_HOST = 255;
const MAX_MAC = 64;
const MAX_PSK = 256;

/** One ESPHome device as reported by the integration; the PSK is never part of this list. */
export const StationEntrySchema: z.ZodType<StationEntryDto, z.ZodTypeDef, unknown> = z.object({
  entry_id: z.string().trim().min(1).max(MAX_ENTRY_ID),
  name: z.string().trim().min(1).max(MAX_NAME),
  host: z.string().trim().min(1).max(MAX_HOST),
  port: z.number().int().min(1).max(65535).default(DEFAULT_STATION_PORT),
  mac: z.string().trim().max(MAX_MAC).default(""),
});

export const StationListSchema = z.array(StationEntrySchema).max(MAX_STATIONS);

export const CurrentStationSchema: z.ZodType<
  CurrentStationDto,
  z.ZodTypeDef,
  unknown
> = z.object({
  mode: z.enum(["discovered", "manual"]),
  entry_id: z.string().trim().max(MAX_ENTRY_ID).default(""),
  name: z.string().trim().min(1).max(MAX_NAME),
  host: z.string().trim().min(1).max(MAX_HOST),
  port: z.number().int().min(1).max(65535).default(DEFAULT_STATION_PORT),
  has_psk: z.boolean().default(false),
});

export const StationsBodySchema = z.object({
  stations: StationListSchema,
  current: CurrentStationSchema.nullable().optional(),
});

export type StationsBody = z.infer<typeof StationsBodySchema>;

/**
 * A bind request is either a reference to a discovered station (entry_id) or an explicit
 * manual target. Empty optional strings are allowed so that a UI can submit a form with
 * blank fields; the service rejects a manual binding without name and host.
 */
export const SetStationRequestSchema: z.ZodType<SetStationRequest, z.ZodTypeDef, unknown> = z.object({
  entry_id: z.string().trim().max(MAX_ENTRY_ID).default(""),
  name: z.string().trim().max(MAX_NAME).default(""),
  host: z.string().trim().max(MAX_HOST).default(""),
  port: z.number().int().min(1).max(65535).default(DEFAULT_STATION_PORT),
  noise_psk: z.string().max(MAX_PSK).default(""),
});

/** Same format as the HTTP API: a short field path plus the zod message. */
export function describeZodError(label: string, error: z.ZodError): string {
  const issues = error.issues
    .slice(0, 6)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "тело";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  return `${label}: ${issues}`;
}
