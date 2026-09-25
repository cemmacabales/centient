import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// #40 D6 — the zero-unreconciled report.
//
// Built from the database and Horizon alone. Every broadcast payout in the
// window is either reconciled, still pending inside its grace period, excluded
// for a stated reason (a QA fixture hash, a pre-Stellar EVM hash), or listed as
// unreconciled under exactly one kind. Zero means that last list is empty.
// Horizon here is a fake chain serving real envelopes; nothing reaches a network.

import { buildReconcileReport, renderReconcileMarkdown, type ReportHorizon } from "@/lib/payout-reconcile-report";
import { PAYOUT_MISMATCH } from "@/lib/payout-reconcile";
import type { TxLookup } from "@/lib/stellar/client";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createCampaign, createTask, createUser, VALID_REASON } from "@/tests/helpers/factories";

const PAYOUT_ACCOUNT = Keypair.random().publicKey();
const USDC = new Asset("USDC", Keypair.random().publicKey());
const AMOUNT = 2_500_000n;
const MINUTE = 60_000;

const chain = new Map<string, TxLookup>();
const horizon: ReportHorizon = {
  lookupTx: async (hash) => {
    const found = chain.get(hash);
    if (found) return found;
    if (hash.startsWith("unreadable")) throw new Error("Horizon 503");
    return { status: "not_found" };
  },
  expected: { payoutAccount: PAYOUT_ACCOUNT, asset: USDC },
};

const ORIGINAL_ENV = { ...process.env };
const since = () => new Date(Date.now() - 60 * MINUTE);

beforeEach(async () => {
  process.env = { ...ORIGINAL_ENV, STELLAR_NETWORK: "testnet" };
  chain.clear();
  campaignId = "";
  await truncateAll();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/** A random lowercase-hex hash, the shape Horizon issues. */
const stellarHash = () => Buffer.from(Keypair.random().rawPublicKey()).toString("hex");

function envelope(destination: string, amount = "0.2500000") {
  const inner = new TransactionBuilder(new Account(PAYOUT_ACCOUNT, "41"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination, asset: USDC, amount }))
    .setTimeout(180)
    .build();
  return TransactionBuilder.buildFeeBumpTransaction(PAYOUT_ACCOUNT, "200", inner, Networks.TESTNET).toXDR();
}

let campaignId: string;
async function payout(opts: {
  status: string;
  hash?: string | null;
  createdAt?: Date;
  broadcastAt?: Date;
  payoutError?: string;
}) {
  if (!campaignId) campaignId = (await createCampaign({ rewardUnits: AMOUNT })).id;
  const user = await createUser({ walletAddress: Keypair.random().publicKey() });
  const task = await createTask({ campaignId, prompt: `Report ${Math.random()}?` });
  const submission = await prisma.submission.create({
    data: {
      userId: user.id,
      walletAddress: user.walletAddress,
      taskId: task.id,
      choice: "A",
      reason: VALID_REASON,
      payoutAmountUnits: AMOUNT,
      payoutStatus: opts.status,
      payoutTxHash: opts.hash ?? null,
      payoutError: opts.payoutError ?? null,
      createdAt: opts.createdAt ?? new Date(Date.now() - 20 * MINUTE),
    },
  });
  if (opts.hash) {
    await prisma.payoutJob.create({
      data: {
        type: "SUBMISSION_PAYOUT",
        submissionId: submission.id,
        status: "done",
        txHash: opts.hash,
        amountUnits: AMOUNT,
        broadcastAt: opts.broadcastAt ?? new Date(Date.now() - 20 * MINUTE),
      },
    });
  }
  return { submission, wallet: user.walletAddress! };
}

/** A payout confirmed in the database and, on the fake chain, exactly as owed. */
async function reconciled() {
  const hash = stellarHash();
  const { submission, wallet } = await payout({ status: "confirmed", hash });
  chain.set(hash, { status: "confirmed", envelopeXdr: envelope(wallet) });
  await prisma.payoutAttempt.create({
    data: { submissionId: submission.id, envelopeHash: hash, expiresAt: new Date(), status: "confirmed" },
  });
  return { submission, hash };
}

const report = () => buildReconcileReport({ since: since(), until: new Date(), sentOverdueMs: 10 * MINUTE, horizon });

describe("buildReconcileReport", () => {
  it("reports zero on a clean ledger, accounting for every payout", async () => {
    await reconciled();
    await reconciled();
    // Sent a minute ago: pending, inside its grace period, not unreconciled.
    const recent = stellarHash();
    await payout({ status: "sent", hash: recent, broadcastAt: new Date(Date.now() - MINUTE) });
    await payout({ status: "skipped" });

    const r = await report();

    expect(r.unreconciled).toEqual([]);
    expect(r.zeroUnreconciled).toBe(true);
    expect(r.reconciled).toHaveLength(2);
    expect(r.pending.map((p) => p.hash)).toEqual([recent]);
    expect(r.totals.submissions).toBe(4);
    expect(r.totals.byStatus.confirmed).toEqual({ count: 2, units: "5000000" });
    expect(renderReconcileMarkdown(r)).toMatch(/Zero unreconciled/);
  });

  it("lists one row of each unreconciled kind exactly once", async () => {
    const overdue = await payout({ status: "sent", hash: stellarHash(), broadcastAt: new Date(Date.now() - 30 * MINUTE) });
    const failedWithHash = await payout({ status: "failed", hash: stellarHash() });
    const held = await payout({ status: "needs_reconciliation", hash: stellarHash(), payoutError: "accepted payment needs manual reconciliation" });
    const heldMismatch = await payout({
      status: "needs_reconciliation",
      hash: stellarHash(),
      payoutError: `${PAYOUT_MISMATCH} h applied but does not match the submission: destination …`,
    });

    const expiredOpen = await payout({ status: "pending" });
    await prisma.payoutAttempt.create({
      data: { submissionId: expiredOpen.submission.id, envelopeHash: stellarHash(), expiresAt: new Date(Date.now() - MINUTE) },
    });

    const twiceLanded = await reconciled();
    await prisma.payoutAttempt.create({
      data: { submissionId: twiceLanded.submission.id, envelopeHash: stellarHash(), expiresAt: new Date(), status: "confirmed" },
    });

    const sharedHash = stellarHash();
    const sharedA = await payout({ status: "confirmed", hash: sharedHash });
    const sharedB = await payout({ status: "abandoned", hash: sharedHash });
    chain.set(sharedHash, { status: "confirmed", envelopeXdr: envelope(sharedA.wallet) });

    const mismatchHash = stellarHash();
    const onChainMismatch = await payout({ status: "confirmed", hash: mismatchHash });
    chain.set(mismatchHash, { status: "confirmed", envelopeXdr: envelope(Keypair.random().publicKey()) });

    const failedHash = stellarHash();
    const onChainFailed = await payout({ status: "confirmed", hash: failedHash });
    chain.set(failedHash, { status: "failed", envelopeXdr: envelope(onChainFailed.wallet) });

    const missing = await payout({ status: "confirmed", hash: stellarHash() });
    const unreadable = await payout({ status: "confirmed", hash: `unreadable${stellarHash().slice(10)}` });

    const r = await report();

    const kinds = Object.fromEntries(r.unreconciled.map((f) => [`${f.kind}:${f.submissionId}`, f]));
    expect(Object.keys(kinds).sort()).toEqual(
      [
        `sent_overdue:${overdue.submission.id}`,
        `terminal_with_hash:${failedWithHash.submission.id}`,
        `held:${held.submission.id}`,
        `held_mismatch:${heldMismatch.submission.id}`,
        `attempt_expired_open:${expiredOpen.submission.id}`,
        `multiple_landed_attempts:${twiceLanded.submission.id}`,
        `shared_hash:${sharedA.submission.id}`,
        `shared_hash:${sharedB.submission.id}`,
        `terminal_with_hash:${sharedB.submission.id}`,
        `horizon_mismatch:${onChainMismatch.submission.id}`,
        `horizon_failed:${onChainFailed.submission.id}`,
        `horizon_missing:${missing.submission.id}`,
        `horizon_unreadable:${unreadable.submission.id}`,
      ].sort(),
    );
    expect(r.unreconciled).toHaveLength(13);
    expect(kinds[`horizon_mismatch:${onChainMismatch.submission.id}`].detail).toMatch(/destination/);
    expect(r.zeroUnreconciled).toBe(false);
    expect(renderReconcileMarkdown(r)).toMatch(/13 unreconciled/);
  });

  it("buckets QA fixture and pre-Stellar EVM hashes as excluded, never as unreconciled", async () => {
    const fixture = await payout({ status: "needs_reconciliation", hash: "qa-mtvag3vh6bdc97-1" });
    const evm = await payout({ status: "abandoned", hash: `0x${stellarHash()}` });

    const r = await report();

    expect(r.unreconciled).toEqual([]);
    expect(r.excluded.qaFixture.map((f) => f.submissionId)).toEqual([fixture.submission.id]);
    expect(r.excluded.legacyEvm.map((f) => f.submissionId)).toEqual([evm.submission.id]);
    expect(r.zeroUnreconciled).toBe(true);
  });

  it("reads only the window it is given", async () => {
    await payout({ status: "failed", hash: stellarHash(), createdAt: new Date(Date.now() - 3 * 60 * MINUTE) });

    const r = await report();

    expect(r.totals.submissions).toBe(0);
    expect(r.zeroUnreconciled).toBe(true);
  });

  it("without Horizon, never calls a confirmed payout reconciled", async () => {
    await reconciled();

    const r = await buildReconcileReport({ since: since(), until: new Date(), horizon: null });

    expect(r.horizonChecked).toBe(false);
    expect(r.reconciled).toEqual([]);
    expect(r.unreconciled.map((f) => f.kind)).toEqual(["horizon_unchecked"]);
    expect(r.zeroUnreconciled).toBe(false);
  });

  it("is reproducible: the same ledger and chain give the same findings", async () => {
    await reconciled();
    await payout({ status: "failed", hash: stellarHash() });

    const window = { since: since(), until: new Date(), sentOverdueMs: 10 * MINUTE, horizon };
    const [a, b] = [await buildReconcileReport(window), await buildReconcileReport(window)];

    expect({ ...a, generatedAt: null }).toEqual({ ...b, generatedAt: null });
  });
});
