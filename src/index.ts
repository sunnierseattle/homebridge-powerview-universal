import type { API } from 'homebridge';

import { PowerViewPlatform } from './platform.js';
import { PLATFORM_NAME } from './settings.js';

/**
 * Registers the PowerView platform with Homebridge.
 */
export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, PowerViewPlatform);
};
