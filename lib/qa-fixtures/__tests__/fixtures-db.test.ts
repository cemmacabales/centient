import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { prisma, truncateAll, disconnect } from "@/tests/helpers/db";
import type { PrismaClient } from "@/app/generated/prisma/client";
import { seedQaFixtures, QA_ADMIN_EMAIL } from "../seed";
import { resetQaFixtures, QaFixtureRunNotFound } from "../reset";
import { PAYOUT_STATE_FIXTURES, UNITS_PER_USDC, CAP_HEADROOM_UNITS } from "../definitions";
import type { RecipientManifest } from "../manifest";

// B9's exit condition, expressed as assertions: one rehearsal produces every
// listed state and shape, and a reset returns to baseline without removing a row
// that recorded a payment. Written as a test rather than as a checklist so the
// exit condition cannot quietly stop being true.

const db = prisma as PrismaClient;
const CAP = 200n * UNITS_PER_USDC;
const REAL_HASH = "62f5e67eb0f3a57279a49faf840351fc67ec8b648ecab6553d5f23026946779a";

function manifest(): RecipientManifest {
  return {
    network: "testnet",
    usdcIssuer: Keypair.random().publicKey(),
    generatedAt: new Date().toISOString(),
    recipients: {
      withTrustline: { address: Keypair.random().publicKey() },
      withoutTrustline: { address: Keypair.random().publicKey() },
      neverCreated: { address: Keypair.random().publicKey() },
    },
  };
}

async function seed(overrides: Partial<Parameters<typeof seedQaFixtures>[0]> = {}) {
  return seedQaFixtures({
    prisma: db,
    manifest: manifest(),
    network: "testnet",
    capUnits: CAP,
    gitSha: "0".repeat(40),
    ...overrides,
  });
}

beforeEach(async () => {
  await truncateAll();
  await db.qaFixtureRun.deleteMany();
  await db.adminUser.create({
    data: { email: QA_ADMIN_EMAIL, passwordHash: "hashed", role: "SUPER_ADMIN", isVerified: true },
  });
});

afterAll(async () => {
  await disconnect();
});

describe("seeding one rehearsal", () => {
  it("refuses without the admin the ordinary seed creates", async () => {
    await db.adminUser.deleteMany();
    // Rather than seeding another credential of its own — the surface #87 is
    // open about — the fixture set attaches to the existing admin and says so.
    await expect(seed()).rejects.toThrow(/pnpm db:seed/);
  });

  it("produces every payout state exactly once", async () => {
    const result = await seed();

    for (const fixture of PAYOUT_STATE_FIXTURES) {
      const id = result.fixtures[fixture.slug];
      expect(id, `${fixture.slug} was not seeded`).toBeTruthy();

      const row = await db.submission.findUnique({ where: { id } });
      expect(row, `${fixture.slug} row missing`).not.toBeNull();
      expect(row!.payoutStatus).toBe(fixture.payoutStatus);
      expect(row!.retryCount).toBe(fixture.retryCount);
      expect(Boolean(row!.payoutTxHash)).toBe(fixture.broadcast);
    }
  });

  it("produces every pinned recipient shape", async () => {
    const result = await seed();
    for (const shape of ["withTrustline", "withoutTrustline", "neverCreated"]) {
      const address = result.fixtures[`recipient:${shape}`];
      expect(address, `${shape} missing`).toBeTruthy();
      const user = await db.user.findUnique({ where: { walletAddress: address } });
      expect(user, `${shape} has no user row`).not.toBeNull();
    }
  });

  it("seeds twelve payable references", async () => {
    const result = await seed();
    const payable = Object.keys(result.fixtures).filter((s) => s.startsWith("qa-payable-"));
    expect(payable).toHaveLength(12);

    for (const slug of payable) {
      const row = await db.submission.findUnique({ where: { id: result.fixtures[slug] } });
      expect(row!.payoutStatus).toBe("pending");
      expect(row!.payoutTxHash).toBeNull();
    }
  });

  it("refunds the permanently-failed fixture and not the reconciliation one", async () => {
    const result = await seed();

    const failedRefunds = await db.balanceLedger.count({
      where: { submissionId: result.fixtures["qa-failed-permanent"], type: "REFUND" },
    });
    expect(failedRefunds).toBe(1);

    // The funds left the wallet for this one; refunding the campaign as well
    // would be a double-spend of the campaign balance.
    const reconRefunds = await db.balanceLedger.count({
      where: { submissionId: result.fixtures["qa-needs-reconciliation"], type: "REFUND" },
    });
    expect(reconRefunds).toBe(0);
  });

  it("keeps the already-broadcast fixtures out of the rolling cap window", async () => {
    // The subtle one. `getPayoutActivitySince` sums every hashed PayoutJob inside
    // the trailing 24 hours, so fixtures carrying a hash would consume the very
    // allowance the cap fixtures are positioning — and TC-017's boundary amounts
    // would be wrong by the value of two unrelated fixtures.
    const result = await seed();
    const since = new Date(Date.now() - 86_400_000);

    const inWindow = await db.payoutJob.aggregate({
      _sum: { amountUnits: true },
      where: { broadcastAt: { gte: since }, txHash: { not: null }, amountUnits: { not: null } },
    });

    expect(inWindow._sum.amountUnits).toBe(result.capPlan!.seededUsageUnits);
    expect(CAP - (inWindow._sum.amountUnits ?? 0n)).toBe(CAP_HEADROOM_UNITS);
  });

  it("records the run with its SHA and slug map", async () => {
    const result = await seed();
    const run = await db.qaFixtureRun.findUnique({ where: { runId: result.runId } });

    expect(run!.gitSha).toBe("0".repeat(40));
    expect(run!.network).toBe("testnet");
    expect(run!.resetAt).toBeNull();
    expect((run!.fixtures as Record<string, string>)["qa-validated"]).toBe(
      result.fixtures["qa-validated"],
    );
  });

  it("never reuses a payout reference across runs", async () => {
    // Reset rule 2, asserted directly. Slugs are stable so QA can address a
    // fixture by meaning; the ids behind them must not be.
    const first = await seed();
    await resetQaFixtures(db, first.runId);
    const second = await seed();

    for (const fixture of PAYOUT_STATE_FIXTURES) {
      expect(second.fixtures[fixture.slug]).not.toBe(first.fixtures[fixture.slug]);
    }
  });

  it("leaves nothing behind when a write fails partway through", async () => {
    // The run record is written inside the same transaction as the fixtures. If
    // it were written last and a fixture write failed, the committed campaign and
    // submissions would survive with no run row — and `resetQaFixtures` resolves a
    // run's campaign through `run.fixtures["campaign"]`, so the one command whose
    // job is to clean those rows up could not find them.
    let submissionsCreated = 0;
    const failing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
        return (callback: (tx: unknown) => unknown, options: unknown) =>
          (target as PrismaClient).$transaction(async (tx) => {
            const guarded = new Proxy(tx as object, {
              get(txTarget, txProp) {
                if (txProp !== "submission") return Reflect.get(txTarget, txProp);
                const model = Reflect.get(txTarget, txProp) as Record<string, unknown>;
                return new Proxy(model, {
                  get(modelTarget, modelProp) {
                    if (modelProp !== "create") return Reflect.get(modelTarget, modelProp);
                    return async (args: unknown) => {
                      if (++submissionsCreated > 3) throw new Error("induced mid-seed failure");
                      return (modelTarget.create as (a: unknown) => unknown)(args);
                    };
                  },
                });
              },
            });
            return callback(guarded);
          }, options as Parameters<PrismaClient["$transaction"]>[1]);
      },
    }) as PrismaClient;

    await expect(seed({ prisma: failing })).rejects.toThrow(/induced mid-seed failure/);

    // Three submissions were created before the failure and none survive.
    expect(submissionsCreated).toBeGreaterThan(3);
    expect(await db.submission.count()).toBe(0);
    expect(await db.task.count()).toBe(0);
    expect(await db.campaign.count()).toBe(0);
    expect(await db.qaFixtureRun.count()).toBe(0);
  });

  it("skips the cap fixtures when the cap is disabled, and says why", async () => {
    const result = await seed({ capUnits: 0n });
    expect(result.capPlan).toBeNull();
    expect(result.capSkippedReason).toMatch(/disables the cap/);
    expect(result.fixtures["qa-cap-below"]).toBeUndefined();
  });
});

describe("resetting a run", () => {
  it("removes the fixtures and closes out the run record", async () => {
    const result = await seed();
    const reset = await resetQaFixtures(db, result.runId);

    expect(reset.preservedCount).toBe(0);
    expect(reset.deletedCount).toBeGreaterThan(0);
    expect(reset.campaignRemoved).toBe(true);

    expect(await db.submission.count()).toBe(0);
    expect(await db.payoutJob.count()).toBe(0);
    expect(await db.campaign.count()).toBe(0);

    const run = await db.qaFixtureRun.findUnique({ where: { runId: result.runId } });
    expect(run!.resetAt).not.toBeNull();
    expect(run!.deletedCount).toBe(reset.deletedCount);
  });

  it("REFUSES to delete a row carrying a real Horizon hash", async () => {
    // The assertion the whole reset exists to satisfy. A fixture reference that
    // settled on-chain is evidence that money moved, and no reset may erase it.
    const result = await seed();
    const victim = result.fixtures["qa-validated"];
    await db.submission.update({
      where: { id: victim },
      data: { payoutTxHash: REAL_HASH },
    });

    const reset = await resetQaFixtures(db, result.runId);

    expect(reset.preservedCount).toBe(1);
    expect(reset.preserved[0]).toMatchObject({
      kind: "submission",
      id: victim,
      reason: "real-broadcast",
    });

    const survivor = await db.submission.findUnique({ where: { id: victim } });
    expect(survivor).not.toBeNull();
    expect(survivor!.payoutTxHash).toBe(REAL_HASH);
  });

  it("keeps the campaign open when it still holds a preserved row", async () => {
    // Deleting the campaign would orphan the row recording the payment, which is
    // the outcome rule 1 exists to prevent.
    const result = await seed();
    await db.submission.update({
      where: { id: result.fixtures["qa-validated"] },
      data: { payoutTxHash: REAL_HASH },
    });

    const reset = await resetQaFixtures(db, result.runId);
    expect(reset.campaignRemoved).toBe(false);
    expect(await db.campaign.count()).toBe(1);
  });

  it("preserves an unrecognised hash rather than guessing", async () => {
    const result = await seed();
    await db.submission.update({
      where: { id: result.fixtures["qa-validated"] },
      data: { payoutTxHash: "entered-by-hand-during-an-incident" },
    });

    const reset = await resetQaFixtures(db, result.runId);
    expect(reset.preserved[0].reason).toBe("unrecognised-hash");
  });

  it("defaults to the most recent un-reset run", async () => {
    const first = await seed();
    await resetQaFixtures(db, first.runId);
    const second = await seed();

    const reset = await resetQaFixtures(db);
    expect(reset.runId).toBe(second.runId);
  });

  it("reports an unknown run rather than deleting nothing quietly", async () => {
    await expect(resetQaFixtures(db, "nosuchrun")).rejects.toThrow(QaFixtureRunNotFound);
  });
});
