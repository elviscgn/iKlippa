import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: 'public',
  root: '.',
  server: {
    port: 8080,
    proxy: {
      '/api': {
        target: 'http://localhost:8081',
        changeOrigin: true,
      },
    },
    headers: {
      // Required for SharedArrayBuffer / WASM threads / WebCodecs
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      input: {
        landing: 'index.html',
        editor: 'editor.html',
      },
    },
  },
});
