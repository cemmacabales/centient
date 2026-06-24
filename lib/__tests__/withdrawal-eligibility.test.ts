import { describe, it, expect } from "vitest";
import {
  checkWithdrawalEligibility,
  type WithdrawalThresholds,
} from "@/lib/withdrawal-eligibility";

const NOW = new Date("2026-06-24T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

// A user that comfortably clears every gate, used as the baseline so each test
// can flip exactly one field and assert the matching reason.
const ELIGIBLE = {
  submissionCount: 100,
  goldCorrect: 9,
  goldAttempted: 10, // 0.9 pass rate
  createdAt: new Date(NOW.getTime() - 7 * DAY_MS), // 7 days old
};

const THRESHOLDS: WithdrawalThresholds = {
  minSubmissions: 50,
  minGoldRate: 0.7,
  minAccountAgeMs: DAY_MS, // 24h
};

describe("checkWithdrawalEligibility", () => {
  it("passes when every gate is satisfied", () => {
    expect(checkWithdrawalEligibility(ELIGIBLE, THRESHOLDS, NOW)).toEqual({
      eligible: true,
    });
  });

  it("blocks on too few submissions", () => {
    const result = checkWithdrawalEligibility(
      { ...ELIGIBLE, submissionCount: 49 },
      THRESHOLDS,
      NOW,
    );
    expect(result).toMatchObject({ eligible: false, reason: "min_submissions" });
  });

  it("blocks on a low gold pass rate", () => {
    const result = checkWithdrawalEligibility(
      { ...ELIGIBLE, goldCorrect: 6, goldAttempted: 10 }, // 0.6 < 0.7
      THRESHOLDS,
      NOW,
    );
    expect(result).toMatchObject({ eligible: false, reason: "gold_rate" });
  });

  it("treats zero gold attempts as a failing gold rate", () => {
    const result = checkWithdrawalEligibility(
      { ...ELIGIBLE, goldCorrect: 0, goldAttempted: 0 },
      THRESHOLDS,
      NOW,
    );
    expect(result).toMatchObject({ eligible: false, reason: "gold_rate" });
  });

  it("blocks on an account that is too new", () => {
    const result = checkWithdrawalEligibility(
      { ...ELIGIBLE, createdAt: new Date(NOW.getTime() - 1000) }, // 1s old
      THRESHOLDS,
      NOW,
    );
    expect(result).toMatchObject({ eligible: false, reason: "account_age" });
  });

  it("reports submissions before gold rate before age when several gates fail", () => {
    const result = checkWithdrawalEligibility(
      {
        submissionCount: 0,
        goldCorrect: 0,
        goldAttempted: 0,
        createdAt: NOW,
      },
      THRESHOLDS,
      NOW,
    );
    expect(result).toMatchObject({ eligible: false, reason: "min_submissions" });
  });

  it("is a no-op when all thresholds are zero (gates disabled)", () => {
    const result = checkWithdrawalEligibility(
      { submissionCount: 0, goldCorrect: 0, goldAttempted: 0, createdAt: NOW },
      { minSubmissions: 0, minGoldRate: 0, minAccountAgeMs: 0 },
      NOW,
    );
    expect(result).toEqual({ eligible: true });
  });
});
