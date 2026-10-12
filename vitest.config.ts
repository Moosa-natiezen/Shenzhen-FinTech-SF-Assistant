import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each test file boots a full PGlite Postgres instance (~300-500MB);
    // parallel workers OOM on small CI runners. Serial file execution keeps
    // peak memory to one instance without changing test semantics.
    fileParallelism: false,
  },
});
