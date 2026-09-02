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

describe('PowerViewHub request timeout', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('aborts a hung request instead of waiting forever', async () => {
    vi.useFakeTimers();
    // A hub that accepts the connection and never answers. Node's fetch has no
    // default timeout, so without an AbortController this promise never settles.
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    }));

    const request = hub().requestJson('http://127.0.0.1/api/userdata', undefined, {
      retriesOnMaintenance: false,
    });
    const assertion = expect(request).rejects.toSatisfy(
      (err: unknown) => isHubError(err) && err.code === HubErrorCode.Timeout,
    );
    await vi.advanceTimersByTimeAsync(20000);
    await assertion;
  });
});

describe('PowerViewHub queue', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('advances past a request whose URL cannot be built', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ shade: { id: 2, name: 'UmlnaHQ=' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    // A host that makes `new URL()` throw. Upstream builds the URL outside the
    // try block, so the throw escapes before `queue.shift()` — the head of the
    // queue is never removed, nothing reschedules, and every later request hangs
    // unresolved forever.
    const h = new PowerViewHub(log, 'bad host:::');
    const first = h.getShade(1, { refresh: true });
    const second = h.getShade(2, { refresh: true });

    const firstAssertion = expect(first).rejects.toBeInstanceOf(Error);
    const secondAssertion = expect(second).rejects.toBeInstanceOf(Error);
    await vi.runAllTimersAsync();
    await firstAssertion;
    await secondAssertion;
  });
});
