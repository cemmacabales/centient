import { defineConfig, type ViteUserConfig } from "vitest/config";
import baseConfig from "./vitest.config";
import { PAYMENTS_LANE_TEST_GLOBS } from "./tests/payments-lane";

// The payments lane as its own runnable suite (#12).
//
// WHY A NAMED LANE, given the whole suite already runs on every PR. The
// Deliverable-1 evidence has to point at a run, and pointing at `build` says
// "every test in the repository passed" — true, but it is not a statement about
// the payment rail, and it stops being one the moment an unrelated suite goes
// red. A job named `payments-lane` fails on its own, is linkable on its own, and
// answers the DoD's question directly.
//
// The cost is real and was accepted: a second Postgres service and a duplicated
// install/migrate on every PR. It buys evidence that survives being read six
// months from now by someone who was not here.
//
// This does NOT replace the full-suite run. `build` stays authoritative for
// merge; this lane is the evidence artifact, and every test it runs is also run
// there. The lane's membership lives in `tests/payments-lane.ts`, shared with
// the no-single-key guard so the two cannot disagree about what the lane is.
const base = baseConfig as ViteUserConfig;

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [...PAYMENTS_LANE_TEST_GLOBS],
    // Coverage thresholds are a whole-repository judgement and are enforced by
    // the full-suite run; measuring them against a subset would fail on files
    // this lane never loads.
    coverage: { enabled: false },
  },
});
