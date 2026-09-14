import { describe, it, expect } from "vitest";
import {
  CAP_HEADROOM_UNITS,
  PAYOUT_STATE_FIXTURES,
  UNITS_PER_USDC,
  planCapFixtures,
  requiredCampaignBalanceUnits,
} from "../definitions";

// The fixture set is only useful if the six states are actually distinguishable
// by the thing that decides them. These cases assert that against the co-signer's
// real refusal order rather than against the prose in the issue.

describe("the six payout states", () => {
  it("covers every state D1 asks for, once each", () => {
    expect(PAYOUT_STATE_FIXTURES).toHaveLength(6);
    const slugs = PAYOUT_STATE_FIXTURES.map((f) => f.slug);
    expect(new Set(slugs).size).toBe(6);
  });

  it("gives exactly one signable, unbroadcast baseline", () => {
    // `SIGNABLE_STATUSES.submission` is ["pending", "failed"], and a hash is
    // refused before status is even read.
    const signableNow = PAYOUT_STATE_FIXTURES.filter(
      (f) => !f.broadcast && ["pending", "failed"].includes(f.payoutStatus),
    );
    // pending: qa-validated, qa-cap-deferred · failed: qa-failed-permanent
    expect(signableNow.map((f) => f.slug).sort()).toEqual([
      "qa-cap-deferred",
      "qa-failed-permanent",
      "qa-validated",
    ]);
  });

  it("separates the hash refusal from the status refusal", () => {
    // The distinction the co-signer's ordering creates, and the reason both
    // fixtures exist: one is refused on its hash, the other on its status. A
    // fixture set that conflated them would let a regression pass QA, because a
    // refusal would still arrive — for the wrong reason.
    const alreadyPaid = PAYOUT_STATE_FIXTURES.find((f) => f.slug === "qa-already-paid")!;
    const nonValidated = PAYOUT_STATE_FIXTURES.find((f) => f.slug === "qa-non-validated")!;

    expect(alreadyPaid.broadcast).toBe(true);
    expect(nonValidated.broadcast).toBe(false);
    expect(["pending", "failed"]).not.toContain(nonValidated.payoutStatus);
  });

  it("keeps the permanently-failed fixture on a signable status, on purpose", () => {
    // `failed` IS signable — `reprocessPayoutWithNonceSafety` retries a
    // submission whose broadcast never produced a hash. This fixture is
    // separated from qa-non-validated by a spent retry budget and a refund, not
    // by signability, and "tidying" that up would test a rail that doesn't exist.
    const failed = PAYOUT_STATE_FIXTURES.find((f) => f.slug === "qa-failed-permanent")!;
    expect(failed.payoutStatus).toBe("failed");
    expect(failed.retryCount).toBeGreaterThan(0);
    expect(failed.ledger).toBe("refunded");
  });

  it("never refunds the reconciliation fixture", () => {
    // The funds left the wallet. Refunding the campaign as well would be a
    // double-spend of the campaign balance.
    const recon = PAYOUT_STATE_FIXTURES.find((f) => f.slug === "qa-needs-reconciliation")!;
    expect(recon.broadcast).toBe(true);
    expect(recon.ledger).toBe("reserved");
  });

  it("leaves the cap-deferred fixture's retry budget and reservation intact", () => {
    // A cap refusal defers; it does not fail. Consuming a retry or releasing the
    // reservation would both be defects, so the fixture must not model either.
    const deferred = PAYOUT_STATE_FIXTURES.find((f) => f.slug === "qa-cap-deferred")!;
    expect(deferred.payoutStatus).toBe("pending");
    expect(deferred.retryCount).toBe(0);
    expect(deferred.ledger).toBe("reserved");
    expect(deferred.broadcast).toBe(false);
  });

  it("pays the permanent-failure case to a destination that cannot receive", () => {
    const failed = PAYOUT_STATE_FIXTURES.find((f) => f.slug === "qa-failed-permanent")!;
    expect(failed.shape).toBe("withoutTrustline");
  });
});

describe("planCapFixtures", () => {
  const CAP = 200n * UNITS_PER_USDC;

  it("positions the boundary at exactly one unit either side", () => {
    const plan = planCapFixtures(CAP)!;
    expect(plan.headroomUnits).toBe(CAP_HEADROOM_UNITS);
    expect(plan.seededUsageUnits).toBe(CAP - CAP_HEADROOM_UNITS);

    const [below, at, above] = plan.presets;
    expect(below.amountUnits).toBe(CAP_HEADROOM_UNITS - 1n);
    expect(at.amountUnits).toBe(CAP_HEADROOM_UNITS);
    expect(above.amountUnits).toBe(CAP_HEADROOM_UNITS + 1n);
  });

  it("leaves the seeded usage plus the at-cap amount exactly at the cap", () => {
    // D1-TC-017's middle step: a payout that lands exactly on the cap, not one
    // unit short of it and not one over.
    const plan = planCapFixtures(CAP)!;
    const at = plan.presets.find((p) => p.slug === "qa-cap-at")!;
    expect(plan.seededUsageUnits + at.amountUnits).toBe(CAP);
  });

  it("puts the over-cap amount exactly one unit past the cap", () => {
    const plan = planCapFixtures(CAP)!;
    const above = plan.presets.find((p) => p.slug === "qa-cap-above")!;
    expect(plan.seededUsageUnits + above.amountUnits).toBe(CAP + 1n);
  });

  it("tracks a changed cap rather than hard-coding amounts", () => {
    const plan = planCapFixtures(50n * UNITS_PER_USDC)!;
    expect(plan.seededUsageUnits).toBe(50n * UNITS_PER_USDC - CAP_HEADROOM_UNITS);
  });

  it("declines when the cap is disabled", () => {
    // `checkPayoutCap` returns early on a cap of zero, so there is no boundary to
    // sit near and the fixtures would assert nothing.
    expect(planCapFixtures(0n)).toBeNull();
    expect(planCapFixtures(-1n)).toBeNull();
  });

  it("declines rather than silently shrinking a cap smaller than the headroom", () => {
    // Quietly reducing the headroom would hand QA boundary amounts that don't
    // match the documented ones.
    expect(planCapFixtures(CAP_HEADROOM_UNITS - 1n)).toBeNull();
    expect(planCapFixtures(CAP_HEADROOM_UNITS)).not.toBeNull();
  });
});

describe("requiredCampaignBalanceUnits", () => {
  it("covers every fixture that debits the campaign", () => {
    const debiting = PAYOUT_STATE_FIXTURES.filter((f) => f.ledger !== "none").length;
    const expected =
      BigInt(debiting) * UNITS_PER_USDC + 12n * (UNITS_PER_USDC / 2n);
    expect(requiredCampaignBalanceUnits()).toBe(expected);
  });

  it("does not reserve anything for a state that never debited", () => {
    const none = PAYOUT_STATE_FIXTURES.filter((f) => f.ledger === "none");
    expect(none.length).toBeGreaterThan(0);
    expect(requiredCampaignBalanceUnits(none, 0)).toBe(0n);
  });
});
