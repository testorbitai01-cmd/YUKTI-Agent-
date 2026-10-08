import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev: Vite serves the UI on :5174 and proxies the API + MCP endpoints to the YUKTI server on :3002.
// Production: the YUKTI server serves the built UI itself (same origin, no proxy).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:3002', changeOrigin: false },
      '/mcp': { target: 'http://localhost:3002', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
