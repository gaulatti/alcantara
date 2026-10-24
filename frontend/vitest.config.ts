import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: [
      {
        find: /^@gaulatti\/bleecker$/,
        replacement: fileURLToPath(
          new URL("./app/bleecker.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    environment: "jsdom",
    include: ["app/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      experimentalAstAwareRemapping: true,
      all: true,
      include: ["app/**/*.{js,jsx,ts,tsx,cjs,mjs}"],
      exclude: [
        "app/**/*.{test,spec}.{js,jsx,ts,tsx,cjs,mjs}",
        "app/**/*.d.ts",
      ],
      reporter: ["json", "json-summary", "text"],
      thresholds: { lines: 100, branches: 100 },
    },
  },
});
