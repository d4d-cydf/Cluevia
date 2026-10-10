import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Windows-mounted workspaces need polling to reliably pick up editor changes.
  server: { watch: { usePolling: true, interval: 250 } },
});
