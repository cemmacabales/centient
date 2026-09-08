import { Keypair } from "@stellar/stellar-sdk";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Zero double-pays under load, end to end (#12).
//
// What was already covered, and why it is not this: `payout-submitter.test.ts`
// races twelve payouts through the sequence mutex, and
// `payout-worker-claim-db.test.ts` covers the claim/quarantine boundary in
// isolation. Neither runs N payouts through the whole path — claim, cap check,
// broadcast, persist — against a real database.
//
// These cases try to defeat the guards the rail actually relies on:
//
//   * `claimNextJob`'s `FOR UPDATE SKIP LOCKED`, so two workers never hold the
//     same job
//   * the partial unique index that permits one in-flight WITHDRAWAL per user
//   * the per-wallet `pg_advisory_xact_lock` in `claimForRetry`
//   * the stored `payoutTxHash`, which refuses re-broadcast even from a row
//     reading `failed`
//
// The Horizon submit is replaced so every broadcast can be counted exactly, and
// only the submit: the claim SQL, the advisory lock, the unique indexes, and the
// worker's own control flow all run for real. Replacing `submitMultisigPayout`
// also removes its process-local sequence mutex, which makes contention *more*
// likely here rather than less — the serialization it provides is proven in its
// own suite, and leaning on it here would hide whatever the database guards do
// not catch.
//
// The suite is not parallel-safe (`pool: "forks"`, `fileParallelism: false`, one
// shared database), so every case creates its own contention inside one test
// rather than relying on files racing each other.

const { mockSubmitMultisigPayout } = vi.hoisted(() => ({
  mockSubmitMultisigPayout: vi.fn(),
}));

vi.mock("@/lib/stellar/payout-submitter", () => ({
  submitMultisigPayout: mockSubmitMultisigPayout,
}));

vi.mock("@/lib/stellar/payout-cosigner", () => ({
  resolvePayoutCoSigner: vi.fn(() => ({ signPayout: vi.fn() })),
}));

vi.mock("@/lib/stellar/balance", () => ({ checkAndAlert: vi.fn(async () => {}) }));

vi.mock("@/lib/health-alert", () => ({
  sendDedupedDiscordAlert: vi.fn(async () => "sent"),
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

import { claimNextJob, processJob } from "@/lib/payout-worker";
import { reprocessPayoutWithNonceSafety } from "@/lib/payout-service";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser, createTask, VALID_REASON } from "@/tests/helpers/factories";

const WORKERS = 8;
const AMOUNT_UNITS = 5_000_000n;
const ORIGINAL_ENV = { ...process.env };

/** Every destination the fake Horizon was asked to pay, in call order. */
let broadcasts: { destination: string; amountUnits: bigint; reference: string }[] = [];

/** Resolve after `ms` so concurrent payouts genuinely interleave. */
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A labeler with a payable `G…` destination. The shared factory still mints
 * EVM-shaped addresses, which `reprocessPayoutWithNonceSafety` StrKey-rejects
 * before it ever reaches the rail — so these cases would pass for the wrong
 * reason with the default.
 */
function createPayableUser() {
  return createUser({ walletAddress: Keypair.random().publicKey() });
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  // A cap of zero disables the limit, so no case here is decided by the cap
  // rather than by the concurrency guard it is testing. The one case that is
  // about the cap sets its own.
  process.env.DAILY_PAYOUT_CAP_UNITS = "0";
  broadcasts = [];
  mockSubmitMultisigPayout.mockImplementation(async (request: {
    destination: string;
    amountUnits: bigint;
    reference: { kind: string; id: string };
  }) => {
    // Held open long enough that every racing caller is inside the broadcast at
    // the same time — the window a double-pay would have to open in.
    await delay(15);
    broadcasts.push({
      destination: request.destination,
      amountUnits: request.amountUnits,
      reference: `${request.reference.kind}:${request.reference.id}`,
    });
    return { hash: `hash-${broadcasts.length}-${request.reference.id}` };
  });
  await truncateAll();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/** One queued withdrawal per user — the partial unique index allows no more. */
async function enqueueWithdrawals(count: number) {
  const jobs = [];
  for (let i = 0; i < count; i++) {
    const user = await createPayableUser();
    jobs.push(
      await prisma.payoutJob.create({
        data: {
          type: "WITHDRAWAL",
          status: "queued",
          userId: user.id,
          amountUnits: AMOUNT_UNITS,
          destinationAddress: user.walletAddress,
        },
      }),
    );
  }
  return jobs;
}

/** One claim-and-process cycle, exactly as `runWorkerLoop` performs it. */
async function workerTick(): Promise<string | null> {
  const claimed = await claimNextJob();
  if (!claimed) return null;
  await processJob(
    claimed.id,
    claimed.submissionId,
    claimed.userId,
    claimed.amountUnits,
    claimed.type,
  );
  return claimed.id;
}

describe("N concurrent payouts settle once each", () => {
  it("pays every queued withdrawal exactly once across racing workers", async () => {
    const jobs = await enqueueWithdrawals(WORKERS);

    // More workers than jobs, all claiming at once: the surplus must come back
    // empty rather than re-claiming work another worker holds.
    const claimed = await Promise.all(
      Array.from({ length: WORKERS * 2 }, () => workerTick()),
    );

    expect(broadcasts).toHaveLength(WORKERS);
    expect(new Set(broadcasts.map((b) => b.reference)).size).toBe(WORKERS);
    expect(claimed.filter(Boolean).sort()).toEqual(jobs.map((j) => j.id).sort());

    const settled = await prisma.payoutJob.findMany({
      where: { id: { in: jobs.map((j) => j.id) } },
      select: { id: true, txHash: true, amountUnits: true },
    });
    expect(settled.every((job) => job.txHash !== null)).toBe(true);
    // Distinct hashes: one broadcast each, never one hash reused across rows.
    expect(new Set(settled.map((job) => job.txHash)).size).toBe(WORKERS);
  });

  it("lets exactly one worker claim a job when many race for it", async () => {
    const [job] = await enqueueWithdrawals(1);

    const claims = await Promise.all(
      Array.from({ length: WORKERS }, () => claimNextJob()),
    );

    expect(claims.filter((c) => c?.id === job.id)).toHaveLength(1);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("broadcasts a submission payout once when its retry path is re-entered concurrently", async () => {
    // The retry cron and an admin retry can both reach the same submission. The
    // per-wallet advisory lock plus the stored hash are what make the loser a
    // no-op instead of a second payment.
    const user = await createPayableUser();
    const task = await createTask({ campaignId: null, isGold: false });
    const submission = await prisma.submission.create({
      data: {
        walletAddress: user.walletAddress,
        userId: user.id,
        taskId: task.id,
        choice: "A",
        reason: VALID_REASON,
        payoutAmountUnits: AMOUNT_UNITS,
        payoutStatus: "pending",
      },
    });

    await Promise.all(
      Array.from({ length: WORKERS }, () =>
        reprocessPayoutWithNonceSafety(submission.id),
      ),
    );

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      destination: user.walletAddress,
      amountUnits: AMOUNT_UNITS,
      reference: `submission:${submission.id}`,
    });

    const settled = await prisma.submission.findUnique({ where: { id: submission.id } });
    expect(settled?.payoutStatus).toBe("sent");
    expect(settled?.payoutTxHash).toBeTruthy();
  });

  it("retries again once the in-flight lease has expired, so no payout is stranded", async () => {
    // The other half of the lease. A guard that only ever refuses would convert
    // a double-pay into a payout that never happens: a crash between claim and
    // broadcast must not take the submission out of the retry set for good.
    // 61s is past RETRY_CLAIM_LEASE_MS and equals the cron's own shortest
    // backoff, so this is exactly the moment the retry becomes due again.
    const user = await createPayableUser();
    const task = await createTask({ campaignId: null, isGold: false });
    const submission = await prisma.submission.create({
      data: {
        walletAddress: user.walletAddress,
        userId: user.id,
        taskId: task.id,
        choice: "A",
        reason: VALID_REASON,
        payoutAmountUnits: AMOUNT_UNITS,
        payoutStatus: "pending",
        lastRetriedAt: new Date(Date.now() - 61_000),
      },
    });

    await reprocessPayoutWithNonceSafety(submission.id);

    expect(broadcasts).toHaveLength(1);
    const settled = await prisma.submission.findUnique({ where: { id: submission.id } });
    expect(settled?.payoutStatus).toBe("sent");
  });

  it("refuses to re-broadcast a submission that already carries a hash, even when it reads failed", async () => {
    // A stored hash means the transfer left the wallet. `failed` is a
    // bookkeeping state after that point, never a licence to pay again.
    const user = await createPayableUser();
    const task = await createTask({ campaignId: null, isGold: false });
    const submission = await prisma.submission.create({
      data: {
        walletAddress: user.walletAddress,
        userId: user.id,
        taskId: task.id,
        choice: "A",
        reason: VALID_REASON,
        payoutAmountUnits: AMOUNT_UNITS,
        payoutStatus: "failed",
        payoutTxHash: "already-broadcast-hash",
      },
    });

    await Promise.all(
      Array.from({ length: WORKERS }, () =>
        reprocessPayoutWithNonceSafety(submission.id),
      ),
    );

    expect(broadcasts).toHaveLength(0);
    const after = await prisma.submission.findUnique({ where: { id: submission.id } });
    expect(after?.payoutTxHash).toBe("already-broadcast-hash");
  });

  it("records total broadcast volume equal to the ledger, with no row paid twice", async () => {
    const jobs = await enqueueWithdrawals(WORKERS);

    await Promise.all(Array.from({ length: WORKERS * 2 }, () => workerTick()));

    const ledger = await prisma.payoutJob.aggregate({
      _count: { _all: true },
      _sum: { amountUnits: true },
      where: { txHash: { not: null }, broadcastAt: { not: null } },
    });
    // The ledger is the cap's spend side, so a double-pay that the rows missed
    // would also silently raise the daily limit.
    expect(ledger._count._all).toBe(jobs.length);
    expect(ledger._sum.amountUnits).toBe(AMOUNT_UNITS * BigInt(jobs.length));
    expect(broadcasts).toHaveLength(jobs.length);
  });
});

describe("accepted residual risk: the daily cap is a check, not a reservation", () => {
  it("lets concurrent payouts each pass the cap and together exceed it", async () => {
    // Documented in `lib/payout-cap.ts` and named in this issue's residual-risk
    // list. Asserting it keeps the trade-off machine-checked rather than prose:
    // if the cap ever becomes a reservation, this case fails and the residual
    // risk gets removed deliberately instead of drifting out of the evidence.
    //
    // Note what is *not* at risk here — no payout settles twice. Each of these
    // is a distinct withdrawal that the cap individually authorized; the cap
    // alert is what bounds the overshoot, which is why its ordering matters.
    process.env.DAILY_PAYOUT_CAP_UNITS = (AMOUNT_UNITS * 2n).toString();
    const jobs = await enqueueWithdrawals(WORKERS);

    await Promise.all(Array.from({ length: WORKERS }, () => workerTick()));

    const ledger = await prisma.payoutJob.aggregate({
      _sum: { amountUnits: true },
      where: { txHash: { not: null } },
    });
    const spent = ledger._sum.amountUnits ?? 0n;
    expect(spent).toBeGreaterThan(AMOUNT_UNITS * 2n);
    // Still exactly one broadcast per job: over the cap, never paid twice.
    expect(broadcasts).toHaveLength(jobs.length);
    expect(new Set(broadcasts.map((b) => b.reference)).size).toBe(jobs.length);
  });
});
