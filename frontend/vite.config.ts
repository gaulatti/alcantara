import { fileURLToPath } from 'node:url';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@gaulatti\/bleecker$/,
        replacement: fileURLToPath(new URL('./node_modules/@gaulatti/bleecker/dist/index.js', import.meta.url))
      }
    ]
  },
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths()]
});
