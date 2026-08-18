import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Serve the print entry for /print/* in DEV, matching what nginx does in
 * production (web/nginx.conf). Without it, Vite's SPA fallback hands
 * /print/report/:sid the main app's index.html, so the bundle split would be
 * invisible until a real build — and the render service, which loads these
 * routes, would behave differently in dev than in prod.
 *
 * Only paths under /print/ (with the slash) are rewritten, so /print.html
 * itself and every asset request pass through untouched.
 */
function printEntryDevRouting(): PluginOption {
  return {
    name: 'print-entry-dev-routing',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const path = (req.url ?? '').split('?')[0];
        if (/^\/print\//.test(path)) req.url = '/print.html';
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), printEntryDevRouting()],
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
    rollupOptions: {
      // Two entries. `main` is the application; `print` is the minimal bundle
      // the render service and the preview iframe load (see src/print.tsx).
      // Rollup hoists what they share — React, the router — into a common chunk
      // that is cached once and reused by both.
      input: {
        main: 'index.html',
        print: 'print.html',
      },
    },
  },
});
