import { afterEach, describe, expect, it, vi } from 'vitest';

import { detectGen3Gateway } from './hubCapabilities.js';

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('detectGen3Gateway', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('recognises a Generation 3 Gateway by its own API', async () => {
    // A Gen 3 Gateway 404s every /api/ path this plugin uses, so a user sees
    // only "NotFound" with no hint that their hub speaks a different protocol.
    vi.stubGlobal('fetch', vi.fn((url: string) => (
      String(url).includes('/home/shades')
        ? Promise.resolve(ok({ shadeData: [] }))
        : Promise.resolve(new Response('', { status: 404 }))
    )));

    await expect(detectGen3Gateway('hub.local')).resolves.toContain('/home/shades');
  });

  it('says nothing when no Gen 3 endpoint answers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    await expect(detectGen3Gateway('hub.local')).resolves.toBeUndefined();
  });

  it('does not claim Gen 3 when the host is simply unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(detectGen3Gateway('hub.local')).resolves.toBeUndefined();
  });

  it('does not claim Gen 3 on a non-JSON answer', async () => {
    // A captive portal or unrelated web server on that address answers 200.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('<html>router login</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    ));
    await expect(detectGen3Gateway('hub.local')).resolves.toBeUndefined();
  });
});
