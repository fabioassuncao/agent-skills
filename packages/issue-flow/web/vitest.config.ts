import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    resolve: {
      conditions: ['browser'],
    },
    test: {
      environment: 'happy-dom',
      include: ['src/**/*.test.ts'],
      setupFiles: ['src/test-setup.ts'],
    },
  }),
);
