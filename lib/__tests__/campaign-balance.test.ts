import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createCampaign, createCampaignBalance } from "@/tests/helpers/factories";
import {
  checkAndDebit,
  creditBalance,
  getBalanceSummary,
  InsufficientBalanceError,
  getPlatformFeeUnits,
} from "@/lib/campaign-balance";

const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  await truncateAll();
  process.env = { ...ORIGINAL_ENV, PLATFORM_FEE_UNITS: "1500000" };
});

// ── getPlatformFeeUnits ──────────────────────────────────────────────────────────

describe("getPlatformFeeUnits", () => {
  it("parses env var as BigInt", () => {
    process.env.PLATFORM_FEE_UNITS = "1500000";
    expect(getPlatformFeeUnits()).toBe(1500000n);
  });

  it("throws when env var is missing", () => {
    delete process.env.PLATFORM_FEE_UNITS;
    expect(() => getPlatformFeeUnits()).toThrow("PLATFORM_FEE_UNITS");
  });

  it("throws when env var is not a valid integer string", () => {
    process.env.PLATFORM_FEE_UNITS = "not-a-number";
    expect(() => getPlatformFeeUnits()).toThrow("PLATFORM_FEE_UNITS");
  });
});

// ── creditBalance ──────────────────────────────────────────────────────────────

describe("creditBalance", () => {
  it("creates a CampaignBalance row and DEPOSIT ledger entry on first credit", async () => {
    const campaign = await createCampaign();

    const newBalance = await creditBalance(campaign.id, 10000000n, "initial top-up");

    expect(newBalance).toBe(10000000n);

    const balance = await prisma.campaignBalance.findUnique({ where: { campaignId: campaign.id } });
    expect(balance?.balanceUnits).toBe(10000000n);

    const ledger = await prisma.balanceLedger.findMany({ where: { campaignId: campaign.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].type).toBe("DEPOSIT");
    expect(ledger[0].amountUnits).toBe(10000000n);
    expect(ledger[0].note).toBe("initial top-up");
  });

  it("adds to existing balance on subsequent credit", async () => {
    const campaign = await createCampaign();
    await createCampaignBalance(campaign.id, 5000000n);

    const newBalance = await creditBalance(campaign.id, 5000000n);

    expect(newBalance).toBe(10000000n);
  });

  it("creates DEPOSIT ledger without note when omitted", async () => {
    const campaign = await createCampaign();
    await creditBalance(campaign.id, 100n);

    const ledger = await prisma.balanceLedger.findMany({ where: { campaignId: campaign.id } });
    expect(ledger[0].note).toBeNull();
  });
});

// ── checkAndDebit ──────────────────────────────────────────────────────────────

describe("checkAndDebit", () => {
  it("debits labeler reward + platform fee from balance", async () => {
    const campaign = await createCampaign({ rewardUnits: 500000n });
    await createCampaignBalance(campaign.id, 10000000n);

    await checkAndDebit(campaign.id, 500000n, "sub-001");

    const balance = await prisma.campaignBalance.findUnique({ where: { campaignId: campaign.id } });
    // 1 XLM - 0.05 (reward) - 0.15 (fee) = 0.8 XLM = 8000000 units
    expect(balance?.balanceUnits).toBe(8000000n);
  });

  it("writes DEBIT_REWARD and DEBIT_FEE ledger entries", async () => {
    const campaign = await createCampaign({ rewardUnits: 500000n });
    await createCampaignBalance(campaign.id, 10000000n);

    await checkAndDebit(campaign.id, 500000n, "sub-001");

    const ledger = await prisma.balanceLedger.findMany({
      where: { campaignId: campaign.id },
      orderBy: { type: "asc" },
    });
    expect(ledger).toHaveLength(2);

    const reward = ledger.find((l) => l.type === "DEBIT_REWARD")!;
    expect(reward.amountUnits).toBe(500000n);
    expect(reward.submissionId).toBe("sub-001");

    const fee = ledger.find((l) => l.type === "DEBIT_FEE")!;
    expect(fee.amountUnits).toBe(1500000n);
    expect(fee.submissionId).toBe("sub-001");
  });

  it("throws InsufficientBalanceError when balance is too low", async () => {
    const campaign = await createCampaign();
    await createCampaignBalance(campaign.id, 10n); // tiny balance

    await expect(
      checkAndDebit(campaign.id, 500000n, "sub-002")
    ).rejects.toThrow(InsufficientBalanceError);
  });

  it("throws InsufficientBalanceError when campaign has no balance record", async () => {
    const campaign = await createCampaign();
    // no createCampaignBalance call

    await expect(
      checkAndDebit(campaign.id, 500000n, "sub-003")
    ).rejects.toThrow(InsufficientBalanceError);
  });

  it("succeeds and leaves 0 balance when balance exactly equals required", async () => {
    const campaign = await createCampaign();
    const required = 500000n + 1500000n; // reward + fee
    await createCampaignBalance(campaign.id, required);

    await expect(
      checkAndDebit(campaign.id, 500000n, "sub-004")
    ).resolves.not.toThrow();

    const balance = await prisma.campaignBalance.findUnique({ where: { campaignId: campaign.id } });
    expect(balance?.balanceUnits).toBe(0n);
  });
});

// ── getBalanceSummary ──────────────────────────────────────────────────────────

describe("getBalanceSummary", () => {
  it("returns balanceUnits and estimated submissions remaining", async () => {
    const campaign = await createCampaign({ rewardUnits: 500000n });
    await createCampaignBalance(campaign.id, 4000000n);

    // PLATFORM_FEE_UNITS=1500000, rewardUnits=500000
    // cost per submission = 2000000 (0.2 XLM)
    // balance = 4000000 (0.4 XLM) → 2 submissions
    const summary = await getBalanceSummary(campaign.id, 500000n);

    expect(summary.balanceUnits).toBe(4000000n);
    expect(summary.estimatedSubmissionsRemaining).toBe(2);
  });

  it("returns 0 remaining when no balance row exists", async () => {
    const campaign = await createCampaign();
    const summary = await getBalanceSummary(campaign.id, 500000n);

    expect(summary.balanceUnits).toBe(0n);
    expect(summary.estimatedSubmissionsRemaining).toBe(0);
  });

  it("returns null estimate when PLATFORM_FEE_UNITS is not set", async () => {
    delete process.env.PLATFORM_FEE_UNITS;
    const campaign = await createCampaign({ rewardUnits: 500000n });
    await createCampaignBalance(campaign.id, 4000000n);

    const summary = await getBalanceSummary(campaign.id, 500000n);

    expect(summary.balanceUnits).toBe(4000000n);
    expect(summary.estimatedSubmissionsRemaining).toBeNull();
  });

  it("floors fractional submissions", async () => {
    const campaign = await createCampaign({ rewardUnits: 500000n });
    // 0.3 XLM balance / 0.2 XLM per sub = 1.5 → floor to 1
    await createCampaignBalance(campaign.id, 3000000n);

    const summary = await getBalanceSummary(campaign.id, 500000n);
    expect(summary.estimatedSubmissionsRemaining).toBe(1);
  });
});
