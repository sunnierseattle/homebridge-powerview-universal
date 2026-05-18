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
    await hub.getFirmwareVersion();
    capabilities.fwVersionSupported = true;
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
