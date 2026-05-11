import { defineConfig } from 'tsup';

export default defineConfig({
  banner: {
    js: '#!/usr/bin/env node',
  },
  clean: true,
  dts: false,
  entry: {
    'cli/index': 'src/cli/index.ts',
  },
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  shims: false,
  sourcemap: true,
  splitting: false,
  target: 'node20',
});
