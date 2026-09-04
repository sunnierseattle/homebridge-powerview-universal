import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      include: ['src/**/*.ts'],
      // Neither the specs nor the Homebridge test doubles are shipped code.
      exclude: ['src/**/*.test.ts', 'src/**/*.harness.ts'],
    },
  },
});
