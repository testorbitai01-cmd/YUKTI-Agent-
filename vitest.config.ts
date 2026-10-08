import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/test/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
    testTimeout: 20_000,
  },
});
