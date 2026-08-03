import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4200,
    // The SPA and the API are separate origins in dev. Proxying /api keeps the
    // browser same-origin, so there is no CORS config to get wrong here and
    // none to accidentally ship to production.
    proxy: {
      '/api': {
        target: process.env.INFINITY_API_URL ?? 'http://127.0.0.1:8099',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
