import { fileURLToPath } from 'node:url';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

const usePolling = process.env.VITE_USE_POLLING === 'true';
const port = Number(process.env.VITE_PORT) || 5173;

export default defineConfig({
  server: {
    host: true,
    port,
    allowedHosts: ['alcantara.dev'],
    watch: usePolling ? { usePolling: true, interval: 300 } : undefined
  },
  resolve: {
    alias: [
      {
        find: /^@gaulatti\/bleecker$/,
        // Bleecker 0.1.36's published root barrel references a missing
        // `dist/tokens.js`; keep public subpath imports behind a local barrel
        // until the upstream package is republished.
        replacement: fileURLToPath(new URL('./app/bleecker.ts', import.meta.url))
      }
    ]
  },
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths()]
});
