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
      {
        find: /^@desktop-host$/,
        replacement: fileURLToPath(new URL('./app/platform/desktopHost.none.ts', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'jsdom',
    // Every test starts from the provider default; a test that needs TEST AUTH stubs it. Compose sets
    // VITE_AUTH_MODE=test for the dev server, and it must not leak into the suite (gaulatti/alcantara#200).
    env: { VITE_AUTH_MODE: '' },
    // Both suffixes: .test.ts files were silently skipped before (gaulatti/alcantara#253).
    include: ['app/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    // The shared @gaulatti/bleecker widgets are inlined, so the suite's module mocks (hls.js, livekit-client)
    // reach the code that imports them, as they did when those widgets lived in the app.
    server: { deps: { inline: [/@gaulatti\/bleecker/] } },
    // Coverage (gaulatti/alcantara#181), on with `pnpm run test:coverage`: native V8 counts over every
    // runtime source under app/, including files no test imports, reported as Istanbul JSON at
    // coverage/coverage-final.json plus a text summary. Only tests and declarations are left out.
    // Ratchet (gaulatti/alcantara#404 follow-up): thresholds sit just under the measured values on main,
    // rounded down, so a change that drops coverage fails `test:coverage`. They are enforced only when
    // coverage runs; the frontend CI job runs plain `npm test`, so it does not enforce them yet.
    // Forks are capped at 4 (gaulatti/alcantara#83): with coverage on, the default one-fork-per-core
    // saturates the machine, the workers' task updates starve the main process and vitest ends the run
    // with `Timeout calling "onTaskUpdate"` (an unhandled error, exit 1). Measured on 172 files / 1,570
    // tests: no coverage 30 s; coverage with 4 forks 96 s and with 2 forks 121 s, both exit 0; coverage
    // with the default 9 forks 86 s and the timeout. No timeout is raised.
    // Two forks, not four, as the candidate for the coverage-run RPC timeouts ("Timeout calling onTaskUpdate"
    // and "snapshotSaved") on a 4-vCPU runner (gaulatti/alcantara#531). Reproduced once locally under heavy CPU
    // load with four forks; two forks passed one normal-load run. Not yet proven: three green normal runs and a
    // loaded run are still needed before this is called a fix.
    poolOptions: { forks: { maxForks: 2, minForks: 1 } },
    coverage: {
      provider: 'v8',
      all: true,
      include: ['app/**/*.{ts,tsx}'],
      exclude: ['app/**/*.test.{ts,tsx}', 'app/**/*.d.ts'],
      reporter: ['json', 'text-summary'],
      reportsDirectory: 'coverage',
      // Set from the CI measurement (pnpm workspace install), which reads lower than a local npm run:
      // 99.74 / 99.74 / 98.88 / 96.03 on 2026-11-24. Raise these as coverage rises; never lower them.
      thresholds: {
        statements: 99.7,
        lines: 99.7,
        branches: 98.8,
        functions: 96.0,
      },
    },
  },
});
