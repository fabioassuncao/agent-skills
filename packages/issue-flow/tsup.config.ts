import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'es2022',
  // node:sqlite has no bare-specifier alias; stripping the prefix breaks the package.
  removeNodeProtocol: false,
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
