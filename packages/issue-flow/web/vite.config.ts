import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/** Dashboard build and development proxy. */

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
