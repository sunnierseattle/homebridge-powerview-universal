import type { Logging } from 'homebridge';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HubErrorCode, isHubError } from './errors.js';
import { PowerViewHub } from './powerviewHub.js';

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logging;

function hub(): PowerViewHub {
  return new PowerViewHub(log, '127.0.0.1');
}

describe('PowerViewHub.requestJson', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries on HTTP 423 then succeeds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 423,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ userData: { hubName: 'SHVi', serialNumber: 'abc' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ sceneIds: [], sceneData: [] }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const request = hub().requestJson<{ sceneIds: number[] }>('http://127.0.0.1/api/scenes');
    await vi.runAllTimersAsync();
    const result = await request;
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('maps HTTP 404 to NotFound', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
      json: async () => ({}),
    }));

    await expect(hub().requestJson('http://127.0.0.1/api/scenes')).rejects.toSatisfy(
      (err: unknown) => isHubError(err) && err.code === HubErrorCode.NotFound,
    );
  });

  it('rejects combined refresh and updateBatteryLevel', async () => {
    await expect(
      hub().getShade(1, { refresh: true, updateBatteryLevel: true }),
    ).rejects.toSatisfy(
      (err: unknown) => isHubError(err) && err.code === HubErrorCode.BadRequest,
    );
  });
});
