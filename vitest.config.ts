import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'server',
          include: ['server/test/**/*.test.ts'],
          environment: 'node',
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['shared/**/*.test.ts', 'web/src/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
