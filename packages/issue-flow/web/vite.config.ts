import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/**
 * The dashboard build.
 *
 * PORT of `frontend/vite.config.ts` from windmill-labs/webmux @ d8c9d5f, with
 * four adaptations:
 *
 * - **`root` is this directory**, not the package root, because the CLI's
 *   `tsup` build owns the package root. Two pipelines, one repository — §48.2.
 * - **`outDir` is `web/dist/`**, which `src/web/server.ts` serves as static
 *   assets. The old panel stays exactly where it is (`web/public/`, ADR-18) and
 *   is served at `/legacy/`.
 * - **The contract is aliased to source**, not linked as a package. It carries
 *   its own `zod@3` (what `@ts-rest/core@3` peers on) while the CLI runs on
 *   `zod@4`; resolving from the alias keeps the two apart instead of forcing
 *   one of them to move.
 * - **The dev proxy points at the Issue Flow monitor** (`5111` upstream →
 *   `4318`, the monitor's default), and matches `/ws/terminal` as well as the
 *   prefixed `/<prefix>/api/` form.
 */

const backendPort = process.env.ISSUE_FLOW_WEB_PORT || '4318';
const backendUrl = `http://127.0.0.1:${backendPort}`;
const backendWs = `ws://127.0.0.1:${backendPort}`;
const port = Number.parseInt(process.env.ISSUE_FLOW_FRONTEND_PORT || '4319', 10);

// The server serves each project under its own `/<prefix>` (hub routes stay at
// the root), so the dev proxy has to match both `/api/...` and `/<prefix>/api/...`.
const apiContext = '^(/[^/]+)?/api/';
const wsContext = '^(/[^/]+)?/ws/';

const proxy = {
  [apiContext]: backendUrl,
  [wsContext]: {
    target: backendWs,
    ws: true,
  },
};

export default defineConfig({
  // The config lives with the app, not with the package it is built from, so
  // `root` is stated rather than inferred from the working directory: `npm run
  // build:web` runs from the package root.
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [svelte(), tailwindcss()],
  resolve: {
    alias: {
      '@issue-flow/contract': fileURLToPath(
        new URL('../../issue-flow-contract/src/index.ts', import.meta.url),
      ),
    },
  },
  // This app has no static assets of its own: the bundle embeds its fonts and
  // images as data URIs. Left at Vite's default, a `public/` someone dropped
  // here later would be copied into `dist/` and a `public/index.html` would
  // collide with the built one — which is exactly how the previous panel used
  // to end up shipped twice, before §50.8 removed it.
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/@xterm/')) {
            return 'vendor-xterm';
          }
        },
      },
    },
  },
  server: {
    // Loopback only, like every other Issue Flow web surface (ADR-10). The
    // upstream binds 0.0.0.0 here; that is the half of it this port rejects.
    host: '127.0.0.1',
    port,
    proxy,
  },
  preview: {
    host: '127.0.0.1',
    port: port + 1,
    proxy,
  },
});
