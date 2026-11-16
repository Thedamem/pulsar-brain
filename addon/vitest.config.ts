import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * The addon is compiled as NodeNext ESM, so relative imports carry a `.js` extension.
 * Vite needs help mapping those back to the TypeScript sources during tests.
 */
export default defineConfig({
  plugins: [
    {
      name: "resolve-ts-from-js",
      enforce: "pre",
      resolveId(source: string, importer: string | undefined) {
        if (importer === undefined || !source.startsWith(".") || !source.endsWith(".js")) {
          return null;
        }
        const candidate = path.resolve(path.dirname(importer), source.replace(/\.js$/, ".ts"));
        return existsSync(candidate) ? candidate : null;
      },
    },
  ],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
