import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/unit/**/*.test.ts',
      'tests/adapters/**/*.test.ts',
      'tests/browser/**/*.browser.test.ts',
    ],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
    },
  },
});
