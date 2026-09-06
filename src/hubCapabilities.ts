import type { Logging } from 'homebridge';

import { HubErrorCode, isHubError } from './errors.js';
import type { PowerViewHub } from './powerviewHub.js';

export interface HubCapabilities {
  fwVersionSupported: boolean;
  scenesSupported: boolean;
  sceneCollectionsSupported: boolean;
  generationHint: 'gen1' | 'gen2' | 'unknown';
}

export function generationHintFromHubName(name: string | undefined): HubCapabilities['generationHint'] {
  if (!name) {
    return 'unknown';
  }
  if (/hub\s*2|2\.0|gen\s*2/i.test(name)) {
    return 'gen2';
  }
  if (/hub\s*1|1\.0|gen\s*1/i.test(name)) {
    return 'gen1';
  }
  return 'unknown';
}

/**
 * Gen 1 and Gen 2 hubs both report mainProcessor.name = "PowerView Hub", so the
 * name alone can never identify the generation. The firmware major revision does:
 * Gen 1 reports revision 1, Gen 2 reports revision 2. Gen 1 hubs additionally
 * expose no `radio` firmware block at all.
 */
export function generationHintFromFirmware(
  firmware: { mainProcessor?: { revision?: number } } | undefined,
): HubCapabilities['generationHint'] {
  const revision = firmware?.mainProcessor?.revision;
  if (revision === 1) {
    return 'gen1';
  }
  if (revision === 2) {
    return 'gen2';
  }
  return 'unknown';
}

export async function probeHubCapabilities(
  hub: PowerViewHub,
  log: Logging,
  hubFirmwareName?: string,
): Promise<HubCapabilities> {
  const capabilities: HubCapabilities = {
    fwVersionSupported: false,
    scenesSupported: false,
    sceneCollectionsSupported: false,
    generationHint: generationHintFromHubName(hubFirmwareName),
  };

  try {
    const firmware = await hub.getFirmwareVersion();
    capabilities.fwVersionSupported = true;
    if (capabilities.generationHint === 'unknown') {
      capabilities.generationHint = generationHintFromFirmware(firmware);
    }
  } catch (err) {
    if (isHubError(err) && err.code === HubErrorCode.NotFound) {
      log.debug('Hub does not expose GET /api/fwversion');
    } else {
      log.warn('Could not probe /api/fwversion:', err instanceof Error ? err.message : String(err));
    }
  }

  try {
    await hub.getScenes();
    capabilities.scenesSupported = true;
  } catch (err) {
    if (isHubError(err) && err.code === HubErrorCode.NotFound) {
      log.debug('Hub does not expose GET /api/scenes');
    } else {
      log.warn('Could not probe /api/scenes:', err instanceof Error ? err.message : String(err));
    }
  }

  try {
    await hub.getSceneCollections();
    capabilities.sceneCollectionsSupported = true;
  } catch (err) {
    if (isHubError(err) && err.code === HubErrorCode.NotFound) {
      log.debug('Hub does not expose GET /api/scenecollections');
    } else {
      log.warn(
        'Could not probe /api/scenecollections:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return capabilities;
}

/**
 * Endpoints a Generation 3 Gateway answers and a Gen 1/2 hub does not.
 *
 * Gen 3 speaks an entirely different API — /home/... paths, with positions as
 * 0-1 floats rather than the 0-65535 integers used here — so every request this
 * plugin makes 404s against one. Documented paths, not observed: this was
 * written without a Gen 3 gateway to test against.
 */
const GEN3_PROBE_PATHS = [
  'http://{host}/home/shades',
  'http://{host}:3002/home/shades',
  'http://{host}/gateway',
];

const GEN3_PROBE_TIMEOUT_MS = 3000;

/**
 * Returns the endpoint that answered if the host looks like a Gen 3 Gateway.
 *
 * Only ever used to explain a startup failure, so it is deliberately timid: a
 * short timeout, no retries, and a JSON content type required before claiming
 * anything — an unrelated web server on that address must not be mistaken for a
 * gateway.
 */
export async function detectGen3Gateway(host: string): Promise<string | undefined> {
  for (const template of GEN3_PROBE_PATHS) {
    const url = template.replace('{host}', host);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(GEN3_PROBE_TIMEOUT_MS) });
      if (res.ok && (res.headers.get('content-type') ?? '').includes('application/json')) {
        return url;
      }
    } catch {
      // Unreachable, refused or timed out: not evidence of anything.
    }
  }
  return undefined;
}
