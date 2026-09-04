import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PLUGIN_NAME } from './settings.js';

describe('PLUGIN_NAME', () => {
  it('matches the npm package name', () => {
    // Homebridge resolves the plugin by this identifier when accessories are
    // registered, so a drift from package.json orphans every accessory.
    const packageJson = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { name: string };

    expect(PLUGIN_NAME).toBe(packageJson.name);
  });
});
