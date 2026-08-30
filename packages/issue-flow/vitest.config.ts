import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
    // Points ISSUE_FLOW_HOME at a throwaway directory for every test file, so a
    // suite that forgets its own setup cannot write into the real ~/.issue-flow.
    setupFiles: ['src/test-setup.ts'],
  },
});
