import type { Logging } from 'homebridge';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HubErrorCode, isHubError } from './errors.js';
import { HubPosition, PowerViewHub } from './powerviewHub.js';

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

describe('PowerViewHub serialisation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('never has two requests in flight against the hub at once', async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 50));
      inFlight -= 1;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ firmware: { mainProcessor: { name: 'PowerView Hub' } } }),
      };
    }));

    const h = hub();
    // Capability probes bypass the shade queue; upstream fired these in parallel
    // with shade reads, which made the hub time out and return truncated JSON.
    const all = Promise.all([
      h.getFirmwareVersion(),
      h.getUserData().catch(() => undefined),
      h.getScenes().catch(() => undefined),
      h.getSceneCollections().catch(() => undefined),
    ]);
    await vi.runAllTimersAsync();
    await all;

    expect(maxInFlight).toBe(1);
  });
});

describe('PowerViewHub.stopShade', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends motion stop, not jog', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ shade: { id: 7 } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await hub().stopShade(7);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/shades/7');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ shade: { motion: 'stop' } });
  });
});

describe('PowerViewHub request serialisation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not start the next request until the previous body is read', async () => {
    vi.useFakeTimers();

    const events: string[] = [];
    let releaseFirstBody: (() => void) | undefined;

    const fetchMock = vi.fn((url: string) => {
      events.push(`fetch:${url}`);
      const first = url.endsWith('/first');
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => {
          events.push(`body-start:${url}`);
          if (!first) {
            events.push(`body-end:${url}`);
            return Promise.resolve({ ok: true });
          }
          // Headers have arrived, but the body is still streaming. The hub
          // answers one request at a time, so nothing else may go out yet.
          return new Promise((resolve) => {
            releaseFirstBody = () => {
              events.push(`body-end:${url}`);
              resolve({ ok: true });
            };
          });
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = hub();
    const first = client.requestJson('http://127.0.0.1/first');
    const second = client.requestJson('http://127.0.0.1/second');

    // Drain every timer the interval spacing schedules. The second request must
    // still be blocked, because the first response body has not been consumed.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(events).toEqual(['fetch:http://127.0.0.1/first', 'body-start:http://127.0.0.1/first']);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseFirstBody?.();
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all([first, second]);

    expect(events).toEqual([
      'fetch:http://127.0.0.1/first',
      'body-start:http://127.0.0.1/first',
      'body-end:http://127.0.0.1/first',
      'fetch:http://127.0.0.1/second',
      'body-start:http://127.0.0.1/second',
      'body-end:http://127.0.0.1/second',
    ]);
  });
});

describe('PowerViewHub shade request coalescing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function shadeFetch() {
    const fetchMock = vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ shade: { id: 1, name: 'U2hhZGU=' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('serves two identical battery reads from one hub request', async () => {
    vi.useFakeTimers();
    const fetchMock = shadeFetch();
    const client = hub();

    const both = Promise.all([
      client.getShade(1, { updateBatteryLevel: true }),
      client.getShade(1, { updateBatteryLevel: true }),
    ]);
    await vi.advanceTimersByTimeAsync(5_000);
    const [first, second] = await both;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.id).toBe(1);
    expect(second.id).toBe(1);
  });

  it('merges pending writes for one shade into a single PUT', async () => {
    vi.useFakeTimers();
    const fetchMock = shadeFetch();
    const client = hub();

    // HomeKit sends position and tilt as separate sets; the hub takes one
    // combined positions object.
    const both = Promise.all([
      client.putShade(1, HubPosition.BOTTOM, 49151, 75),
      client.putShade(1, HubPosition.VANES, 16383, 45),
    ]);
    await vi.advanceTimersByTimeAsync(5_000);
    await both;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      shade: { positions: { posKind1: 3, position1: 16383 } },
    });
  });
});

describe('PowerViewHub request priority', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('lets a write overtake reads already waiting in the queue', async () => {
    vi.useFakeTimers();

    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const label = init?.method === 'PUT' ? 'write' : `read:${/(\d+)$/.exec(url)?.[1] ?? '?'}`;
      order.push(label);
      const body = { shade: { id: 1, name: 'U2hhZGU=' } };
      const respond = () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => body,
      });
      if (order.length === 1) {
        // Hold the first request open so the rest pile up behind it.
        return new Promise((resolve) => {
          releaseFirst = () => resolve(respond());
        });
      }
      return Promise.resolve(respond());
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = hub();
    const first = client.getShade(1);
    await vi.advanceTimersByTimeAsync(10);

    // Both queue while the first request is still in flight. HomeKit's write
    // must not wait behind a background read.
    const queuedRead = client.getShade(2);
    const write = client.putShade(3, HubPosition.BOTTOM, 49151, 75);
    await vi.advanceTimersByTimeAsync(200);

    releaseFirst?.();
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all([first, queuedRead, write]);

    expect(order).toEqual(['read:1', 'write', 'read:2']);
  });
});

describe('PowerViewHub transient failures', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('retries a dropped connection instead of losing the command', async () => {
    vi.useFakeTimers();
    // A gen1 hub drops TCP connections while its radio is transmitting. Losing
    // the request means the shade never moves at all.
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ shade: { id: 1, name: 'U2hhZGU=' } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const request = hub().putShade(1, HubPosition.BOTTOM, 49151, 75);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(request).resolves.toMatchObject({ id: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after exhausting retries', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    const request = hub().requestJson('http://127.0.0.1/api/shades/1');
    const assertion = expect(request).rejects.toSatisfy(
      (err: unknown) => isHubError(err) && err.code === HubErrorCode.Unreachable,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});
