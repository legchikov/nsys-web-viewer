import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
// @ts-expect-error plain JS module shared with the production server
import { handleApi } from './server/nsys.mjs';

/** Mount the local /api helpers (nsys-rep → sqlite conversion) on the dev and preview servers. */
function nsysApi(): Plugin {
  const mw = (req: any, res: any, next: () => void) => {
    handleApi(req, res)
      .then((handled: boolean) => {
        if (!handled) next();
      })
      .catch((err: unknown) => {
        res.statusCode = 500;
        res.end(String(err));
      });
  };
  return {
    name: 'nsys-api',
    configureServer(server) {
      server.middlewares.use(mw);
    },
    configurePreviewServer(server) {
      server.middlewares.use(mw);
    },
  };
}

export default defineConfig({
  plugins: [react(), nsysApi()],
  worker: { format: 'es' },
  // Pre-bundle sql.js so the first profile load in dev mode doesn't trigger a reload.
  optimizeDeps: { include: ['sql.js'] },
  server: { host: '127.0.0.1', port: 5173, open: !process.env.NO_OPEN },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
