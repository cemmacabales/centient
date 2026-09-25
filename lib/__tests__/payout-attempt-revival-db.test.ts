import { Keypair } from "@stellar/stellar-sdk";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// #38 — an unknown payout outcome stays reconcilable.
//
// An `ambiguous_submit` that could not be proven either way leaves a submission
// stranded: `failed`, retry budget spent, no refund, its envelope still open.
// Once the envelope's fate can be proven, the reconciler hands the row back to
// the retry path, and the retry path records the landed payment or builds the
// one replacement. The attempts table, the claim, the refund ledger and the
// retry path run for real; Horizon is a fake chain.

const chain = new Map<string, "confirmed" | "failed">();
let ledgerCloseMs: number | null = null;
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
    getTxStatus: vi.fn(async (hash: string) => chain.get(hash) ?? "not_found"),
    latestLedgerCloseMs: vi.fn(async () => ledgerCloseMs),
  };
});
vi.mock("@/lib/stellar/balance", () => ({ checkAndAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/health-alert", () => ({ sendDedupedDiscordAlert: vi.fn(async () => "sent") }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

import { reviveStrandedAttempts } from "@/lib/payout-attempt-revival";
import { reprocessPayoutWithNonceSafety } from "@/lib/payout-service";
import { creditBalance } from "@/lib/campaign-balance";
import { SUBMISSION_RETRY_BUDGET } from "@/lib/payout-retry-claim";
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
  process.env = { ...ORIGINAL_ENV, DAILY_PAYOUT_CAP_UNITS: "0", PLATFORM_FEE_UNITS: "1500000" };
  chain.clear();
  ledgerCloseMs = Date.now();
  broadcasts = [];
  mockSubmitMultisigPayout.mockImplementation(
    async (_req: unknown, { attempts }: { attempts?: { open(e: { hash: string; expiresAt: Date }): Promise<void> } }) => {
      const hash = `envelope-${broadcasts.length + 1}`;
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

/** What an unprovable `ambiguous_submit` leaves: failed, budget spent, envelope open. */
async function stranded(
  opts: { status?: "failed" | "abandoned"; expiredMsAgo?: number; campaign?: { id: string } } = {},
) {
  const campaign = opts.campaign ?? (await createCampaign({ rewardUnits: AMOUNT }));
  if (!opts.campaign) await createCampaignBalance(campaign.id, 1_000_000_000n);
  const user = await createUser({ walletAddress: Keypair.random().publicKey() });
  const task = await createTask({ campaignId: campaign.id, prompt: `Stranded ${Math.random()}?` });
  const submission = await prisma.submission.create({
    data: {
      userId: user.id,
      walletAddress: user.walletAddress,
      taskId: task.id,
      choice: "A",
      reason: VALID_REASON,
      payoutAmountUnits: AMOUNT,
      payoutStatus: opts.status ?? "failed",
      payoutError: "needs manual reconciliation (ambiguous_submit)",
      retryCount: SUBMISSION_RETRY_BUDGET,
      lastRetriedAt: LONG_AGO(),
      createdAt: LONG_AGO(),
    },
  });
  await prisma.payoutJob.create({ data: { type: "SUBMISSION_PAYOUT", submissionId: submission.id, status: "failed" } });
  const envelopeHash = `stranded-${submission.id}`;
  await prisma.payoutAttempt.create({
    data: {
      submissionId: submission.id,
      envelopeHash,
      expiresAt: new Date(Date.now() - (opts.expiredMsAgo ?? 60_000)),
    },
  });
  return { campaign, submission, envelopeHash };
}

const row = (id: string) => prisma.submission.findUniqueOrThrow({ where: { id } });

describe("reviving a stranded payout (#38)", () => {
  it.each(["failed", "abandoned"] as const)(
    "a %s row whose envelope landed is recorded by the retry path, with nothing sent",
    async (status) => {
      const { submission, envelopeHash } = await stranded({ status });
      chain.set(envelopeHash, "confirmed");

      expect(await reviveStrandedAttempts()).toEqual({ [submission.id]: "revived" });
      await reprocessPayoutWithNonceSafety(submission.id);

      expect(broadcasts).toHaveLength(0);
      expect(await row(submission.id)).toMatchObject({ payoutStatus: "sent", payoutTxHash: envelopeHash });
    },
  );

  it("a row whose envelope is proven never applied gets exactly one replacement", async () => {
    const { submission, envelopeHash } = await stranded();

    expect(await reviveStrandedAttempts()).toEqual({ [submission.id]: "revived" });
    const voided = await prisma.payoutAttempt.findUniqueOrThrow({ where: { envelopeHash } });
    expect(voided).toMatchObject({ status: "void", outcome: "expired unincluded" });
    await reprocessPayoutWithNonceSafety(submission.id);

    expect(broadcasts).toHaveLength(1);
    expect(await row(submission.id)).toMatchObject({ payoutStatus: "sent", payoutTxHash: broadcasts[0] });
  });

  it("leaves a row alone while no ledger has closed past its envelope's time bounds", async () => {
    const { submission } = await stranded();
    ledgerCloseMs = Date.now() - 120_000;

    expect(await reviveStrandedAttempts()).toEqual({ [submission.id]: "waiting" });
    expect(await row(submission.id)).toMatchObject({ payoutStatus: "failed", retryCount: SUBMISSION_RETRY_BUDGET });
  });

  it("never revives a refunded payout", async () => {
    const { campaign, submission } = await stranded();
    await creditBalance(campaign.id, 4_000_000n, "refund", "REFUND", submission.id);

    // Not even selected: a refunded row is excluded from the batch.
    expect(await reviveStrandedAttempts()).toEqual({});
    expect(await row(submission.id)).toMatchObject({ retryCount: SUBMISSION_RETRY_BUDGET });
  });

  it("ignores an open envelope still inside its time bounds, and rows still in the retry path", async () => {
    const { campaign } = await stranded({ expiredMsAgo: -60_000 });
    const inPath = await stranded({ campaign });
    await prisma.submission.update({ where: { id: inPath.submission.id }, data: { retryCount: 1 } });

    expect(await reviveStrandedAttempts()).toEqual({});
  });

  it("is not starved by rows it will never revive (#38 review)", async () => {
    // Refunded rows sort first (oldest envelopes) and fill more than a batch.
    // Selected and skipped every pass, they would hide every row behind them.
    const { campaign } = await stranded({ expiredMsAgo: 3_600_000 });
    await prisma.balanceLedger.create({
      data: { campaignId: campaign.id, type: "REFUND", amountUnits: 1n, note: "refund", submissionId: (await prisma.submission.findFirstOrThrow()).id },
    });
    for (let i = 0; i < 21; i++) {
      const { submission } = await stranded({ campaign, expiredMsAgo: 3_000_000 - i });
      await creditBalance(campaign.id, 1n, "refund", "REFUND", submission.id);
    }
    const noWallet = await stranded({ campaign, expiredMsAgo: 2_000_000 });
    await prisma.submission.update({ where: { id: noWallet.submission.id }, data: { walletAddress: null } });
    const real = await stranded({ campaign, expiredMsAgo: 60_000 });

    const outcome = await reviveStrandedAttempts();

    expect(outcome).toEqual({ [real.submission.id]: "revived" });
  });
});
