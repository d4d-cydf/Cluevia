import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { aipApiPlugin } from './server/vite-api-plugin';

export default defineConfig({
  plugins: [react(), aipApiPlugin()],
  // Windows-mounted workspaces need polling to reliably pick up editor changes.
  server: { watch: { usePolling: true, interval: 250 } },
});
