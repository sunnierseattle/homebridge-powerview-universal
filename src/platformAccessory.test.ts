import { Characteristic, Service } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHarness, type Harness } from './homebridge.harness.js';
import { PowerViewPlatform } from './platform.js';
import { PowerViewPlatformAccessory } from './platformAccessory.js';
import type { PowerViewShade } from './powerviewHub.js';
import { ShadeKind, SUBTYPE, type PowerViewPlatformConfig, type ShadeContext } from './settings.js';

/** A real Response, so body streaming and size limits behave as in production. */
function hubResponse(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: contentType ? { 'content-type': contentType } : {},
  });
}

/** 75% of the hub's 0-65535 range. */
const HUB_75_PERCENT = 49151;
/** 45 degrees of the hub's 0-32767 vane range. */
const HUB_45_DEGREES = 16383;

function config(): PowerViewPlatformConfig {
  return {
    platform: 'PowerView',
    name: 'PowerView',
    host: '127.0.0.1',
    syncPositionsOnStart: false,
  } as PowerViewPlatformConfig;
}

function shade(positions: Record<string, number>): PowerViewShade {
  return { id: 1, name: 'U2hhZGU=', positions } as PowerViewShade;
}

function bottomService(accessory: PlatformAccessory<ShadeContext>): Service {
  const service = accessory.getServiceById(Service.WindowCovering, SUBTYPE.BOTTOM);
  if (!service) {
    throw new Error('no bottom Window Covering service');
  }
  return service;
}

describe('PowerViewPlatformAccessory', () => {
  let harness: Harness;
  let platform: PowerViewPlatform;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(hubResponse(({}), 200, 'application/json')));
    harness = createHarness();
    platform = new PowerViewPlatform(harness.log, config(), harness.api);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function handlerFor(shadeType: ShadeKind, lastPositions?: Record<number, number>) {
    const accessory = harness.newAccessory('Shade 1', {
      shadeId: 1,
      shadeType,
      jogSupported: true,
      ...(lastPositions ? { lastPositions } : {}),
    });
    return { accessory, handler: new PowerViewPlatformAccessory(platform, accessory, harness.log) };
  }

  it('restores the persisted position instead of reporting fully closed', () => {
    // Persisting positions is pointless if configure() then slams the
    // characteristic to 0, which HomeKit renders as "fully closed".
    const accessory = harness.newAccessory('Shade 1', {
      shadeId: 1,
      shadeType: ShadeKind.ROLLER,
      jogSupported: true,
      lastPositions: { 1: 75 },
    });

    platform.configureAccessory(accessory as PlatformAccessory);

    expect(bottomService(accessory).getCharacteristic(Characteristic.CurrentPosition).value)
      .toBe(75);
  });

  it('keeps the reported position when a tilt value arrives for a horizontal shade', () => {
    const { accessory, handler } = handlerFor(ShadeKind.HORIZONTAL);

    handler.updateShadeValues(shade({
      posKind1: 1,
      position1: HUB_75_PERCENT,
      posKind2: 3,
      position2: HUB_45_DEGREES,
    }), true);

    const service = bottomService(accessory);
    expect(service.getCharacteristic(Characteristic.CurrentPosition).value).toBe(75);
    expect(service.getCharacteristic(Characteristic.CurrentHorizontalTiltAngle).value).toBe(45);
  });

  it('keeps the reported position when a tilt value arrives for a vertical shade', () => {
    const { accessory, handler } = handlerFor(ShadeKind.VERTICAL);

    handler.updateShadeValues(shade({
      posKind1: 1,
      position1: HUB_75_PERCENT,
      posKind2: 3,
      position2: 0,
    }), true);

    expect(bottomService(accessory).getCharacteristic(Characteristic.CurrentPosition).value)
      .toBe(75);
  });

  it('never caches NaN from an unusable vertical tilt value', () => {
    const { accessory, handler } = handlerFor(ShadeKind.VERTICAL);

    // posKind present with no matching position: the arithmetic yields NaN.
    // HAP rejects the characteristic write, but the NaN still reaches the
    // position map — where it defeats positionMapsEqual (NaN !== NaN), so
    // every subsequent read rewrites the accessory cache file.
    const positions = handler.updateShadeValues(shade({ posKind1: 3 }), true);

    expect(Object.values(positions ?? {}).some(Number.isNaN)).toBe(false);
    const value = bottomService(accessory)
      .getCharacteristic(Characteristic.CurrentVerticalTiltAngle).value;
    expect(Number.isNaN(value)).toBe(false);
  });

  it('reads every reported position kind, even across a gap', () => {
    const { accessory, handler } = handlerFor(ShadeKind.TOP_BOTTOM);

    // posKind2 absent: the old loop stopped dead and never saw posKind3.
    const positions = handler.updateShadeValues(shade({
      posKind1: 1,
      position1: HUB_75_PERCENT,
      posKind3: 2,
      position3: HUB_75_PERCENT,
    }), true);

    expect(positions?.[2]).toBe(75);
    const top = accessory.getServiceById(Service.WindowCovering, SUBTYPE.TOP);
    expect(top?.getCharacteristic(Characteristic.CurrentPosition).value).toBe(75);
  });
});
