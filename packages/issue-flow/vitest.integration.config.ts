import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.integration.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
  },
});
