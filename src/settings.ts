import type { PlatformConfig } from 'homebridge';

/**
 * Platform name users put in config.json as `"platform": "PowerView"`.
 */
export const PLATFORM_NAME = 'PowerView';

/**
 * Must match package.json `name` — used when registering platform accessories.
 */
export const PLUGIN_NAME = 'homebridge-powerview-3';

export const SHADE_POLL_INTERVAL_MS = 30_000;

/**
 * Default local time for the optional daily battery poll (API: updateBatteryLevel).
 *
 * The poll is opt-in — see resolveBatteryPollSettings. It is an RF round-trip
 * that wakes the shade motor: audible, and it nudges the shade.
 */
export const BATTERY_POLL_DEFAULT_AT = '14:00';

/**
 * Default quiet window (local time) for anything that actuates hardware.
 * Homebridge can restart unattended, so a startup position sync must not be
 * free to wake five motors at 03:00.
 */
export const QUIET_START_HOUR = 21;
export const QUIET_END_HOUR = 8;

export enum ShadeKind {
  ROLLER = 1,
  TOP_BOTTOM = 2,
  HORIZONTAL = 3,
  VERTICAL = 4,
}

export const SHADE_TYPE_IDS = {
  ROLLER: [1, 5, 42],
  TOP_BOTTOM: [8],
  HORIZONTAL: [18, 23],
  VERTICAL: [16],
} as const;

export const SUBTYPE = {
  BOTTOM: 'bottom',
  TOP: 'top',
} as const;

export interface PowerViewPlatformConfig extends PlatformConfig {
  host?: string;
  refreshShades?: boolean;
  pollShadesForUpdate?: boolean;
  strictErrors?: boolean;
  /** Opt in to the daily battery poll. Off by default: it wakes the shade motor. */
  batteryPolling?: boolean;
  /** Local "HH:MM" time for the daily battery poll. Defaults to 14:00. */
  batteryPollAt?: string;
  /** Re-sync positions over RF once at startup. Defaults to true. */
  syncPositionsOnStart?: boolean;
  /** Local-time window in which nothing may actuate hardware. `false` disables it. */
  quietHours?: { start: number; end: number } | false;
  forceRollerShades?: number[];
  forceTopBottomShades?: number[];
  forceHorizontalShades?: number[];
  forceVerticalShades?: number[];
}

export interface ShadeContext {
  shadeId: number;
  shadeType: ShadeKind;
  /** False when the hub rejected motion jog for this shade. */
  jogSupported?: boolean;
  /** Last known positions, persisted so a restart does not report 0. */
  lastPositions?: Partial<Record<number, number>>;
}
