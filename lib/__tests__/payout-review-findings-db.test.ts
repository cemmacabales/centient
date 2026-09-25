import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Regression cover for the blocking findings on PR #133 (develop → staging).
//
// Each block below is one finding, and each asserts the behaviour the finding
// said was missing rather than the shape of the fix — so a later rewrite of the
// mechanism still has to keep the property.
//
//   F1  two reconcilers cannot each restore one failed withdrawal
//   F3  a persist callback replayed after a lost commit credits once
//   F4  confirming a held payout repairs the job tuple both daily caps sum
//   F5  confirming clears a stale Horizon read error
//   F6  an excluded hash still reports its attempt-journal findings
//
// The database, the ledgers, the attempt journal and the cap query all run for
// real. Only Horizon is a fake, serving real envelopes.

const PAYOUT_ACCOUNT = Keypair.random().publicKey();
const USDC = new Asset("USDC", Keypair.random().publicKey());

const chain = new Map<string, "confirmed" | "failed">();
const envelopes = new Map<string, string>();

/** The envelope shape `verifySettledPayout` accepts: one USDC payment, fee-bumped by the payout account. */
function payoutEnvelope(destination: string, amount: string) {
  const inner = new TransactionBuilder(new Account(PAYOUT_ACCOUNT, "41"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination, asset: USDC, amount }))
    .setTimeout(180)
    .build();
  return TransactionBuilder.buildFeeBumpTransaction(PAYOUT_ACCOUNT, "200", inner, Networks.TESTNET).toXDR();
}

vi.mock("@/lib/stellar/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar/client")>();
  return {
    ...actual,
    getTxStatus: vi.fn(async (hash: string) => chain.get(hash) ?? "not_found"),
    lookupTx: vi.fn(async (hash: string) => {
      const status = chain.get(hash);
      return status ? { status, envelopeXdr: envelopes.get(hash)! } : { status: "not_found" };
    }),
    latestLedgerCloseMs: vi.fn(async () => Date.now() + 3_600_000),
  };
});
vi.mock("@/lib/health-alert", () => ({ sendDedupedDiscordAlert: vi.fn(async () => "sent") }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

import { processWithdrawal } from "@/lib/reconciler";
import { refundReversal } from "@/lib/user-balance";
import { settleHeldPayment } from "@/lib/payout-reconcile";
import { reconcileSubmission } from "@/lib/payout-reconcile";
import { getPayoutActivitySince } from "@/lib/payout-cap";
import { buildReconcileReport } from "@/lib/payout-reconcile-report";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createCampaign, createCampaignBalance, createTask, createUser, VALID_REASON } from "@/tests/helpers/factories";

const AMOUNT = 2_500_000n;
const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  vi.clearAllMocks();
  process.env = {
    ...ORIGINAL_ENV,
    DAILY_PAYOUT_CAP_UNITS: "0",
    STELLAR_NETWORK: "testnet",
    STELLAR_PLATFORM_ACCOUNT: PAYOUT_ACCOUNT,
    STELLAR_USDC_CODE: "USDC",
    STELLAR_USDC_ISSUER: USDC.getIssuer(),
  };
  chain.clear();
  envelopes.clear();
  await truncateAll();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/** A user holding a legacy balance, with that balance debited into one in-flight withdrawal. */
async function inFlightWithdrawal(hash: string) {
  const user = await createUser({ walletAddress: Keypair.random().publicKey() });
  const job = await prisma.payoutJob.create({
    data: {
      type: "WITHDRAWAL",
      userId: user.id,
      amountUnits: AMOUNT,
      destinationAddress: user.walletAddress,
      status: "processing",
      txHash: hash,
      retryCount: 2,
    },
  });
  return { user, job };
}

const balanceOf = async (userId: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { pendingBalanceUnits: true } }))
    .pendingBalanceUnits;

const reversalsFor = (jobId: string) =>
  prisma.userBalanceLedger.count({ where: { type: "REVERSAL", submissionId: jobId } });

describe("F1 — a failed withdrawal is restored exactly once", () => {
  // The finding: the claim was a select followed by an unconditional update, so
  // N reconcilers each held the same job, each counted the last retry, and each
  // called `refundReversal`. The reversal creates withdrawable balance, so the
  // duplicate is money the platform never debited — and a later withdrawal pays
  // it out for real.
  it("restores the debit once when two reconcilers settle the same job together", async () => {
    const hash = "wd-concurrent";
    chain.set(hash, "failed");
    const { user, job } = await inFlightWithdrawal(hash);

    await Promise.all([
      processWithdrawal(job.id, hash, user.id, AMOUNT),
      processWithdrawal(job.id, hash, user.id, AMOUNT),
    ]);

    expect(await balanceOf(user.id)).toBe(AMOUNT);
    expect(await reversalsFor(job.id)).toBe(1);
    expect(await prisma.payoutJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "failed",
    });
  });

  it("restores it once however many passes read the same failure", async () => {
    const hash = "wd-repeated";
    chain.set(hash, "failed");
    const { user, job } = await inFlightWithdrawal(hash);

    await processWithdrawal(job.id, hash, user.id, AMOUNT);
    await processWithdrawal(job.id, hash, user.id, AMOUNT);
    await processWithdrawal(job.id, hash, user.id, AMOUNT);

    expect(await balanceOf(user.id)).toBe(AMOUNT);
    expect(await reversalsFor(job.id)).toBe(1);
  });

  // The reversal is keyed independently of the claim, so a caller that replays
  // after a commit whose response was lost cannot double it either.
  it("refuses a second reversal for the same payout job", async () => {
    const { user, job } = await inFlightWithdrawal("wd-keyed");

    await refundReversal(user.id, AMOUNT, job.id, "first");
    await refundReversal(user.id, AMOUNT, job.id, "replay");

    expect(await balanceOf(user.id)).toBe(AMOUNT);
    expect(await reversalsFor(job.id)).toBe(1);
  });

  it("still reverses a different job for the same user", async () => {
    const { user, job } = await inFlightWithdrawal("wd-first");
    const second = await prisma.payoutJob.create({
      data: { type: "WITHDRAWAL", userId: user.id, amountUnits: AMOUNT, status: "failed", txHash: "wd-second" },
    });

    await refundReversal(user.id, AMOUNT, job.id, "first");
    await refundReversal(user.id, AMOUNT, second.id, "second");

    expect(await balanceOf(user.id)).toBe(AMOUNT * 2n);
  });
});

/** A submission quarantined by the worker: held, carrying a hash, with a tuple-less failed job. */
async function quarantined(hash: string) {
  const campaign = await createCampaign({ rewardUnits: AMOUNT });
  await createCampaignBalance(campaign.id, 1_000_000_000n);
  const user = await createUser({ walletAddress: Keypair.random().publicKey() });
  const task = await createTask({ campaignId: campaign.id, prompt: `Held ${Math.random()}?` });
  const submission = await prisma.submission.create({
    data: {
      userId: user.id,
      walletAddress: user.walletAddress,
      taskId: task.id,
      choice: "A",
      reason: VALID_REASON,
      payoutAmountUnits: AMOUNT,
      payoutStatus: "needs_reconciliation",
      payoutTxHash: hash,
    },
  });
  // What the worker's quarantine writes: the job fails carrying no tuple, because
  // the write that would have carried one is the write that failed.
  await prisma.payoutJob.create({
    data: {
      type: "SUBMISSION_PAYOUT",
      submissionId: submission.id,
      status: "failed",
      completedAt: new Date(),
      lastError: "payment accepted on-chain but could not be recorded",
    },
  });
  await prisma.payoutAttempt.create({
    data: { submissionId: submission.id, envelopeHash: hash, expiresAt: new Date(Date.now() + 180_000), status: "open" },
  });
  chain.set(hash, "confirmed");
  envelopes.set(hash, payoutEnvelope(user.walletAddress, (Number(AMOUNT) / 1e7).toFixed(7)));
  return { submission, user, task, campaign };
}

describe("F4 — confirming a held payout repairs the job tuple the caps sum", () => {
  // The finding: the quarantine leaves the job with no txHash/amountUnits/
  // broadcastAt. Both rolling daily caps sum exactly those columns, so a payment
  // that provably applied on-chain was invisible to them and the cap let more
  // through than it should.
  it("writes the tuple, so the rolling cap counts the payment", async () => {
    const hash = "held-tuple";
    const { submission } = await quarantined(hash);

    expect((await getPayoutActivitySince(new Date(Date.now() - 86_400_000))).volumeUnits).toBe(0n);

    await settleHeldPayment(submission.id, hash);

    const job = await prisma.payoutJob.findUniqueOrThrow({ where: { submissionId: submission.id } });
    expect(job.txHash).toBe(hash);
    expect(job.amountUnits).toBe(AMOUNT);
    expect(job.broadcastAt).not.toBeNull();

    const activity = await getPayoutActivitySince(new Date(Date.now() - 86_400_000));
    expect(activity.volumeUnits).toBe(AMOUNT);
    expect(activity.count).toBe(1);
  });

  it("confirms the submission and credits the user once", async () => {
    const hash = "held-credit";
    const { submission, user } = await quarantined(hash);

    await settleHeldPayment(submission.id, hash);
    await settleHeldPayment(submission.id, hash);

    expect(await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } })).toMatchObject({
      payoutStatus: "confirmed",
    });
    expect(
      await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { totalEarnedUnits: true, submissionCount: true },
      }),
    ).toEqual({ totalEarnedUnits: AMOUNT, submissionCount: 1 });
  });

  it("is reported as unreconciled while the tuple is still missing", async () => {
    const hash = "held-report";
    const { submission } = await quarantined(hash);
    // Confirmed by hand, the way a pre-fix reconciler left it: status moved, job untouched.
    await prisma.submission.update({ where: { id: submission.id }, data: { payoutStatus: "confirmed" } });

    const report = await buildReconcileReport({
      since: new Date(Date.now() - 86_400_000),
      until: new Date(Date.now() + 60_000),
      horizon: {
        lookupTx: async (h: string) => {
          const status = chain.get(h);
          return (status ? { status, envelopeXdr: envelopes.get(h)! } : { status: "not_found" }) as any;
        },
        expected: { payoutAccount: PAYOUT_ACCOUNT, asset: USDC },
      },
    });

    expect(report.unreconciled.map((f) => f.kind)).toContain("payout_job_tuple_missing");
    expect(report.zeroUnreconciled).toBe(false);
  });
});

describe("F5 — a confirmed payout does not keep a stale Horizon error", () => {
  it("clears payoutError when a sent payout is confirmed after a read failure", async () => {
    const hash = "sent-after-error";
    const { submission } = await quarantined(hash);
    // The `sent` shape, carrying the error an earlier unreadable pass wrote.
    await prisma.submission.update({
      where: { id: submission.id },
      data: { payoutStatus: "sent", payoutError: "Horizon read failed: connect ETIMEDOUT" },
    });

    await reconcileSubmission(submission.id, hash);

    expect(await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } })).toMatchObject({
      payoutStatus: "confirmed",
      payoutError: null,
    });
  });
});

describe("F6 — an excluded hash still reports its journal findings", () => {
  // The finding: the QA-fixture and legacy-EVM branches `continue`d past the one
  // place findings were appended, so a fixture hash could mask a real
  // `attempt_expired_open` and the report still headlined zero unreconciled.
  async function withExpiredOpenAttempt(hash: string) {
    const user = await createUser({ walletAddress: Keypair.random().publicKey() });
    const task = await createTask({ prompt: `Excluded ${Math.random()}?` });
    const submission = await prisma.submission.create({
      data: {
        userId: user.id,
        walletAddress: user.walletAddress,
        taskId: task.id,
        choice: "A",
        reason: VALID_REASON,
        payoutAmountUnits: AMOUNT,
        payoutStatus: "confirmed",
        payoutTxHash: hash,
      },
    });
    await prisma.payoutAttempt.create({
      data: {
        submissionId: submission.id,
        envelopeHash: `${hash}-envelope`,
        expiresAt: new Date(Date.now() - 60_000),
        status: "open",
      },
    });
    return submission;
  }

  const runReport = () =>
    buildReconcileReport({
      since: new Date(Date.now() - 86_400_000),
      until: new Date(Date.now() + 60_000),
      horizon: null,
    });

  it("keeps an expired open envelope behind a legacy EVM hash", async () => {
    const submission = await withExpiredOpenAttempt(`0x${"a".repeat(64)}`);

    const report = await runReport();

    expect(report.excluded.legacyEvm.map((e) => e.submissionId)).toContain(submission.id);
    expect(report.unreconciled.map((f) => f.kind)).toContain("attempt_expired_open");
    expect(report.zeroUnreconciled).toBe(false);
  });

  it("still excludes the hash itself from the Horizon verdict", async () => {
    await withExpiredOpenAttempt(`0x${"b".repeat(64)}`);

    const report = await runReport();

    // Excluded means "Horizon can never answer for this hash", so no
    // horizon_* finding is raised for it even with no Horizon configured.
    expect(report.unreconciled.map((f) => f.kind)).not.toContain("horizon_unchecked");
    expect(report.reconciled).toEqual([]);
  });
});
