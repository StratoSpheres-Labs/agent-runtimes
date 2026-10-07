import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Vitest's 5s default is smaller than this library's OWN probe budget:
    // `runCommand` (src/discovery/run-command.ts) allows 10s for a single
    // probe, and plenty of tests spawn a real process or read the real
    // transcript stores. Anything that legitimately runs one probe could not
    // fit in 5s, so on a loaded box (66 files in parallel) those tests failed
    // with "Test timed out in 5000ms" — never an assertion failure.
    //
    // 20s clears that budget with room to spare while still catching a genuine
    // hang quickly enough to be useful. Tests doing heavier live work keep an
    // explicit 30-60s per-test argument, which still wins over this default.
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
    },
  },
});
