import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.integration.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    /**
     * One integration file at a time.
     *
     * These files share the machine's real resources — tmux servers, a docker
     * daemon, git — and several of them are the §35 performance budgets,
     * measured as a median of wall-clock samples. Run in parallel, those
     * samples measure the neighbours rather than the code: the same
     * `ensureSessionLayout` was measured at 89 ms alone and 473 ms beside a
     * suite that was launching containers, which turns a budget into a
     * coin toss.
     *
     * It is also not slower. The work is dominated by external processes
     * competing for the same CPU either way, and the whole suite measured
     * ~28 s serial against ~38 s parallel on the same machine.
     */
    fileParallelism: false,
  },
});
