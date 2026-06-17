import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    // The board's selection cue is a card's border flipping to cyan (the
    // cyan-border-only treatment, no ▶ pointer). Ink only emits that colour when
    // it detects colour support, which the non-TTY test runner otherwise reports
    // as absent — so selection tests would pass in a real terminal but fail under
    // `vitest run`. Forcing colour here makes those tests deterministic across
    // environments (CI, piped output, the sandbox) by matching what a real
    // terminal renders, which is where the cue actually lives.
    env: { FORCE_COLOR: "3" },
  },
});
