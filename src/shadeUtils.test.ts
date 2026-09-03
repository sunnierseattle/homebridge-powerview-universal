import { describe, expect, it } from 'vitest';

import { HubPosition } from './powerviewHub.js';
import {
  POSITION_KIND_ERROR,
  decodeBase64Name,
  formatShadeFirmware,
  isLowBattery,
  isWithinQuietHours,
  resolveShadeCapability,
  shadeKindForCapability,
  lookupPosition,
  msUntilNextDailyRun,
  parsePositionMap,
  parseTimeOfDay,
  resolveQuietHours,
  positionMapsEqual,
  resolveBatteryPollSettings,
  resolveBatteryReading,
  sanitizePositionMap,
  serializePositionMap,
} from './shadeUtils.js';

describe('decodeBase64Name', () => {
  it('decodes base64 shade names', () => {
    expect(decodeBase64Name('QWxsIGRvd24=', 'fallback')).toBe('All down');
  });

  it('returns fallback when missing', () => {
    expect(decodeBase64Name(undefined, 'Shade 1')).toBe('Shade 1');
  });
});

describe('parsePositionMap', () => {
  it('skips position kind error (4)', () => {
    const map = parsePositionMap({
      posKind1: POSITION_KIND_ERROR,
      position1: 1000,
      posKind2: HubPosition.BOTTOM,
      position2: 32768,
    });
    expect(map[POSITION_KIND_ERROR as HubPosition]).toBeUndefined();
    expect(map[HubPosition.BOTTOM]).toBe(32768);
  });
});

describe('serializePositionMap', () => {
  it('omits error position kinds from PUT body', () => {
    const body = serializePositionMap({
      [POSITION_KIND_ERROR]: 1,
      [HubPosition.BOTTOM]: 59050,
    });
    expect(body.posKind1).toBe(HubPosition.BOTTOM);
    expect(body.position1).toBe(59050);
    expect(body.posKind2).toBeUndefined();
  });
});

describe('isLowBattery', () => {
  it('reports low when battery status is Low (1)', () => {
    expect(isLowBattery(1, 80)).toBe(true);
  });

  it('reports low when strength is at or below 20', () => {
    expect(isLowBattery(3, 20)).toBe(true);
  });

  it('reports ok for healthy readings', () => {
    expect(isLowBattery(3, 78)).toBe(false);
  });
});

describe('formatShadeFirmware', () => {
  it('formats revision.subRevision.build', () => {
    expect(formatShadeFirmware({ revision: 2, subRevision: 0, build: 564 })).toBe('2.0.564');
  });
});

describe('resolveBatteryReading', () => {
  it('converts batteryStrength (tenths of a volt) to a percentage of 18.0V', () => {
    // 78 = 7.8V on an 18.0V nominal pack => 43%, NOT 78%.
    expect(resolveBatteryReading(3, 78)).toEqual({
      level: 43,
      low: false,
      mainsPowered: false,
    });
  });

  it('maps status-only hubs to approximate levels', () => {
    expect(resolveBatteryReading(1, undefined)?.level).toBe(15);
    expect(resolveBatteryReading(1, undefined)?.low).toBe(true);
  });

  it('returns undefined when status is unavailable', () => {
    expect(resolveBatteryReading(0, 50)).toBeUndefined();
    expect(resolveBatteryReading(undefined, undefined)).toBeUndefined();
  });
});


describe('resolveBatteryReading — voltage scale (Gen 1/2 hubs)', () => {
  it('scales real hub readings against 18.0V nominal', () => {
    // Observed on a Gen 1 hub: healthy shades report 176-183 (17.6-18.3V).
    expect(resolveBatteryReading(3, 183)?.level).toBe(100);
    expect(resolveBatteryReading(3, 178)?.level).toBe(99);
    expect(resolveBatteryReading(3, 176)?.level).toBe(98);
  });

  it('clamps readings above nominal to 100', () => {
    expect(resolveBatteryReading(3, 200)?.level).toBe(100);
  });

  it('does not collapse distinct charge levels onto one status bucket', () => {
    // Both would report 90% via the batteryStatus fallback; they are not the same.
    expect(resolveBatteryReading(3, 176)?.level)
      .not.toBe(resolveBatteryReading(3, 120)?.level);
    expect(resolveBatteryReading(3, 120)?.level).toBe(67);
  });

  it('treats strength 0 as unknown, not as an empty battery', () => {
    // The hub reports 0 for shades it has not yet polled.
    expect(resolveBatteryReading(3, 0)?.level).toBe(90);
    expect(resolveBatteryReading(3, 0)?.low).toBe(false);
  });

  it('flags genuinely low packs', () => {
    expect(resolveBatteryReading(3, 30)?.low).toBe(true);
  });
});

describe('isLowBattery — voltage scale', () => {
  it('does not flag an unpolled shade (strength 0) as low', () => {
    expect(isLowBattery(3, 0)).toBe(false);
  });

  it('flags a pack at or below 20% of nominal', () => {
    expect(isLowBattery(3, 36)).toBe(true);
  });

  it('does not flag a healthy pack', () => {
    expect(isLowBattery(3, 176)).toBe(false);
  });
});

describe('parseTimeOfDay', () => {
  it('parses HH:MM', () => {
    expect(parseTimeOfDay('14:00')).toEqual({ hour: 14, minute: 0 });
    expect(parseTimeOfDay('9:05')).toEqual({ hour: 9, minute: 5 });
    expect(parseTimeOfDay('  23:59  ')).toEqual({ hour: 23, minute: 59 });
  });

  it('rejects out-of-range and malformed values', () => {
    for (const bad of ['24:00', '12:60', '12', '12:5', 'noon', '', '-1:00', 12 as never, null as never]) {
      expect(parseTimeOfDay(bad), String(bad)).toBeNull();
    }
  });
});

describe('msUntilNextDailyRun', () => {
  it('waits until later today when the slot has not passed', () => {
    const now = new Date(2026, 8, 3, 9, 0, 0);
    expect(msUntilNextDailyRun(now, 14, 0)).toBe(5 * 60 * 60 * 1000);
  });

  it('rolls to tomorrow when the slot has already passed', () => {
    const now = new Date(2026, 8, 3, 15, 0, 0);
    expect(msUntilNextDailyRun(now, 14, 0)).toBe(23 * 60 * 60 * 1000);
  });

  it('rolls to tomorrow when called exactly at the slot, so a run cannot re-fire', () => {
    const now = new Date(2026, 8, 3, 14, 0, 0, 0);
    expect(msUntilNextDailyRun(now, 14, 0)).toBe(24 * 60 * 60 * 1000);
  });

  it('always returns a positive delay under 25h, every day of the year', () => {
    // 25h rather than 24h: a fall-back DST day is 25 hours long.
    for (let day = 0; day < 365; ++day) {
      const now = new Date(2026, 0, 1, 3, 17, 0);
      now.setDate(now.getDate() + day);
      for (const [h, m] of [[0, 0], [2, 30], [14, 0], [23, 59]]) {
        const delay = msUntilNextDailyRun(now, h, m);
        expect(delay, `day ${day} target ${h}:${m}`).toBeGreaterThan(0);
        expect(delay, `day ${day} target ${h}:${m}`).toBeLessThanOrEqual(25 * 60 * 60 * 1000);
      }
    }
  });

  it('lands on the requested wall-clock time', () => {
    const now = new Date(2026, 8, 3, 9, 0, 0);
    const landed = new Date(now.getTime() + msUntilNextDailyRun(now, 14, 30));
    expect(landed.getHours()).toBe(14);
    expect(landed.getMinutes()).toBe(30);
  });

  it('does not drift when rescheduled from the moment it fires', () => {
    let now = new Date(2026, 8, 3, 14, 0, 0, 0);
    for (let i = 0; i < 400; ++i) {
      // +37ms models the real callback firing a touch late each day.
      now = new Date(now.getTime() + msUntilNextDailyRun(now, 14, 0) + 37);
      expect(now.getHours(), `run ${i}`).toBe(14);
      expect(now.getMinutes(), `run ${i}`).toBe(0);
    }
  });
});

describe('resolveBatteryPollSettings', () => {
  it('is off by default: never wake hardware unless asked', () => {
    expect(resolveBatteryPollSettings({})).toEqual({ enabled: false, at: { hour: 14, minute: 0 } });
  });

  it('is enabled only by an explicit true', () => {
    expect(resolveBatteryPollSettings({ batteryPolling: true }).enabled).toBe(true);
    for (const v of [undefined, null, 0, '', 'true']) {
      expect(resolveBatteryPollSettings({ batteryPolling: v as never }).enabled, String(v)).toBe(false);
    }
  });

  it('accepts a custom time', () => {
    expect(resolveBatteryPollSettings({ batteryPolling: true, batteryPollAt: '06:45' }))
      .toEqual({ enabled: true, at: { hour: 6, minute: 45 } });
  });

  it('falls back to the default time on unparseable input', () => {
    expect(resolveBatteryPollSettings({ batteryPolling: true, batteryPollAt: 'half past two' }).at)
      .toEqual({ hour: 14, minute: 0 });
  });
});

describe('lookupPosition', () => {
  it('reports ok with the value when present and finite', () => {
    expect(lookupPosition({ [HubPosition.BOTTOM]: 42 }, HubPosition.BOTTOM))
      .toEqual({ kind: 'ok', value: 42 });
    expect(lookupPosition({ [HubPosition.BOTTOM]: 0 }, HubPosition.BOTTOM))
      .toEqual({ kind: 'ok', value: 0 });
  });

  it('reports missing when the hub omitted the key entirely', () => {
    // The PowerView Gen 2 hub returns no `positions` object at all on a cached
    // read, so this is the normal path, not an error.
    expect(lookupPosition({}, HubPosition.BOTTOM)).toEqual({ kind: 'missing' });
    expect(lookupPosition({ [HubPosition.TOP]: 10 }, HubPosition.BOTTOM))
      .toEqual({ kind: 'missing' });
  });

  it('reports invalid only when the key is present with unusable data', () => {
    expect(lookupPosition({ [HubPosition.BOTTOM]: NaN }, HubPosition.BOTTOM))
      .toEqual({ kind: 'invalid', value: NaN });
    expect(lookupPosition({ [HubPosition.BOTTOM]: Infinity }, HubPosition.BOTTOM))
      .toEqual({ kind: 'invalid', value: Infinity });
    expect(lookupPosition({ [HubPosition.BOTTOM]: '50' as never }, HubPosition.BOTTOM))
      .toEqual({ kind: 'invalid', value: '50' });
  });

  it('does not confuse an inherited property with a returned position', () => {
    expect(lookupPosition(Object.create({ [HubPosition.BOTTOM]: 99 }), HubPosition.BOTTOM))
      .toEqual({ kind: 'missing' });
  });
});

describe('sanitizePositionMap', () => {
  it('keeps valid kind/value pairs', () => {
    expect(sanitizePositionMap({ [HubPosition.BOTTOM]: 32768, [HubPosition.TOP]: 0 }))
      .toEqual({ [HubPosition.BOTTOM]: 32768, [HubPosition.TOP]: 0 });
  });

  it('drops unusable values', () => {
    expect(sanitizePositionMap({ [HubPosition.BOTTOM]: 'x', [HubPosition.TOP]: 5 }))
      .toEqual({ [HubPosition.TOP]: 5 });
    expect(sanitizePositionMap({ [HubPosition.BOTTOM]: NaN })).toEqual({});
  });

  it('drops keys that are not position kinds', () => {
    expect(sanitizePositionMap({ 0: 1, 4: 2, 99: 3, nope: 4 })).toEqual({});
  });

  it('returns an empty map for anything that is not an object', () => {
    for (const v of [undefined, null, 42, 'positions', [], true]) {
      expect(sanitizePositionMap(v), String(v)).toEqual({});
    }
  });

  it('ignores a prototype-pollution key from persisted context', () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "1": 500}');
    expect(sanitizePositionMap(parsed)).toEqual({ [HubPosition.BOTTOM]: 500 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('positionMapsEqual', () => {
  it('is true for the same pairs regardless of key order', () => {
    expect(positionMapsEqual(
      { [HubPosition.BOTTOM]: 1, [HubPosition.TOP]: 2 },
      { [HubPosition.TOP]: 2, [HubPosition.BOTTOM]: 1 },
    )).toBe(true);
  });

  it('is true for two empty maps', () => {
    expect(positionMapsEqual({}, {})).toBe(true);
  });

  it('is false when a value differs', () => {
    expect(positionMapsEqual({ [HubPosition.BOTTOM]: 1 }, { [HubPosition.BOTTOM]: 2 })).toBe(false);
  });

  it('is false when one side has an extra key', () => {
    expect(positionMapsEqual(
      { [HubPosition.BOTTOM]: 1 },
      { [HubPosition.BOTTOM]: 1, [HubPosition.TOP]: 0 },
    )).toBe(false);
    expect(positionMapsEqual(
      { [HubPosition.BOTTOM]: 1, [HubPosition.TOP]: 0 },
      { [HubPosition.BOTTOM]: 1 },
    )).toBe(false);
  });

  it('treats a missing map as empty', () => {
    expect(positionMapsEqual(undefined, {})).toBe(true);
    expect(positionMapsEqual(undefined, { [HubPosition.BOTTOM]: 1 })).toBe(false);
  });
});

describe('isWithinQuietHours', () => {
  const at = (hour: number, minute = 0) => new Date(2026, 8, 3, hour, minute);

  it('matches inside a same-day window', () => {
    expect(isWithinQuietHours(at(10), 9, 17)).toBe(true);
    expect(isWithinQuietHours(at(8), 9, 17)).toBe(false);
  });

  it('wraps across midnight', () => {
    expect(isWithinQuietHours(at(23, 54), 21, 8)).toBe(true);
    expect(isWithinQuietHours(at(5, 54), 21, 8)).toBe(true);
    expect(isWithinQuietHours(at(11, 54), 21, 8)).toBe(false);
  });

  it('treats start as inclusive and end as exclusive', () => {
    expect(isWithinQuietHours(at(21), 21, 8)).toBe(true);
    expect(isWithinQuietHours(at(8), 21, 8)).toBe(false);
  });

  it('is disabled when start equals end', () => {
    expect(isWithinQuietHours(at(3), 8, 8)).toBe(false);
  });
});

describe('resolveQuietHours', () => {
  it('defaults to 21:00-08:00', () => {
    expect(resolveQuietHours({})).toEqual({ startHour: 21, endHour: 8 });
  });

  it('accepts a custom window', () => {
    expect(resolveQuietHours({ quietHours: { start: 22, end: 7 } }))
      .toEqual({ startHour: 22, endHour: 7 });
  });

  it('can be disabled with false', () => {
    const q = resolveQuietHours({ quietHours: false });
    expect(q.startHour).toBe(q.endHour);
  });

  it('falls back to defaults on out-of-range input', () => {
    expect(resolveQuietHours({ quietHours: { start: 25, end: -3 } }))
      .toEqual({ startHour: 21, endHour: 8 });
  });
});

describe('resolveShadeCapability', () => {
  it('prefers the hub-reported capabilities field when present', () => {
    // The hub knows better than any type table; type 1 would say 0.
    expect(resolveShadeCapability({ type: 1, capabilities: 7 })).toBe(7);
    expect(resolveShadeCapability({ type: 1, capabilities: 0 })).toBe(0);
  });

  it('falls back to the documented type table', () => {
    expect(resolveShadeCapability({ type: 1 })).toBe(0);   // Roller/Solar
    expect(resolveShadeCapability({ type: 7 })).toBe(6);   // Top Down - reversed rail
    expect(resolveShadeCapability({ type: 23 })).toBe(1);  // Silhouette
    expect(resolveShadeCapability({ type: 51 })).toBe(2);  // Venetian, tilt 180
    expect(resolveShadeCapability({ type: 55 })).toBe(3);  // Vertical slats
    expect(resolveShadeCapability({ type: 66 })).toBe(5);  // Shutter, tilt only
    expect(resolveShadeCapability({ type: 79 })).toBe(8);  // Duolite lift
  });

  it('ignores an out-of-range capabilities value and uses the table', () => {
    expect(resolveShadeCapability({ type: 7, capabilities: 99 })).toBe(6);
    expect(resolveShadeCapability({ type: 7, capabilities: -1 })).toBe(6);
  });

  it('returns undefined for an unknown type with no capabilities', () => {
    expect(resolveShadeCapability({ type: 12345 })).toBeUndefined();
    expect(resolveShadeCapability({})).toBeUndefined();
  });

  it('covers every type in the documented table', () => {
    const documented = {
      1: 0, 4: 0, 5: 0, 6: 0, 7: 6, 8: 7, 9: 7, 18: 1, 23: 1, 38: 9,
      42: 0, 43: 1, 44: 1, 47: 7, 49: 0, 51: 2, 54: 3, 55: 3, 56: 3,
      62: 2, 65: 8, 66: 5, 69: 4, 70: 4, 71: 4, 79: 8,
    } as Record<number, number>;
    for (const [type, capability] of Object.entries(documented)) {
      expect(resolveShadeCapability({ type: Number(type) }), `type ${type}`).toBe(capability);
    }
    expect(Object.keys(documented)).toHaveLength(26);
  });
});

describe('shadeKindForCapability', () => {
  it('maps every documented capability to a kind', () => {
    for (let capability = 0; capability <= 9; ++capability) {
      expect(shadeKindForCapability(capability), `capability ${capability}`).toBeDefined();
    }
  });

  it('distinguishes the tilt ranges that share a kind today', () => {
    // Capability 1 is 90 degrees, 2 and 5 are 180. Conflating them mis-scales tilt.
    expect(shadeKindForCapability(1)).not.toEqual(shadeKindForCapability(2));
  });

  it('treats top-down as its own kind, since its primary rail is reversed', () => {
    expect(shadeKindForCapability(6)).not.toEqual(shadeKindForCapability(0));
  });
});
