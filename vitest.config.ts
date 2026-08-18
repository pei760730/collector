import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
    coverage: {
      provider: "v8",
      thresholds: {
        statements: 93,
        branches: 85,
        functions: 83,
        lines: 95,
      },
    },
  },
});
