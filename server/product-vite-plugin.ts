import { loadEnv } from 'vite';
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import { createProductBackend } from './product-api.ts';
import { readProductConfig } from './product-config.ts';

export function productApiPlugin(): Plugin {
  let resolved: ResolvedConfig;
  async function configure(server: Pick<ViteDevServer, 'middlewares' | 'httpServer'>) {
    const environment = { ...loadEnv(resolved.mode, resolved.envDir, ''), ...process.env };
    const backend = await createProductBackend(readProductConfig(resolved.root, environment));
    if (server.httpServer && 'requestTimeout' in server.httpServer) server.httpServer.requestTimeout = 0;
    server.middlewares.use(backend.middleware);
    server.httpServer?.once('close', () => { void backend.close(); });
  }
  return { name: 'cluevia-product-api', configResolved(config) { resolved = config; }, configureServer: configure, configurePreviewServer: configure };
}
