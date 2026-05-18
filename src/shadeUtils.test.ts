import { describe, expect, it } from 'vitest';

import { HubPosition } from './powerviewHub.js';
import {
  POSITION_KIND_ERROR,
  decodeBase64Name,
  formatShadeFirmware,
  isLowBattery,
  parsePositionMap,
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
