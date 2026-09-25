import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  payoutJob: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  submission: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  user: { findUnique: vi.fn(), update: vi.fn() },
  userBalanceLedger: { create: vi.fn() },
  $executeRaw: vi.fn(),
}));
const effects = vi.hoisted(() => ({ pay: vi.fn(), page: vi.fn(), refund: vi.fn(), credit: vi.fn() }));
// Interactive transactions roll back on throw. Tests that model row state hook
// `begin` to snapshot it and `rollback` to restore it, so a write that lands
// inside a failing transaction is undone the way Postgres would undo it.
const txn = vi.hoisted(() => ({ begin: undefined as (() => void) | undefined, rollback: undefined as (() => void) | undefined }));
// #38's envelope settlement runs against a real database in
// payout-attempt-settlement-db.test.ts; here there is never an open attempt.
vi.mock("@/lib/payout-attempts", () => ({
  settleOpenAttempt: vi.fn(async () => ({ kind: "clear" })),
  confirmAttempt: vi.fn(() => Promise.resolve({ count: 0 })),
  submissionAttemptJournal: vi.fn(() => undefined),
}));

vi.mock("../prisma", () => ({ default: { ...db, $transaction: async (fn: any) => {
  if (typeof fn !== "function") return Promise.all(fn);
  txn.begin?.();
  try { return await fn(db); } catch (err) { txn.rollback?.(); throw err; }
} } }));
vi.mock("../payout", () => ({ payReward: effects.pay, PayoutCapError: class extends Error {} }));
vi.mock("../health-alert", () => ({ sendDedupedDiscordAlert: effects.page }));
vi.mock("../user-balance", () => ({ refundReversal: effects.refund }));
vi.mock("../campaign-balance", () => ({
  creditBalance: effects.credit,
  totalDebitUnits: (n: bigint) => n,
  // F2: every retry claimant refuses a refunded row; never refunded here.
  hasRefundedSubmission: vi.fn(async () => false),
}));
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
  // F3: the `sent` transition is conditional, and one matched row means this
  // caller won it and so credits. Tests that model row state override this.
  db.submission.updateMany.mockResolvedValue({ count: 1 });
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

  it("submission: bookkeeping failure after broadcast leaves a hash the retry cron refuses", async () => {
    // Model the submission row with real transaction semantics: a write that
    // lands inside the failing bookkeeping transaction is rolled back.
    const row: Record<string, unknown> = { ...submission };
    let snapshot = { ...row };
    txn.begin = () => { snapshot = { ...row }; };
    txn.rollback = () => { Object.assign(row, snapshot); };
    db.submission.findUnique.mockImplementation(async () => ({ ...row }));
    db.submission.update.mockImplementation(async ({ data }: any) => { Object.assign(row, data); return { ...row }; });
    // The conditional `sent` write, with the condition applied: it matches only
    // while the row still carries no hash, which is what makes a replay a no-op.
    db.submission.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where?.payoutTxHash === null && row.payoutTxHash != null) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    });
    db.user.update.mockRejectedValue(new Error(secret));

    await processJob("job", "sub", "user", 123n, "SUBMISSION_PAYOUT");
    expect(effects.pay).toHaveBeenCalledTimes(1);

    // The hash must survive the rollback: it has to be written in the same unit
    // as the job's hash, not in the bookkeeping transaction that failed.
    expect(row.payoutTxHash).toBe(hash);

    // /api/cron/payout-retry selects `pending` submissions and re-broadcasts any
    // without a hash. It must find nothing to do here.
    await reprocessPayoutWithNonceSafety("sub");
    expect(effects.pay).toHaveBeenCalledTimes(1);
    txn.begin = txn.rollback = undefined;
  });

  it("submission: persistence failure quarantines the submission, not just the job", async () => {
    // If the tuple write itself fails, quarantining only the PayoutJob leaves
    // the submission `pending` with no hash — the row the retry cron re-sends.
    db.payoutJob.update.mockImplementation(async ({ data }: any) => {
      if (data.txHash) throw new Error(secret);
      return {};
    });

    await processJob("job", "sub", "user", 123n, "SUBMISSION_PAYOUT");

    expect(effects.pay).toHaveBeenCalledTimes(1);
    const submissionWrites = db.submission.update.mock.calls.map(([args]) => args.data);
    expect(submissionWrites).toContainEqual(
      expect.objectContaining({ payoutStatus: "needs_reconciliation", payoutTxHash: hash }),
    );
    expect(effects.page).toHaveBeenCalledWith(expect.objectContaining({ severity: "PAGE" }));
  });

  it("legacy: totals failure stays inside the accepted-payment boundary", async () => {
    // #40: the credit is part of the write that records `sent`, so a credit that
    // cannot land quarantines the payment rather than leaving it sent uncredited.
    db.user.update.mockRejectedValue(new Error(secret));
    await expect(reprocessPayoutWithNonceSafety("sub")).resolves.toBeUndefined();
    const submissionWrites = db.submission.update.mock.calls.map(([args]) => args.data);
    expect(submissionWrites.at(-1)).toMatchObject({ payoutStatus: "needs_reconciliation", payoutTxHash: hash });
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
