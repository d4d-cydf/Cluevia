import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { productApiPlugin } from './server/product-vite-plugin';

export default defineConfig({
  plugins: [react(), productApiPlugin()],
  // Windows-mounted workspaces need polling to reliably pick up editor changes.
  server: { watch: { usePolling: true, interval: 250 } },
});
