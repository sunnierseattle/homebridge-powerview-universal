import { describe, expect, it } from 'vitest';

import { HubPosition } from './powerviewHub.js';
import {
  POSITION_KIND_ERROR,
  decodeBase64Name,
  formatShadeFirmware,
  isLowBattery,
  parsePositionMap,
  resolveBatteryReading,
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
