/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  // Relative base so the build can be hosted from any sub-path (e.g. GitHub Pages).
  base: './',
  plugins: [preact()],
  server: {
    // Fixed port: .vscode/launch.json opens this URL.
    port: 5173,
    strictPort: true,
  },
  build: {
    // Three.js alone is ~550 kB minified; revisit with code-splitting if it grows a lot.
    chunkSizeWarningLimit: 900,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
