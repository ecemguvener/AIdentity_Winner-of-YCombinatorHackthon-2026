import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.test.ts"],
    hookTimeout: 90_000,
    testTimeout: 120_000,
    pool: "forks",
    fileParallelism: false,
    disableConsoleIntercept: true,
    sequence: {
      concurrent: false
    }
  }
});
