import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    root: "src",
    coverage: {
      provider: "v8",
      include: ["**/*.ts"],
      exclude: ["index.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
