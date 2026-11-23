import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    // @modoitaliano/giorgia depends on its own React; two copies break hooks in its components.
    dedupe: ['react', 'react-dom'],
    alias: [
      {
        find: /^@gaulatti\/bleecker$/,
        replacement: fileURLToPath(new URL('./app/bleecker.ts', import.meta.url)),
      },
    ],
  },
  test: {
    // Inline the library so its React import resolves to the app's single copy (see resolve.dedupe).
    server: { deps: { inline: [/@modoitaliano\/giorgia/] } },
    environment: 'jsdom',
    // Both suffixes: .test.ts files were silently skipped before (gaulatti/alcantara#253).
    include: ['app/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    // Coverage (gaulatti/alcantara#181), on with `pnpm run test:coverage`: native V8 counts over every
    // runtime source under app/, including files no test imports, reported as Istanbul JSON at
    // coverage/coverage-final.json plus a text summary. Only tests and declarations are left out. There
    // is no threshold yet; #83 adds the gate.
    // Forks are capped at 4 (gaulatti/alcantara#83): with coverage on, the default one-fork-per-core
    // saturates the machine, the workers' task updates starve the main process and vitest ends the run
    // with `Timeout calling "onTaskUpdate"` (an unhandled error, exit 1). Measured on 172 files / 1,570
    // tests: no coverage 30 s; coverage with 4 forks 96 s and with 2 forks 121 s, both exit 0; coverage
    // with the default 9 forks 86 s and the timeout. No timeout is raised.
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
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
