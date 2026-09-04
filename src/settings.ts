import type { PlatformConfig } from 'homebridge';

/**
 * Platform name users put in config.json as `"platform": "PowerView"`.
 */
export const PLATFORM_NAME = 'PowerView';

/**
 * Must match package.json `name` — used when registering platform accessories.
 */
export const PLUGIN_NAME = 'homebridge-powerview-universal';

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
  /** Capability 6. Primary rail runs reversed relative to bottom-up shades. */
  TOP_DOWN = 5,
  /** Capability 2. Tilt spans 180 degrees, not the 90 that HORIZONTAL assumes. */
  HORIZONTAL_180 = 6,
  /** Capability 5. Tilt only, no lift. */
  TILT_ONLY = 7,
  /** Capabilities 8 and 9. Duolite / overlapped panels. */
  DUAL_OVERLAPPED = 8,
}

/**
 * Shade type -> ShadeCapabilities, from the PowerView Hub REST API v2 appendix
 * (jlaur/hdpowerview-doc v1.0.4). The official specification leaves the
 * ShadeType schema empty, so this table is the only published mapping.
 */
export const SHADE_TYPE_CAPABILITY: Readonly<Record<number, number>> = {
  1: 0, 4: 0, 5: 0, 6: 0, 7: 6, 8: 7, 9: 7, 18: 1, 23: 1, 38: 9,
  42: 0, 43: 1, 44: 1, 47: 7, 49: 0, 51: 2, 54: 3, 55: 3, 56: 3,
  62: 2, 65: 8, 66: 5, 69: 4, 70: 4, 71: 4, 79: 8,
};

/** Kinds whose position and tilt maths this plugin actually implements. */
export const FULLY_SUPPORTED_KINDS: readonly ShadeKind[] = [
  ShadeKind.ROLLER,
  ShadeKind.TOP_BOTTOM,
  ShadeKind.HORIZONTAL,
  ShadeKind.VERTICAL,
];

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
