import { HubPosition, type ShadePositions } from './powerviewHub.js';

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

/** BatteryStatus: 0 = none, 1 = low, 2 = medium, 3 = high, 4 = plugged in. */
export function isLowBattery(batteryStatus?: number, batteryStrength?: number): boolean {
  if (batteryStatus === 1) {
    return true;
  }
  if (typeof batteryStrength === 'number' && batteryStrength >= 0 && batteryStrength <= 20) {
    return true;
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

  let level: number | undefined;
  if (typeof batteryStrength === 'number' && batteryStrength >= 0 && batteryStrength <= 100) {
    level = Math.round(batteryStrength);
  } else if (batteryStatus != null) {
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
