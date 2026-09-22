import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/lib/__tests__/**/*.ts'],
    setupFiles: ['./src/test/setup-idb.ts'],
  },
});
