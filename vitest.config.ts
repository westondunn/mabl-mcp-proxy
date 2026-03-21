import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["**/*.ts"],
      exclude: ["index.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
