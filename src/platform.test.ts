import type { PlatformAccessory } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHarness, type Harness } from './homebridge.harness.js';
import { PowerViewPlatform } from './platform.js';
import type { PowerViewPlatformConfig, ShadeContext } from './settings.js';

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  };
}

/** Answers every hub endpoint the platform touches during startup. */
function stubHub(shades: Array<Record<string, unknown>> = []) {
  const fetchMock = vi.fn((url: string) => {
    if (url.includes('/api/userdata')) {
      return Promise.resolve(jsonResponse({
        userData: { hubName: 'SHVi', serialNumber: 'abc', firmware: { mainProcessor: { name: 'PowerView Hub', revision: 2, subRevision: 0, build: 827 } } },
      }));
    }
    if (/\/api\/shades\/\d+/.test(url)) {
      const id = Number(/\/api\/shades\/(\d+)/.exec(url)?.[1]);
      return Promise.resolve(jsonResponse({ shade: shades.find((s) => s.id === id) ?? { id } }));
    }
    if (url.includes('/api/shades')) {
      return Promise.resolve(jsonResponse({ shadeData: shades, shadeIds: shades.map((s) => s.id) }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function config(overrides: Partial<PowerViewPlatformConfig> = {}): PowerViewPlatformConfig {
  return {
    platform: 'PowerView',
    name: 'PowerView',
    host: '127.0.0.1',
    syncPositionsOnStart: false,
    ...overrides,
  } as PowerViewPlatformConfig;
}

describe('PowerViewPlatform shutdown', () => {
  let harness: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    harness = createHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('stops the shade poll loop on shutdown', async () => {
    const fetchMock = stubHub([{ id: 1, name: 'U2hhZGU=', type: 23 }]);

    const platform = new PowerViewPlatform(
      harness.log,
      config({ pollShadesForUpdate: true }),
      harness.api,
    );
    expect(platform).toBeDefined();

    await harness.emit('didFinishLaunching');
    await vi.advanceTimersByTimeAsync(60_000);

    await harness.emit('shutdown');
    const callsAtShutdown = fetchMock.mock.calls.length;

    // Two further poll intervals. Nothing may reach the hub after shutdown.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock.mock.calls.length).toBe(callsAtShutdown);
  });
});

describe('PowerViewPlatform.setPosition', () => {
  let harness: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    harness = createHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reports an error instead of throwing when the shade is gone', async () => {
    stubHub();
    const platform = new PowerViewPlatform(harness.log, config(), harness.api);

    const callback = vi.fn();
    // Shade 99 was never registered — a set can still arrive for an accessory
    // Homebridge removed between HomeKit's read and write.
    await expect(
      platform.setPosition(99, 3 /* VANES */, 45, callback),
    ).resolves.toBeUndefined();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

describe('PowerViewPlatform.updateShades', () => {
  let harness: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    harness = createHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function shadeUrls(fetchMock: ReturnType<typeof stubHub>): string[] {
    return fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => /\/api\/shades\/\d+/.test(url));
  }

  it('does not refetch a shade the list already reported positions for', async () => {
    const fetchMock = stubHub([
      { id: 1, name: 'U2hhZGU=', type: 23, positions: { posKind1: 1, position1: 49151 } },
    ]);
    const platform = new PowerViewPlatform(harness.log, config(), harness.api);

    const done = platform.updateShades();
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    expect(shadeUrls(fetchMock)).toEqual([]);
  });

  it('still fetches a shade the list reported no positions for', async () => {
    const fetchMock = stubHub([{ id: 2, name: 'U2hhZGU=', type: 23 }]);
    const platform = new PowerViewPlatform(harness.log, config(), harness.api);

    const done = platform.updateShades();
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    expect(shadeUrls(fetchMock)).toHaveLength(1);
  });
});

export type { PlatformAccessory, ShadeContext };
