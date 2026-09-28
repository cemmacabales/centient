import {
  Account,
  Asset,
  Keypair,
  type FeeBumpTransaction,
  type Operation,
  type Transaction,
} from "@stellar/stellar-sdk";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// #46 — failure injection for the D4 failure matrix.
//
// Each block injects one of the four failures the SOW names — a sequence
// collision, a co-signer outage, a cap breach, a Horizon timeout — into the real
// payout rail and checks what the matrix says must and must never happen.
//
// Only the two network edges are replaced. Horizon is a fake that enforces the
// payout account's sequence number and records every envelope it is shown. The
// co-signer is the real decision (`handleCoSignRequest`, reading this database
// through the same ledger reader the deployed service uses) behind a stubbed
// `fetch`, so the payout service reaches it through the real remote client, HMAC
// and all. Everything between — worker, cap, submitter, attempt journal, retry
// path, revival — runs as deployed.
//
// Reproduce: `npx vitest run lib/__tests__/payout-failure-injection-db.test.ts`
// against the test database (see docs/payout-failure-matrix.md).

const h = vi.hoisted(() => ({ horizon: null as unknown as FakeHorizon }));

vi.mock("@/lib/stellar/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar/config")>();
  return { ...actual, server: () => h.horizon.server };
});
vi.mock("@/lib/stellar/balance", () => ({ checkAndAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/health-alert", () => ({ sendDedupedDiscordAlert: vi.fn(async () => "sent") }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

import * as Sentry from "@sentry/nextjs";
import { sendDedupedDiscordAlert } from "@/lib/health-alert";
import { claimNextJob, processJob } from "@/lib/payout-worker";
import { reprocessPayoutWithNonceSafety } from "@/lib/payout-service";
import { reviveStrandedAttempts } from "@/lib/payout-attempt-revival";
import { SUBMISSION_RETRY_BUDGET } from "@/lib/payout-retry-claim";
import { handleCoSignRequest, type CoSignerDeps } from "@/lib/stellar/cosigner-service";
import { readBroadcastVolumeSince, readLedgerPayout } from "@/lib/stellar/cosigner-ledger";
import { prisma, truncateAll } from "@/tests/helpers/db";
import {
  createAdminUser,
  createCampaign,
  createCampaignBalance,
  createTask,
  createUser,
  VALID_REASON,
} from "@/tests/helpers/factories";

const REWARD = 2_500_000n; // 0.25 USDC
const ORIGINAL_ENV = { ...process.env };
const COSIGNER_URL = "https://cosigner.test/cosign";
const SHARED_SECRET = "failure-injection-shared-secret-000000";

const platform = Keypair.random();
const policy = Keypair.random();
const payoutAccount = Keypair.random().publicKey();
const usdc = new Asset("USDC", Keypair.random().publicKey());

/** A Horizon rejection carrying result codes, in the shape Horizon returns it. */
function horizonRejection(result_codes: Record<string, unknown>) {
  return Object.assign(new Error("Request failed with status code 400"), {
    response: { status: 400, data: { extras: { result_codes } } },
  });
}

/** A submit whose response never came back. No result codes: the outcome is unknown. */
function horizonTimeout() {
  return Object.assign(new Error("timeout of 30000ms exceeded"), { code: "ECONNABORTED" });
}

/**
 * Horizon, as far as the payout rail can observe it. `submitTransaction`
 * applies an envelope only if its inner transaction carries the next sequence
 * number, and answers a stale one exactly as Horizon answers a fee bump whose
 * inner transaction is stale.
 */
class FakeHorizon {
  sequence = 1_000n;
  /** Applied envelopes, by the hash Horizon reports for them. */
  readonly landed = new Map<string, FeeBumpTransaction>();
  /** Every envelope presented for submission, applied or not. */
  readonly presented: FeeBumpTransaction[] = [];
  /** Runs after each account load: another submitter spending the sequence. */
  afterLoad: (() => void) | null = null;
  /** Overrides the network's answer to a submit. `apply` is what Horizon would do. */
  onSubmit: ((apply: () => { hash: string }) => Promise<{ hash: string }>) | null = null;
  /** Every read fails, as an unreachable Horizon's does. */
  unreachable = false;
  ledgerCloseMs: () => number = () => Date.now();

  private apply(tx: FeeBumpTransaction): { hash: string } {
    if (BigInt(tx.innerTransaction.sequence) !== this.sequence + 1n) {
      throw horizonRejection({ transaction: "tx_fee_bump_inner_failed", inner_transaction: "tx_bad_seq" });
    }
    this.sequence += 1n;
    const hash = tx.hash().toString("hex");
    this.landed.set(hash, tx);
    return { hash };
  }

  private unavailable() {
    return Object.assign(new Error("Request failed with status code 503"), { response: { status: 503 } });
  }

  readonly server = {
    loadAccount: async (id: string) => {
      if (this.unreachable) throw this.unavailable();
      const account = new Account(id, this.sequence.toString());
      this.afterLoad?.();
      return account;
    },
    fetchBaseFee: async () => 100,
    submitTransaction: async (tx: FeeBumpTransaction) => {
      this.presented.push(tx);
      return this.onSubmit ? this.onSubmit(() => this.apply(tx)) : this.apply(tx);
    },
    transactions: () => ({
      transaction: (hash: string) => ({
        call: async () => {
          if (this.unreachable) throw this.unavailable();
          const tx = this.landed.get(hash);
          if (!tx) throw Object.assign(new Error("Not Found"), { response: { status: 404 } });
          return { successful: true, envelope_xdr: tx.toXDR() };
        },
      }),
    }),
    ledgers: () => ({
      order: () => ({
        limit: () => ({
          call: async () => {
            if (this.unreachable) throw this.unavailable();
            return { records: [{ closed_at: new Date(this.ledgerCloseMs()).toISOString() }] };
          },
        }),
      }),
    }),
  };

  /** Payments that applied to `destination`, one entry per landed envelope. */
  paymentsTo(destination: string): { hash: string; amount: string; envelope: FeeBumpTransaction }[] {
    return [...this.landed.entries()].flatMap(([hash, envelope]) =>
      envelope.innerTransaction.operations
        .filter((op): op is Operation.Payment => op.type === "payment" && op.destination === destination)
        .map((op) => ({ hash, amount: op.amount, envelope })),
    );
  }
}

/** The co-signer's side of the wire: its answers, and a switch to take it down. */
interface CoSignerHarness {
  deps: CoSignerDeps;
  /** When set, replaces the co-signer's answer: an outage, a timeout, a 5xx. */
  fault: (() => Promise<Response>) | null;
  signed: number;
  refusals: string[];
  /** Requests that reached the co-signer at all. */
  calls: number;
}

let horizon: FakeHorizon;
let cosigner: CoSignerHarness;

function spentNonces() {
  const seen = new Set<string>();
  return { take: (nonce: string) => (seen.has(nonce) ? false : (seen.add(nonce), true)) };
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env = {
    ...ORIGINAL_ENV,
    STELLAR_NETWORK: "testnet",
    STELLAR_USDC_ISSUER: usdc.getIssuer(),
    STELLAR_PLATFORM_ACCOUNT: payoutAccount,
    STELLAR_OPS_SIGNER_SECRET: platform.secret(),
    STELLAR_POLICY_SIGNER_PUBLIC: policy.publicKey(),
    COSIGNER_URL,
    COSIGNER_SHARED_SECRET: SHARED_SECRET,
    COSIGNER_ISOLATION_LEVEL: "same-workspace",
    DAILY_PAYOUT_CAP_UNITS: "0",
    PLATFORM_FEE_UNITS: "250000",
  };
  for (const name of [
    "STELLAR_POLICY_SIGNER_SECRET",
    "STELLAR_PLATFORM_SECRET",
    "STELLAR_SPONSOR_SECRET",
    "STELLAR_HORIZON_URL",
    "POSTHOG_KEY",
    "NEXT_PUBLIC_POSTHOG_KEY",
  ]) {
    delete process.env[name];
  }

  horizon = new FakeHorizon();
  h.horizon = horizon;
  cosigner = {
    deps: {
      policy,
      secret: SHARED_SECRET,
      nonces: spentNonces(),
      asset: usdc,
      capUnits: 1_000_000_000_000n,
      ledger: {
        readPayout: (reference) => readLedgerPayout(prisma, reference),
        broadcastVolumeSince: (since) => readBroadcastVolumeSince(prisma, since),
      },
    },
    fault: null,
    signed: 0,
    refusals: [],
    calls: 0,
  };

  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
    if (String(url) !== COSIGNER_URL) throw new Error(`unexpected fetch to ${String(url)}`);
    cosigner.calls += 1;
    if (cosigner.fault) return cosigner.fault();
    const answer = await handleCoSignRequest(
      cosigner.deps,
      String(init.body),
      init.headers as Record<string, string>,
    );
    if (answer.status === 200) cosigner.signed += 1;
    else cosigner.refusals.push(String((answer.body as { error?: unknown }).error));
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  });

  await truncateAll();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
});

/** What submit writes for an accepted answer on a funded campaign: a pending row and its job. */
async function enqueuePayout() {
  const admin = await createAdminUser({ email: `${Keypair.random().publicKey()}@test.com` });
  const campaign = await createCampaign({ adminUserId: admin.id, rewardUnits: REWARD });
  await createCampaignBalance(campaign.id, 0n);
  const user = await createUser();
  const task = await createTask({ campaignId: campaign.id });
  const submission = await prisma.submission.create({
    data: {
      walletAddress: user.walletAddress,
      userId: user.id,
      taskId: task.id,
      choice: "A",
      reason: VALID_REASON,
      payoutAmountUnits: REWARD,
      payoutStatus: "pending",
    },
  });
  await prisma.payoutJob.create({ data: { type: "SUBMISSION_PAYOUT", submissionId: submission.id } });
  return submission;
}

/** An earlier payout that already spent `units` of today's budget. */
async function priorSpend(units: bigint) {
  await prisma.payoutJob.create({
    data: {
      type: "WITHDRAWAL",
      userId: (await createUser()).id,
      amountUnits: units,
      txHash: "a".repeat(64),
      broadcastAt: new Date(),
      status: "done",
    },
  });
}

/** One pass of the payout worker. */
async function workerTick() {
  const claimed = await claimNextJob();
  if (!claimed) throw new Error("nothing to claim");
  await processJob(claimed.id, claimed.submissionId, claimed.userId, claimed.amountUnits, claimed.type);
}

const submissionRow = (id: string) => prisma.submission.findUniqueOrThrow({ where: { id } });
const jobRow = (submissionId: string) => prisma.payoutJob.findUniqueOrThrow({ where: { submissionId } });
const attempts = (submissionId: string) =>
  prisma.payoutAttempt.findMany({ where: { submissionId }, orderBy: { createdAt: "asc" } });
const refunds = (submissionId: string) =>
  prisma.balanceLedger.count({ where: { type: "REFUND", submissionId } });

/** A held job is not due before the co-signer retry delay (#47). */
function expectHeldUntilLater(notBefore: Date | null) {
  expect(notBefore).not.toBeNull();
  expect(notBefore!.getTime()).toBeGreaterThan(Date.now() + 20_000);
}

/** Let a held job's delay pass: `claimNextJob` compares `notBefore` with the database clock. */
async function makeDue(submissionId: string) {
  await prisma.payoutJob.update({ where: { submissionId }, data: { notBefore: new Date(0) } });
}

/** Both required signers, and only they, signed `tx`. */
function signedByBothSigners(tx: Transaction | FeeBumpTransaction): boolean {
  const hash = tx.hash();
  const signers = new Set(
    tx.signatures.map(
      (sig) => [platform, policy].find((kp) => kp.verify(hash, sig.signature()))?.publicKey() ?? "unknown",
    ),
  );
  return signers.size === 2 && signers.has(platform.publicKey()) && signers.has(policy.publicKey());
}

/** Nothing reached the chain for this submission, and nothing claims it did. */
async function expectUnpaid(submissionId: string) {
  const row = await submissionRow(submissionId);
  expect(horizon.paymentsTo(row.walletAddress!)).toHaveLength(0);
  expect(row.payoutTxHash).toBeNull();
  expect(["sent", "confirmed"]).not.toContain(row.payoutStatus);
  return row;
}

/**
 * The submission was paid exactly once, by an envelope carrying both
 * signatures at both stages, and the ledger records that envelope's hash.
 */
async function expectPaidOnce(submissionId: string) {
  const row = await submissionRow(submissionId);
  const payments = horizon.paymentsTo(row.walletAddress!);
  expect(payments).toHaveLength(1);
  const [{ hash, amount, envelope }] = payments;
  expect(amount).toBe("0.2500000");
  expect(signedByBothSigners(envelope.innerTransaction)).toBe(true);
  expect(signedByBothSigners(envelope)).toBe(true);
  expect(row).toMatchObject({ payoutStatus: "sent", payoutTxHash: hash });
  const confirmed = (await attempts(submissionId)).filter((a) => a.status === "confirmed");
  expect(confirmed.map((a) => a.envelopeHash)).toEqual([hash]);
  expect(await refunds(submissionId)).toBe(0);
  return { row, hash };
}

describe("sequence collision (#46)", () => {
  it("rebuilds on a fresh sequence when another submitter spends ours, and pays once", async () => {
    const submission = await enqueuePayout();
    let raced = false;
    horizon.afterLoad = () => {
      if (!raced) {
        raced = true;
        horizon.sequence += 1n; // another process lands a transaction between our load and submit
      }
    };

    await workerTick();

    const { hash } = await expectPaidOnce(submission.id);
    expect(horizon.presented).toHaveLength(2);
    // The stale envelope was rejected, never applied, and recorded as such.
    const [stale, fresh] = await attempts(submission.id);
    expect(stale).toMatchObject({ status: "void" });
    expect(stale.outcome).toContain("tx_bad_seq");
    expect(fresh).toMatchObject({ status: "confirmed", envelopeHash: hash });
    // Handled inside the call: no worker retry was spent on it.
    expect(await jobRow(submission.id)).toMatchObject({ status: "done", retryCount: 0 });
  });

  it("requeues under sustained contention without sending a second transfer", async () => {
    const submission = await enqueuePayout();
    horizon.afterLoad = () => {
      horizon.sequence += 1n; // every sequence we load is gone before we submit
    };

    await workerTick();

    await expectUnpaid(submission.id);
    const job = await jobRow(submission.id);
    expect(job).toMatchObject({ status: "queued", retryCount: 1, txHash: null });
    expect(job.lastError).toContain("tx_bad_seq");
    expect((await attempts(submission.id)).map((a) => a.status)).toEqual(["void", "void"]);
    expect(await refunds(submission.id)).toBe(0);

    horizon.afterLoad = null; // contention clears
    await workerTick();

    await expectPaidOnce(submission.id);
  });

  it("serializes two payouts in one process onto consecutive sequences", async () => {
    const first = await enqueuePayout();
    const second = await enqueuePayout();
    const start = horizon.sequence;

    const [a, b] = [await claimNextJob(), await claimNextJob()];
    await Promise.all(
      [a!, b!].map((job) => processJob(job.id, job.submissionId, job.userId, job.amountUnits, job.type)),
    );

    await expectPaidOnce(first.id);
    await expectPaidOnce(second.id);
    expect(horizon.presented).toHaveLength(2);
    expect(horizon.sequence).toBe(start + 2n);
  });
});

describe("co-signer outage (#46, #47)", () => {
  const outages: [string, () => Promise<Response>][] = [
    ["unreachable", async () => Promise.reject(new TypeError("fetch failed"))],
    [
      "timing out",
      async () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    ],
    ["answering 503", async () => new Response(JSON.stringify({ error: "upstream unavailable" }), { status: 503 })],
  ];

  for (const [label, fault] of outages) {
    it(`holds the payout while the co-signer is ${label}, alerts, then pays once when it returns`, async () => {
      const submission = await enqueuePayout();
      cosigner.fault = fault;

      await workerTick();

      // Never one signature: nothing was even presented to Horizon.
      expect(horizon.presented).toHaveLength(0);
      expect(await attempts(submission.id)).toHaveLength(0);
      const row = await expectUnpaid(submission.id);
      expect(row).toMatchObject({ payoutStatus: "pending", retryCount: 0 });
      expect(row.lastRetriedAt).toBeNull(); // the claim was handed back
      const job = await jobRow(submission.id);
      expect(job).toMatchObject({ status: "queued", txHash: null, retryCount: 0 });
      expect(job.lastError).toMatch(/co-signer (unreachable|unavailable)/);
      expectHeldUntilLater(job.notBefore);
      expect(vi.mocked(sendDedupedDiscordAlert)).toHaveBeenCalledWith(
        expect.objectContaining({ key: "cosigner-unavailable", severity: "PAGE" }),
      );

      cosigner.fault = null;
      await makeDue(submission.id);
      await workerTick();

      await expectPaidOnce(submission.id);
    });
  }

  it("holds the payout through an outage of any length, spending no retry and refunding nothing", async () => {
    // Before #47, three immediate passes failed and refunded it (#46).
    const submission = await enqueuePayout();
    cosigner.fault = async () => Promise.reject(new TypeError("fetch failed"));

    // A deferred job is not claimable until its delay has passed.
    await workerTick();
    expect(await claimNextJob()).toBeNull();

    for (let pass = 0; pass < 5; pass++) {
      await makeDue(submission.id);
      await workerTick();
    }

    expect(horizon.presented).toHaveLength(0);
    const row = await expectUnpaid(submission.id);
    expect(row).toMatchObject({ payoutStatus: "pending", retryCount: 0 });
    expect(await jobRow(submission.id)).toMatchObject({ status: "queued", retryCount: 0 });
    expect(await refunds(submission.id)).toBe(0);
    expect(vi.mocked(Sentry.captureMessage)).not.toHaveBeenCalledWith(
      expect.stringContaining("failed permanently"),
      expect.anything(),
    );

    cosigner.fault = null;
    await makeDue(submission.id);
    await workerTick();

    await expectPaidOnce(submission.id);
  });

  it("the retry path spends no retry on an outage either", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const submission = await enqueuePayout();
    await prisma.payoutJob.deleteMany({ where: { submissionId: submission.id } }); // the cron owns it
    cosigner.fault = async () => Promise.reject(new TypeError("fetch failed"));

    await reprocessPayoutWithNonceSafety(submission.id);

    expect(horizon.presented).toHaveLength(0);
    expect(await expectUnpaid(submission.id)).toMatchObject({ payoutStatus: "pending", retryCount: 0 });
    expect(vi.mocked(sendDedupedDiscordAlert)).toHaveBeenCalledWith(
      expect.objectContaining({ key: "cosigner-unavailable" }),
    );

    cosigner.fault = null;
    vi.setSystemTime(Date.now() + 61_000); // the refused pass's retry lease lapses
    await reprocessPayoutWithNonceSafety(submission.id);

    await expectPaidOnce(submission.id);
  });

  it("holds a legacy withdrawal too, rather than refunding it", async () => {
    const user = await createUser({ pendingBalanceUnits: 0n });
    const destination = Keypair.random().publicKey();
    const withdrawal = await prisma.payoutJob.create({
      data: { type: "WITHDRAWAL", userId: user.id, amountUnits: REWARD, destinationAddress: destination },
    });
    cosigner.fault = async () => Promise.reject(new TypeError("fetch failed"));

    await workerTick();

    expect(horizon.paymentsTo(destination)).toHaveLength(0);
    const held = await prisma.payoutJob.findUniqueOrThrow({ where: { id: withdrawal.id } });
    expect(held).toMatchObject({ status: "queued", retryCount: 0, txHash: null });
    expectHeldUntilLater(held.notBefore);
    expect(
      await prisma.userBalanceLedger.count({ where: { userId: user.id, type: "REVERSAL" } }),
    ).toBe(0);

    cosigner.fault = null;
    await prisma.payoutJob.update({ where: { id: withdrawal.id }, data: { notBefore: new Date(0) } });
    await workerTick();

    const payments = horizon.paymentsTo(destination);
    expect(payments).toHaveLength(1);
    expect(signedByBothSigners(payments[0].envelope)).toBe(true);
    expect(await prisma.payoutJob.findUniqueOrThrow({ where: { id: withdrawal.id } })).toMatchObject({
      txHash: payments[0].hash,
    });
  });
});

describe("daily cap exceeded (#46, #47)", () => {
  it("the payout service refuses before asking the co-signer, alerts, and resumes once there is room", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    process.env.DAILY_PAYOUT_CAP_UNITS = String(REWARD);
    await priorSpend(REWARD);
    const submission = await enqueuePayout();

    await workerTick();

    // The co-signer would have signed (its own cap has room); the service alone refused.
    expect(cosigner.calls).toBe(0);
    expect(horizon.presented).toHaveLength(0);
    const row = await expectUnpaid(submission.id);
    expect(row).toMatchObject({ payoutStatus: "pending", retryCount: 0 });
    const job = await jobRow(submission.id);
    expect(job.status).toBe("failed");
    expect(job.lastError).toContain("payout cap exceeded");
    expect(await refunds(submission.id)).toBe(0);
    await vi.waitFor(() =>
      expect(vi.mocked(sendDedupedDiscordAlert)).toHaveBeenCalledWith(
        expect.objectContaining({ key: "payout-cap", severity: "PAGE" }),
      ),
    );

    // The retry path meets the same refusal and spends nothing on it.
    await reprocessPayoutWithNonceSafety(submission.id);
    expect(horizon.presented).toHaveLength(0);
    expect(await submissionRow(submission.id)).toMatchObject({ payoutStatus: "pending", retryCount: 0 });

    // Room returns (tomorrow's window, or a raised cap), and the retry lease the
    // refused pass took has lapsed: the same row pays once.
    process.env.DAILY_PAYOUT_CAP_UNITS = String(REWARD * 2n);
    vi.setSystemTime(Date.now() + 61_000);
    await reprocessPayoutWithNonceSafety(submission.id);
    await expectPaidOnce(submission.id);
  });

  it("the co-signer refuses on its own cap even with the service's cap lifted, and alerts", async () => {
    process.env.DAILY_PAYOUT_CAP_UNITS = "0"; // the payout service's cap is off entirely
    cosigner.deps.capUnits = REWARD;
    await priorSpend(REWARD);
    const submission = await enqueuePayout();

    await workerTick();

    expect(cosigner.signed).toBe(0);
    expect(cosigner.refusals).toEqual([expect.stringContaining("daily cap reached")]);
    // No second signature, so nothing was built past the payment stage or presented.
    expect(horizon.presented).toHaveLength(0);
    expect(await attempts(submission.id)).toHaveLength(0);
    // Deferred to the retry path exactly as the service's own cap defers it.
    const row = await expectUnpaid(submission.id);
    expect(row).toMatchObject({ payoutStatus: "pending", retryCount: 0 });
    const job = await jobRow(submission.id);
    expect(job.status).toBe("failed");
    expect(job.lastError).toContain("payout cap exceeded");
    expect(job.lastError).toContain("daily cap reached");
    expect(await refunds(submission.id)).toBe(0);
    expect(vi.mocked(sendDedupedDiscordAlert)).toHaveBeenCalledWith(
      expect.objectContaining({ key: "cosigner-cap", severity: "PAGE" }),
    );
  });

  it("a co-signer cap refusal spends no retry on the retry path, and pays once its window has room", async () => {
    // Before #47, three worker passes failed and refunded it, with no alert (#46).
    vi.useFakeTimers({ toFake: ["Date"] });
    cosigner.deps.capUnits = REWARD;
    await priorSpend(REWARD);
    const submission = await enqueuePayout();
    await workerTick();

    for (let pass = 0; pass < 3; pass++) {
      vi.setSystemTime(Date.now() + 61_000);
      await reprocessPayoutWithNonceSafety(submission.id);
    }

    expect(horizon.presented).toHaveLength(0);
    expect(await expectUnpaid(submission.id)).toMatchObject({ payoutStatus: "pending", retryCount: 0 });
    expect(await refunds(submission.id)).toBe(0);

    cosigner.deps.capUnits = REWARD * 2n; // the co-signer's next UTC day, or a raised cap
    vi.setSystemTime(Date.now() + 61_000);
    await reprocessPayoutWithNonceSafety(submission.id);

    await expectPaidOnce(submission.id);
  });
});

describe("Horizon timeout (#46)", () => {
  it("resolves a lost response by the envelope's hash: it landed, so it is recorded, not resent", async () => {
    const submission = await enqueuePayout();
    horizon.onSubmit = async (apply) => {
      apply(); // Horizon accepted it...
      throw horizonTimeout(); // ...and the response never arrived
    };

    await workerTick();

    const { hash } = await expectPaidOnce(submission.id);
    expect(horizon.presented).toHaveLength(1);
    expect(cosigner.signed).toBe(2); // one envelope, two stages: nothing was rebuilt
    expect(await jobRow(submission.id)).toMatchObject({ status: "done", txHash: hash, retryCount: 0 });
  });

  it("rebuilds only after Horizon proves the envelope expired unincluded", async () => {
    const submission = await enqueuePayout();
    horizon.onSubmit = async () => {
      throw horizonTimeout(); // never applied
    };
    // The network's clock is past the envelope's maxTime, so absence can become proof.
    horizon.ledgerCloseMs = () => Date.now() + 60 * 60_000;

    await workerTick();

    await expectUnpaid(submission.id);
    const [dead] = await attempts(submission.id);
    expect(dead).toMatchObject({ status: "void", outcome: "expired unincluded" });
    expect(await jobRow(submission.id)).toMatchObject({ status: "queued", retryCount: 1 });

    horizon.onSubmit = null;
    await workerTick();

    await expectPaidOnce(submission.id);
    expect(horizon.presented).toHaveLength(2);
  });

  it("holds an unprovable outcome for reconciliation, never resends it, and settles it from the chain", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const submission = await enqueuePayout();
    horizon.onSubmit = async (apply) => {
      apply(); // it did land...
      horizon.unreachable = true; // ...but Horizon goes dark before anyone can see that
      vi.setSystemTime(Date.now() + 10 * 60_000); // and stays dark past the resolve deadline
      throw horizonTimeout();
    };

    await workerTick();

    // Unknown, so: not paid in the ledger, not refunded, not retryable, paged.
    const row = await submissionRow(submission.id);
    expect(row).toMatchObject({ payoutStatus: "failed", payoutTxHash: null, retryCount: SUBMISSION_RETRY_BUDGET });
    expect(row.payoutError).toContain("needs manual reconciliation (ambiguous_submit)");
    expect(await refunds(submission.id)).toBe(0);
    const [open] = await attempts(submission.id);
    expect(open.status).toBe("open");
    expect(horizon.landed.has(open.envelopeHash)).toBe(true);
    expect(vi.mocked(Sentry.captureMessage)).toHaveBeenCalledWith(
      expect.stringContaining("needs manual reconciliation"),
      { level: "error" },
    );

    // No blind resubmit: even a direct retry sends nothing while the fate is unknown.
    await expect(reprocessPayoutWithNonceSafety(submission.id)).rejects.toMatchObject({
      code: "attempt_unsettled",
    });
    expect(horizon.presented).toHaveLength(1);

    // Horizon returns after the envelope's bounds have passed.
    horizon.unreachable = false;
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await prisma.payoutAttempt.updateMany({
      where: { submissionId: submission.id },
      data: { expiresAt: new Date(Date.now() - 60 * 60_000) },
    });

    expect(await reviveStrandedAttempts()).toEqual({ [submission.id]: "revived" });
    await reprocessPayoutWithNonceSafety(submission.id);

    // Settled from on-chain proof: the envelope that landed is the one recorded.
    const { hash } = await expectPaidOnce(submission.id);
    expect(hash).toBe(open.envelopeHash);
    expect(horizon.presented).toHaveLength(1);
  });
});
