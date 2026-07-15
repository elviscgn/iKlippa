import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: 'public',
  root: '.',
  server: {
    port: 8080,
    headers: {
      // Required for SharedArrayBuffer / WASM threads / WebCodecs
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
