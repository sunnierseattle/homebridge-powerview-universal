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
  forceRollerShades?: number[];
  forceTopBottomShades?: number[];
  forceHorizontalShades?: number[];
  forceVerticalShades?: number[];
}

export interface ShadeContext {
  shadeId: number;
  shadeType: ShadeKind;
}
