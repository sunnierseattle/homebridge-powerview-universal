import { HubPosition, type ShadePositions } from './powerviewHub.js';
import {
  BATTERY_POLL_DEFAULT_AT,
  SHADE_TYPE_CAPABILITY,
  ShadeKind,
  QUIET_END_HOUR,
  QUIET_START_HOUR,
  type PowerViewPlatformConfig,
} from './settings.js';

export interface TimeOfDay {
  hour: number;
  minute: number;
}

export interface BatteryPollSettings {
  enabled: boolean;
  at: TimeOfDay;
}

/** Parses an "HH:MM" local time. Returns null on anything malformed. */
export function parseTimeOfDay(value: unknown): TimeOfDay | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/**
 * Milliseconds from `now` until the next occurrence of `hour:minute` local time,
 * rolling to tomorrow when today's slot has already passed.
 *
 * Callers must recompute this from a fresh Date after every run rather than
 * adding 24h to the previous deadline: only recomputing keeps the poll pinned to
 * the same wall-clock time across a DST change.
 */
export function msUntilNextDailyRun(now: Date, hour: number, minute: number): number {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);

  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
    next.setHours(hour, minute, 0, 0);
  }

  return next.getTime() - now.getTime();
}

/**
 * Resolves battery-poll timing from user config.
 *
 * Polling is opt-in: `updateBatteryLevel=true` is an RF round-trip that audibly
 * wakes the shade motor and nudges the shade, so a default-on timer actuates
 * hardware in someone's home that they never asked for. Battery state still
 * reaches HomeKit from ordinary hub reads; this poll only forces a fresh
 * measurement.
 */
export function resolveBatteryPollSettings(
  config: Partial<PowerViewPlatformConfig>,
): BatteryPollSettings {
  return {
    enabled: config.batteryPolling === true,
    at: parseTimeOfDay(config.batteryPollAt) ?? (parseTimeOfDay(BATTERY_POLL_DEFAULT_AT) as TimeOfDay),
  };
}

export function decodeBase64Name(encoded: string | undefined, fallback: string): string {
  if (!encoded) {
    return fallback;
  }
  try {
    return Buffer.from(encoded, 'base64').toString();
  } catch {
    return encoded;
  }
}

/** A shade's reported positions, keyed by position kind. */
export type PositionMap = Partial<Record<HubPosition, number>>;

/** API PositionKind value when the hub reports a position error. */
export const POSITION_KIND_ERROR = 4;

export function isValidPositionKind(kind: number): boolean {
  return kind >= HubPosition.BOTTOM && kind <= HubPosition.VANES;
}

/**
 * Builds a map of position kind → hub value, skipping invalid/error kinds.
 */
export function parsePositionMap(positions: ShadePositions): Partial<Record<HubPosition, number>> {
  const map: Partial<Record<HubPosition, number>> = {};

  for (let i = 1; positions[`posKind${i}`] != null; ++i) {
    const kind = positions[`posKind${i}`];
    if (kind === POSITION_KIND_ERROR || !isValidPositionKind(kind)) {
      continue;
    }
    map[kind as HubPosition] = positions[`position${i}`];
  }

  return map;
}

/**
 * Serializes a position map back to hub posKindN/positionN fields.
 */
export function serializePositionMap(positions: Record<number, number>): ShadePositions {
  const result: ShadePositions = {};
  let i = 1;
  for (const key of Object.keys(positions).sort((a, b) => Number(a) - Number(b))) {
    const kind = parseInt(key, 10);
    if (kind === POSITION_KIND_ERROR || !isValidPositionKind(kind)) {
      continue;
    }
    result[`posKind${i}`] = kind;
    result[`position${i}`] = positions[kind];
    ++i;
  }
  return result;
}

/**
 * Nominal pack voltage in tenths of a volt. Gen 1/2 hubs report `batteryStrength`
 * as tenths of a volt (e.g. 146 = 14.6V) against an 18.0V nominal pack, NOT as a
 * percentage. Matches the conversion used by aiopvapi / Home Assistant.
 */
export const BATTERY_NOMINAL_TENTHS_VOLT = 180;

/** Percentage at or below which HomeKit should show a low-battery warning. */
export const LOW_BATTERY_PERCENT = 20;

/**
 * Converts a hub `batteryStrength` (tenths of a volt) to a 0-100 percentage.
 * Returns undefined when the value is absent or 0 — the hub reports 0 for shades
 * it has not polled yet, which is "unknown", not "empty".
 */
export function batteryStrengthToPercent(batteryStrength?: number): number | undefined {
  if (typeof batteryStrength !== 'number' || !Number.isFinite(batteryStrength)) {
    return undefined;
  }
  if (batteryStrength <= 0) {
    return undefined;
  }
  return Math.min(100, Math.round((batteryStrength / BATTERY_NOMINAL_TENTHS_VOLT) * 100));
}

/** BatteryStatus: 0 = none, 1 = low, 2 = medium, 3 = high, 4 = plugged in. */
export function isLowBattery(batteryStatus?: number, batteryStrength?: number): boolean {
  if (batteryStatus === 1) {
    return true;
  }
  const percent = batteryStrengthToPercent(batteryStrength);
  if (percent != null) {
    return percent <= LOW_BATTERY_PERCENT;
  }
  return false;
}

export interface BatteryReading {
  /** HomeKit BatteryLevel (0–100). */
  level: number;
  low: boolean;
  /** Hub reports mains-powered (BatteryStatus plugged in). */
  mainsPowered: boolean;
}

/**
 * Maps PowerView shade battery fields to HomeKit Battery service values.
 * Returns undefined when the hub provides no usable battery data.
 */
export function resolveBatteryReading(
  batteryStatus?: number,
  batteryStrength?: number,
): BatteryReading | undefined {
  if (batteryStatus == null && batteryStrength == null) {
    return undefined;
  }

  if (batteryStatus === 0) {
    return undefined;
  }

  let level: number | undefined = batteryStrengthToPercent(batteryStrength);
  if (level == null && batteryStatus != null) {
    switch (batteryStatus) {
    case 1:
      level = 15;
      break;
    case 2:
      level = 50;
      break;
    case 3:
      level = 90;
      break;
    case 4:
      level = 100;
      break;
    default:
      return undefined;
    }
  }

  if (level == null) {
    return undefined;
  }

  return {
    level,
    low: isLowBattery(batteryStatus, batteryStrength),
    mainsPowered: batteryStatus === 4,
  };
}

export function formatShadeFirmware(firmware?: {
  revision: number;
  subRevision: number;
  build: number;
}): string | undefined {
  if (!firmware) {
    return undefined;
  }
  return `${firmware.revision}.${firmware.subRevision}.${firmware.build}`;
}


export type PositionLookup =
  | { kind: 'ok'; value: number }
  | { kind: 'missing' }
  | { kind: 'invalid'; value: unknown };

/**
 * Distinguishes "the hub did not report this position" from "the hub reported
 * something unusable".
 *
 * The distinction is not academic: a PowerView Gen 2 hub returns no `positions`
 * object at all on a cached read — positions exist only after a `refresh=true`
 * read or a set — so `missing` is the normal path on every HomeKit read, while
 * `invalid` means the hub really did send bad data. Collapsing the two logged a
 * warning on the happy path 77 times a day and pointed diagnosis at the hub's
 * values when the hub had sent no values at all.
 */
export function lookupPosition(positions: PositionMap, position: HubPosition): PositionLookup {
  if (!Object.prototype.hasOwnProperty.call(positions, position)) {
    return { kind: 'missing' };
  }

  const value = positions[position];
  return typeof value === 'number' && Number.isFinite(value)
    ? { kind: 'ok', value }
    : { kind: 'invalid', value };
}

/**
 * Validates a position map restored from persisted accessory context, which is
 * plain JSON written by an earlier run and must not be trusted structurally.
 */
export function sanitizePositionMap(value: unknown): PositionMap {
  const clean: PositionMap = {};

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return clean;
  }

  for (const [key, entry] of Object.entries(value)) {
    const kind = Number(key);
    if (!Number.isInteger(kind) || !isValidPositionKind(kind)) {
      continue;
    }
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      clean[kind as HubPosition] = entry;
    }
  }

  return clean;
}


/** Shallow equality for position maps, treating a missing map as empty. */
export function positionMapsEqual(a: PositionMap | undefined, b: PositionMap | undefined): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const leftKeys = Object.keys(left);

  if (leftKeys.length !== Object.keys(right).length) {
    return false;
  }

  return leftKeys.every((key) => {
    const kind = Number(key) as HubPosition;
    return Object.prototype.hasOwnProperty.call(right, kind) && left[kind] === right[kind];
  });
}


export interface QuietHours {
  /** Start of the quiet window, inclusive. Equal to endHour means "no quiet window". */
  startHour: number;
  /** End of the quiet window, exclusive. */
  endHour: number;
}

/**
 * True when `date`'s local hour falls in [startHour, endHour), wrapping across
 * midnight when startHour > endHour. An empty window is never within.
 */
export function isWithinQuietHours(date: Date, startHour: number, endHour: number): boolean {
  if (startHour === endHour) {
    return false;
  }

  const hour = date.getHours();
  return startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

/** Resolves the window during which the plugin must not actuate hardware. */
export function resolveQuietHours(config: Partial<PowerViewPlatformConfig>): QuietHours {
  const quiet = config.quietHours;

  if (quiet === false) {
    return { startHour: 0, endHour: 0 };
  }

  if (
    quiet
    && Number.isInteger(quiet.start) && quiet.start >= 0 && quiet.start <= 23
    && Number.isInteger(quiet.end) && quiet.end >= 0 && quiet.end <= 23
  ) {
    return { startHour: quiet.start, endHour: quiet.end };
  }

  return { startHour: QUIET_START_HOUR, endHour: QUIET_END_HOUR };
}


/**
 * Resolves a shade's ShadeCapabilities value: the hub's own `capabilities`
 * field when it reports one, otherwise the documented type table.
 *
 * Capability is the right axis, not `type`: 26 published types collapse onto
 * 10 capability classes, and behaviour (reversed rail, tilt range, dual
 * panels) follows the capability. Older hubs omit the field entirely.
 */
export function resolveShadeCapability(
  shade: { type?: number; capabilities?: number },
): number | undefined {
  const reported = shade.capabilities;
  if (typeof reported === 'number' && Number.isInteger(reported) && reported >= 0 && reported <= 9) {
    return reported;
  }

  const type = shade.type;
  if (typeof type !== 'number') {
    return undefined;
  }

  return SHADE_TYPE_CAPABILITY[type];
}

/** Maps a ShadeCapabilities value onto the kind the plugin drives it as. */
export function shadeKindForCapability(capability: number): ShadeKind | undefined {
  switch (capability) {
  case 0: return ShadeKind.ROLLER;
  case 1: return ShadeKind.HORIZONTAL;
  case 2: return ShadeKind.HORIZONTAL_180;
  case 3:
  case 4: return ShadeKind.VERTICAL;
  case 5: return ShadeKind.TILT_ONLY;
  case 6: return ShadeKind.TOP_DOWN;
  case 7: return ShadeKind.TOP_BOTTOM;
  case 8:
  case 9: return ShadeKind.DUAL_OVERLAPPED;
  default: return undefined;
  }
}
