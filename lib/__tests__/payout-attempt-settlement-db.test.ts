import { Keypair } from "@stellar/stellar-sdk";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// #38 — one submission cannot pay twice, whatever happened to the last attempt.
//
// The case #38 exists for: a payer signs an envelope, Horizon includes it, and
// the process dies (a web redeploy — the worker runs inside `web`) before the
// hash is written. The submission reads `pending` with no hash, which every
// payer, and the co-signer, used to read as "unpaid". Now the envelope is
// recorded before submit, so the next payer finds it and settles it by its hash.
//
// The claim SQL, the advisory lock, the attempts table and both payers run for
// real. Horizon is a fake chain that remembers which envelopes landed, and the
// submitter is a fake that honours its journal contract (open before submit).

const chain = new Map<string, "confirmed" | "failed">();
let ledgerCloseMs: number | null = null;
let lookupFails = false;
let broadcasts: string[] = [];

const { mockSubmitMultisigPayout } = vi.hoisted(() => ({ mockSubmitMultisigPayout: vi.fn() }));

vi.mock("@/lib/stellar/payout-submitter", () => ({ submitMultisigPayout: mockSubmitMultisigPayout }));
vi.mock("@/lib/stellar/payout-cosigner", () => ({
  resolvePayoutCoSigner: vi.fn(() => ({ signPayout: vi.fn() })),
}));
vi.mock("@/lib/stellar/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar/client")>();
  return {
    ...actual,
    getTxStatus: vi.fn(async (hash: string) => {
      if (lookupFails) throw new Error("503 Service Unavailable");
      return chain.get(hash) ?? "not_found";
    }),
    latestLedgerCloseMs: vi.fn(async () => ledgerCloseMs),
    // Submit refuses a wallet with no USDC trustline (#133 review); these are generated.
    accountHasUsdcTrustline: vi.fn(async () => true),
  };
});
vi.mock("@/lib/stellar/balance", () => ({ checkAndAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/health-alert", () => ({ sendDedupedDiscordAlert: vi.fn(async () => "sent") }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/rate-limit", async () => ({ checkWalletRateLimit: vi.fn(async () => false) }));

import { claimNextJob, processJob } from "@/lib/payout-worker";
import { reprocessPayoutWithNonceSafety } from "@/lib/payout-service";
import { settleOpenAttempt } from "@/lib/payout-attempts";
import { StellarPaymentError } from "@/lib/stellar/client";
import { NextRequest } from "next/server";
import { POST as submit } from "@/app/api/submit/route";
import { signLabelerJWT } from "@/lib/labeler-auth";
import { prisma, truncateAll } from "@/tests/helpers/db";
import {
  createCampaign,
  createCampaignBalance,
  createTask,
  createUser,
  VALID_REASON,
} from "@/tests/helpers/factories";

const AMOUNT = 2_500_000n;
const ORIGINAL_ENV = { ...process.env };
const LONG_AGO = () => new Date(Date.now() - 10 * 60_000);

beforeEach(async () => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV, DAILY_PAYOUT_CAP_UNITS: "0" };
  chain.clear();
  ledgerCloseMs = Date.now();
  lookupFails = false;
  broadcasts = [];
  // A submitter that keeps its contract: the envelope is journalled before it
  // is submitted, and the chain includes it.
  mockSubmitMultisigPayout.mockImplementation(
    async (_req: unknown, { attempts }: { attempts?: { open(e: { hash: string; expiresAt: Date }): Promise<void> } }) => {
      const hash = `envelope-${broadcasts.length + 1}-${Math.random().toString(16).slice(2, 10)}`;
      await attempts?.open({ hash, expiresAt: new Date(Date.now() + 180_000) });
      broadcasts.push(hash);
      chain.set(hash, "confirmed");
      return { hash };
    },
  );
  await truncateAll();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/**
 * The state a redeploy leaves behind: the envelope landed on-chain, the attempt
 * is open, and the process died before writing the hash — the submission reads
 * `pending` with no hash, its lease and its job's heartbeat long lapsed.
 */
async function diedAfterSubmit(opts: { landed?: "confirmed" | "failed" | null; expiresInMs?: number } = {}) {
  const user = await createUser({ walletAddress: Keypair.random().publicKey() });
  const task = await createTask({ campaignId: null });
  const submission = await prisma.submission.create({
    data: {
      userId: user.id,
      walletAddress: user.walletAddress,
      taskId: task.id,
      choice: "A",
      reason: VALID_REASON,
      payoutAmountUnits: AMOUNT,
      payoutStatus: "pending",
      lastRetriedAt: LONG_AGO(),
      createdAt: LONG_AGO(),
    },
  });
  const job = await prisma.payoutJob.create({
    data: { type: "SUBMISSION_PAYOUT", submissionId: submission.id, status: "processing", workerHeartbeatAt: LONG_AGO() },
  });
  const envelopeHash = "e".repeat(64);
  await prisma.payoutAttempt.create({
    data: { submissionId: submission.id, envelopeHash, expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 120_000)) },
  });
  if (opts.landed !== null) chain.set(envelopeHash, opts.landed ?? "confirmed");
  return { user, submission, job, envelopeHash };
}

async function workerTick() {
  const claimed = await claimNextJob();
  if (!claimed) return null;
  await processJob(claimed.id, claimed.submissionId, claimed.userId, claimed.amountUnits, claimed.type);
  return claimed.id;
}

const row = (id: string) => prisma.submission.findUniqueOrThrow({ where: { id } });
const attempt = (hash: string) => prisma.payoutAttempt.findUniqueOrThrow({ where: { envelopeHash: hash } });

describe("a payer restarting after an accepted submit (#38)", () => {
  it("records the landed envelope and broadcasts nothing", async () => {
    const { submission, job, envelopeHash } = await diedAfterSubmit();

    await workerTick();

    expect(broadcasts).toHaveLength(0);
    expect(await row(submission.id)).toMatchObject({ payoutStatus: "sent", payoutTxHash: envelopeHash });
    expect(await attempt(envelopeHash)).toMatchObject({ status: "confirmed" });
    expect(await prisma.payoutJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "done",
      txHash: envelopeHash,
      amountUnits: AMOUNT,
    });
  });

  it("does the same through the retry path", async () => {
    const { submission, envelopeHash } = await diedAfterSubmit();
    await prisma.payoutJob.updateMany({ data: { status: "failed" } });

    await reprocessPayoutWithNonceSafety(submission.id);

    expect(broadcasts).toHaveLength(0);
    expect(await row(submission.id)).toMatchObject({ payoutStatus: "sent", payoutTxHash: envelopeHash });
  });

  it("pays once when the worker and eight retry-path calls race on the restarted row", async () => {
    const { submission, envelopeHash } = await diedAfterSubmit();

    await Promise.all([
      workerTick(),
      ...Array.from({ length: 8 }, () => reprocessPayoutWithNonceSafety(submission.id).catch(() => {})),
    ]);

    expect(broadcasts).toHaveLength(0);
    expect(await row(submission.id)).toMatchObject({ payoutStatus: "sent", payoutTxHash: envelopeHash });
  });

  it("settles by hash even when the attempt's own payer is the one that crashed mid-flight", async () => {
    // Not a fabricated state: the first run journals and lands its envelope,
    // then dies before recording it.
    const { submission, job } = await diedAfterSubmit({ landed: null });
    await prisma.payoutAttempt.deleteMany();
    mockSubmitMultisigPayout.mockImplementationOnce(
      async (_req: unknown, { attempts }: { attempts: { open(e: { hash: string; expiresAt: Date }): Promise<void> } }) => {
        const hash = "f".repeat(64);
        await attempts.open({ hash, expiresAt: new Date(Date.now() + 180_000) });
        broadcasts.push(hash);
        chain.set(hash, "confirmed");
        throw new Error("process killed after Horizon accepted the envelope");
      },
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await workerTick();
    // The job requeued; take it again as the restarted process would.
    await prisma.payoutJob.update({ where: { id: job.id }, data: { status: "queued", notBefore: null } });
    await workerTick();

    error.mockRestore();
    warn.mockRestore();
    expect(broadcasts).toEqual(["f".repeat(64)]);
    expect(await row(submission.id)).toMatchObject({ payoutStatus: "sent", payoutTxHash: "f".repeat(64) });
  });
});

describe("an envelope whose fate is not yet known (#38)", () => {
  it("builds nothing while it may still land, and waits without spending a retry", async () => {
    const { submission, job } = await diedAfterSubmit({ landed: null });

    await workerTick();

    expect(broadcasts).toHaveLength(0);
    const waiting = await prisma.payoutJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(waiting.status).toBe("queued");
    expect(waiting.retryCount).toBe(0);
    expect(waiting.notBefore!.getTime()).toBeGreaterThan(Date.now());
    expect(await row(submission.id)).toMatchObject({ payoutStatus: "pending", payoutTxHash: null, lastRetriedAt: null });
    // Not due yet, so no worker reclaims it in a hot loop.
    expect(await claimNextJob()).toBeNull();
  });

  it("builds nothing when Horizon cannot be asked", async () => {
    const { submission } = await diedAfterSubmit();
    lookupFails = true;

    await workerTick();

    expect(broadcasts).toHaveLength(0);
    expect(await row(submission.id)).toMatchObject({ payoutStatus: "pending", payoutTxHash: null });
  });

  it("the retry path refuses to build too, and spends no retry", async () => {
    const { submission } = await diedAfterSubmit({ landed: null });
    await prisma.payoutJob.updateMany({ data: { status: "failed" } });

    const err = await reprocessPayoutWithNonceSafety(submission.id).catch((e) => e);

    expect(err).toBeInstanceOf(StellarPaymentError);
    expect(err.code).toBe("attempt_unsettled");
    expect(broadcasts).toHaveLength(0);
    expect(await row(submission.id)).toMatchObject({ payoutStatus: "pending", retryCount: 0 });
  });

  it("builds exactly one new envelope once the old one is proven absent past its time bounds", async () => {
    const { submission, envelopeHash } = await diedAfterSubmit({ landed: null, expiresInMs: -60_000 });
    ledgerCloseMs = Date.now();

    await workerTick();

    expect(broadcasts).toHaveLength(1);
    expect(await attempt(envelopeHash)).toMatchObject({ status: "void", outcome: "expired unincluded" });
    expect(await row(submission.id)).toMatchObject({ payoutStatus: "sent", payoutTxHash: broadcasts[0] });
    expect(await attempt(broadcasts[0])).toMatchObject({ status: "confirmed" });
  });

  it("builds one new envelope for an old one that was included and failed", async () => {
    const { submission, envelopeHash } = await diedAfterSubmit({ landed: "failed" });

    await workerTick();

    expect(broadcasts).toHaveLength(1);
    expect(await attempt(envelopeHash)).toMatchObject({ status: "void", outcome: "included and failed" });
    expect(await row(submission.id)).toMatchObject({ payoutStatus: "sent", payoutTxHash: broadcasts[0] });
  });

  it("never trusts an absence seen before the post-expiry ledger", async () => {
    // Absent at first, included inside its bounds, then a ledger past maxTime:
    // the absence was stale, and the envelope paid.
    const { submission, envelopeHash } = await diedAfterSubmit({ landed: null, expiresInMs: -60_000 });
    const { getTxStatus } = await import("@/lib/stellar/client");
    vi.mocked(getTxStatus).mockResolvedValueOnce("not_found").mockResolvedValueOnce("confirmed");

    await workerTick();

    expect(broadcasts).toHaveLength(0);
    expect(await row(submission.id)).toMatchObject({ payoutStatus: "sent", payoutTxHash: envelopeHash });
  });
});

describe("settleOpenAttempt (#38)", () => {
  it("leaves a landed attempt open until the caller records it", async () => {
    // Confirming here would let a crash before the caller's write leave a row
    // with no hash and no open attempt: the next payer would build again.
    const { submission, envelopeHash } = await diedAfterSubmit();

    expect(await settleOpenAttempt(submission.id)).toEqual({ kind: "paid", hash: envelopeHash });
    expect(await attempt(envelopeHash)).toMatchObject({ status: "open" });
  });

  it("is clear for a submission with no attempts", async () => {
    const { submission } = await diedAfterSubmit();
    await prisma.payoutAttempt.deleteMany();
    expect(await settleOpenAttempt(submission.id)).toEqual({ kind: "clear" });
  });
});

describe("end to end: an accepted answer whose payer is killed mid-broadcast (#38)", () => {
  it("pays once, debits once, and records one job", async () => {
    process.env.PLATFORM_FEE_UNITS = "1500000";
    const campaign = await createCampaign({ rewardUnits: AMOUNT });
    await createCampaignBalance(campaign.id, 1_000_000_000n);
    const task = await createTask({ campaignId: campaign.id });
    const user = await createUser({ walletAddress: Keypair.random().publicKey() });

    const res = await submit(
      new NextRequest("http://localhost/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `labeler_session=${await signLabelerJWT(user.id)}` },
        body: JSON.stringify({ taskId: task.id, choice: "A", reason: VALID_REASON }),
      }),
    );
    expect(res.status).toBe(200);
    const { submissionId } = await res.json();

    // The first worker's envelope lands, and the process is killed before the
    // hash is written. Its catch never runs — a kill leaves no bookkeeping.
    mockSubmitMultisigPayout.mockImplementationOnce(
      async (_req: unknown, { attempts }: { attempts?: { open(e: { hash: string; expiresAt: Date }): Promise<void> } }) => {
        const hash = "k".repeat(64);
        await attempts?.open({ hash, expiresAt: new Date(Date.now() + 180_000) });
        broadcasts.push(hash);
        chain.set(hash, "confirmed");
        return new Promise<never>(() => {});
      },
    );
    const claimed = await claimNextJob();
    void processJob(claimed!.id, claimed!.submissionId, claimed!.userId, claimed!.amountUnits, claimed!.type);
    await vi.waitFor(() => expect(broadcasts).toHaveLength(1));

    // The restart: the dead worker's job heartbeat and row lease have lapsed.
    await prisma.payoutJob.update({ where: { id: claimed!.id }, data: { workerHeartbeatAt: LONG_AGO() } });
    await prisma.submission.update({ where: { id: submissionId }, data: { lastRetriedAt: LONG_AGO() } });
    await workerTick();

    expect(broadcasts).toEqual(["k".repeat(64)]);
    expect(await row(submissionId)).toMatchObject({ payoutStatus: "sent", payoutTxHash: "k".repeat(64) });
    expect(await prisma.payoutJob.count()).toBe(1);
    const debits = await prisma.balanceLedger.findMany({ where: { submissionId }, select: { type: true } });
    expect(debits.map((d) => d.type).sort()).toEqual(["DEBIT_FEE", "DEBIT_REWARD"]);
  });
});
