import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  payoutJob: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  submission: { findUnique: vi.fn(), update: vi.fn(), count: vi.fn() },
  user: { findUnique: vi.fn(), update: vi.fn() },
  userBalanceLedger: { create: vi.fn() },
  $executeRaw: vi.fn(),
}));
const effects = vi.hoisted(() => ({ pay: vi.fn(), page: vi.fn(), refund: vi.fn(), credit: vi.fn() }));
vi.mock("../prisma", () => ({ default: { ...db, $transaction: (fn: any) =>
  typeof fn === "function" ? fn(db) : Promise.all(fn) } }));
vi.mock("../payout", () => ({ payReward: effects.pay, PayoutCapError: class extends Error {} }));
vi.mock("../health-alert", () => ({ sendDedupedDiscordAlert: effects.page }));
vi.mock("../user-balance", () => ({ refundReversal: effects.refund }));
vi.mock("../campaign-balance", () => ({ creditBalance: effects.credit, totalDebitUnits: (n: bigint) => n }));
vi.mock("../stellar/balance", () => ({ checkAndAlert: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
import { processJob } from "../payout-worker";
import { reprocessPayoutWithNonceSafety } from "../payout-service";

const hash = "a".repeat(64);
const secret = "synthetic-database-credential";
const submission = {
  id: "sub", userId: "user", payoutStatus: "pending", payoutAmountUnits: 123n,
  walletAddress: "GCKIPQX2TEZWBQSUPPNMKGJBODL246B374Y52SPD2OGJ2AAQ6SHYUR6E",
  retryCount: 2, payoutTxHash: null, task: { isGold: false, campaignId: "campaign" },
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  effects.pay.mockResolvedValue(hash);
  effects.page.mockResolvedValue("sent");
  effects.credit.mockResolvedValue(undefined);
  effects.refund.mockResolvedValue(0n);
  db.payoutJob.findUnique.mockResolvedValue({ destinationAddress: submission.walletAddress, retryCount: 2 });
  db.submission.findUnique.mockResolvedValue(submission);
  db.user.findUnique.mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe("accepted payment persistence boundary", () => {
  for (const path of ["withdrawal", "submission", "legacy"] as const) {
    const run = () => path === "legacy" ? reprocessPayoutWithNonceSafety("sub") :
      processJob("job", path === "submission" ? "sub" : null, "user", 123n,
        path === "submission" ? "SUBMISSION_PAYOUT" : "WITHDRAWAL");

    it(`${path}: pages after bounded persistence failures without refund or requeue`, async () => {
      const write = path === "legacy" ? db.payoutJob.upsert : db.payoutJob.update;
      write.mockImplementation(async ({ data, create }: any) => {
        if ((data ?? create).txHash) throw new Error(secret);
        return {};
      });
      await expect(run()).resolves.toBeUndefined();
      expect(write.mock.calls.filter(([args]) => (args.data ?? args.create).txHash)).toHaveLength(3);
      expect(effects.refund).not.toHaveBeenCalled();
      expect(effects.credit).not.toHaveBeenCalled();
      // Never requeued: a requeue re-broadcasts a payment that already settled.
      expect(db.payoutJob.update.mock.calls.some(([args]) => args.data.status === "queued")).toBe(false);
      // But it MUST leave every automatic retry path. A job left `processing`
      // with a dead heartbeat is reclaimed by claimNextJob within a minute, and
      // a submission left `pending` with no hash is re-sent by the retry cron —
      // either one double-pays long before a human reads the PAGE.
      if (path === "legacy") {
        const quarantine = db.submission.update.mock.calls
          .map(([args]) => args.data)
          .filter((data) => data.payoutTxHash === hash);
        expect(quarantine).not.toHaveLength(0);
        expect(quarantine.at(-1)).toMatchObject({ payoutStatus: "needs_reconciliation" });
      } else {
        const quarantine = db.payoutJob.update.mock.calls
          .map(([args]) => args.data)
          .filter((data) => data.status === "failed");
        expect(quarantine).not.toHaveLength(0);
        expect(String(quarantine.at(-1)!.lastError)).toMatch(/reconcil/i);
      }
      expect(effects.pay).toHaveBeenCalledTimes(1);
      expect(effects.page).toHaveBeenCalledWith(expect.objectContaining({
        key: "payout-persistence-unavailable", severity: "PAGE",
        lines: expect.arrayContaining([expect.stringContaining(hash)]),
      }));
      expect(JSON.stringify(effects.page.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secret);
    });

    it(`${path}: retries the same accepted tuple when persistence recovers`, async () => {
      const write = path === "legacy" ? db.payoutJob.upsert : db.payoutJob.update;
      write.mockRejectedValueOnce(new Error(secret)).mockResolvedValue({});
      await run();
      const tuples = write.mock.calls.map(([args]) => args.data ?? args.create).filter((data) => data.txHash);
      expect(tuples).toHaveLength(2);
      expect(tuples[1]).toMatchObject({ txHash: hash, amountUnits: 123n, broadcastAt: tuples[0].broadcastAt });
      expect(effects.pay).toHaveBeenCalledTimes(1);
      expect(effects.refund).not.toHaveBeenCalled();
      expect(effects.credit).not.toHaveBeenCalled();
      expect(effects.page).not.toHaveBeenCalled();
    });
  }

  it("submission: later bookkeeping failure cannot fail or refund a recorded payment", async () => {
    db.user.update.mockRejectedValue(new Error(secret));
    await processJob("job", "sub", "user", 123n, "SUBMISSION_PAYOUT");
    expect(effects.credit).not.toHaveBeenCalled();
    expect(effects.refund).not.toHaveBeenCalled();
    expect(db.payoutJob.update.mock.calls.some(([args]) => args.data.status === "queued")).toBe(false);
    // The tuple persisted but the bookkeeping did not, so the job is still
    // `processing` with a dying heartbeat — it must be quarantined too.
    expect(
      db.payoutJob.update.mock.calls.some(
        ([args]) => args.data.status === "failed" && /reconcil/i.test(String(args.data.lastError)),
      ),
    ).toBe(true);
    expect(effects.page).toHaveBeenCalledWith(expect.objectContaining({ severity: "PAGE" }));
  });

  it("legacy: totals failure stays inside the accepted-payment boundary", async () => {
    db.user.findUnique.mockRejectedValue(new Error(secret));
    await expect(reprocessPayoutWithNonceSafety("sub")).resolves.toBeUndefined();
    expect(effects.refund).not.toHaveBeenCalled();
    expect(effects.page).toHaveBeenCalledWith(expect.objectContaining({ severity: "PAGE" }));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secret);
  });
});

describe("quarantine warns when it cannot block automatic retries", () => {
  it("says so in the PAGE when the quarantine write also fails", async () => {
    db.payoutJob.update.mockRejectedValue(new Error(secret));

    await processJob("job", null, "user", 123n, "WITHDRAWAL");

    const [alert] = effects.page.mock.calls.at(-1)!;
    expect(alert.lines.join(" ")).toMatch(/not blocked/i);
    expect(effects.refund).not.toHaveBeenCalled();
    expect(JSON.stringify(effects.page.mock.calls)).not.toContain(secret);
  });
});
