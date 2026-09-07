import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

/**
 * The dashboard suite.
 *
 * PORT of `frontend/vitest.config.ts` @ d8c9d5f. It is a **separate** config
 * from the package's `vitest.config.ts`: the CLI suite runs in Node against
 * `src/**`, this one runs in a DOM against `web/src/**`, and merging them would
 * force the Node suite to pay for a browser environment it never uses.
 */
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
