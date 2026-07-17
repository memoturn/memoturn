import { defineConfig } from "vitest/config";

// Unit tests only (pure logic like the trace-graph derivation). The Playwright e2e specs under
// e2e/*.spec.ts are run separately via `test:e2e`, so keep vitest scoped to src/**/*.test.*.
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
