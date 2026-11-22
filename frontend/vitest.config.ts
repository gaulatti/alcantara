import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: [
      {
        find: /^@gaulatti\/bleecker$/,
        replacement: fileURLToPath(new URL('./app/bleecker.ts', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'jsdom',
    // Both suffixes: .test.ts files were silently skipped before (gaulatti/alcantara#253).
    include: ['app/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    // Coverage (gaulatti/alcantara#181), on with `pnpm run test:coverage`: native V8 counts over every
    // runtime source under app/, including files no test imports, reported as Istanbul JSON at
    // coverage/coverage-final.json plus a text summary. Only tests and declarations are left out. There
    // is no threshold yet; #83 adds the gate.
    coverage: {
      provider: 'v8',
      all: true,
      include: ['app/**/*.{ts,tsx}'],
      exclude: ['app/**/*.test.{ts,tsx}', 'app/**/*.d.ts'],
      reporter: ['json', 'text-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
