import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createCampaign, createCampaignBalance } from "@/tests/helpers/factories";
import {
  checkAndDebit,
  creditBalance,
  getBalanceSummary,
  InsufficientBalanceError,
  getPlatformFeeWei,
} from "@/lib/campaign-balance";

const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  await truncateAll();
  process.env = { ...ORIGINAL_ENV, PLATFORM_FEE_WEI: "150000000000000000" };
});

// ── getPlatformFeeWei ──────────────────────────────────────────────────────────

describe("getPlatformFeeWei", () => {
  it("parses env var as BigInt", () => {
    process.env.PLATFORM_FEE_WEI = "150000000000000000";
    expect(getPlatformFeeWei()).toBe(150000000000000000n);
  });

  it("throws when env var is missing", () => {
    delete process.env.PLATFORM_FEE_WEI;
    expect(() => getPlatformFeeWei()).toThrow("PLATFORM_FEE_WEI");
  });

  it("throws when env var is not a valid integer string", () => {
    process.env.PLATFORM_FEE_WEI = "not-a-number";
    expect(() => getPlatformFeeWei()).toThrow("PLATFORM_FEE_WEI");
  });
});

// ── creditBalance ──────────────────────────────────────────────────────────────

describe("creditBalance", () => {
  it("creates a CampaignBalance row and DEPOSIT ledger entry on first credit", async () => {
    const campaign = await createCampaign();

    const newBalance = await creditBalance(campaign.id, 1000000000000000000n, "initial top-up");

    expect(newBalance).toBe(1000000000000000000n);

    const balance = await prisma.campaignBalance.findUnique({ where: { campaignId: campaign.id } });
    expect(balance?.balanceWei).toBe(1000000000000000000n);

    const ledger = await prisma.balanceLedger.findMany({ where: { campaignId: campaign.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].type).toBe("DEPOSIT");
    expect(ledger[0].amountWei).toBe(1000000000000000000n);
    expect(ledger[0].note).toBe("initial top-up");
  });

  it("adds to existing balance on subsequent credit", async () => {
    const campaign = await createCampaign();
    await createCampaignBalance(campaign.id, 500000000000000000n);

    const newBalance = await creditBalance(campaign.id, 500000000000000000n);

    expect(newBalance).toBe(1000000000000000000n);
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
    const campaign = await createCampaign({ rewardWei: 50000000000000000n });
    await createCampaignBalance(campaign.id, 1000000000000000000n);

    await checkAndDebit(campaign.id, 50000000000000000n, "sub-001");

    const balance = await prisma.campaignBalance.findUnique({ where: { campaignId: campaign.id } });
    // 1e18 - 0.05e18 (reward) - 0.15e18 (fee) = 0.8e18
    expect(balance?.balanceWei).toBe(800000000000000000n);
  });

  it("writes DEBIT_REWARD and DEBIT_FEE ledger entries", async () => {
    const campaign = await createCampaign({ rewardWei: 50000000000000000n });
    await createCampaignBalance(campaign.id, 1000000000000000000n);

    await checkAndDebit(campaign.id, 50000000000000000n, "sub-001");

    const ledger = await prisma.balanceLedger.findMany({
      where: { campaignId: campaign.id },
      orderBy: { type: "asc" },
    });
    expect(ledger).toHaveLength(2);

    const reward = ledger.find((l) => l.type === "DEBIT_REWARD")!;
    expect(reward.amountWei).toBe(50000000000000000n);
    expect(reward.submissionId).toBe("sub-001");

    const fee = ledger.find((l) => l.type === "DEBIT_FEE")!;
    expect(fee.amountWei).toBe(150000000000000000n);
    expect(fee.submissionId).toBe("sub-001");
  });

  it("throws InsufficientBalanceError when balance is too low", async () => {
    const campaign = await createCampaign();
    await createCampaignBalance(campaign.id, 10n); // tiny balance

    await expect(
      checkAndDebit(campaign.id, 50000000000000000n, "sub-002")
    ).rejects.toThrow(InsufficientBalanceError);
  });

  it("throws InsufficientBalanceError when campaign has no balance record", async () => {
    const campaign = await createCampaign();
    // no createCampaignBalance call

    await expect(
      checkAndDebit(campaign.id, 50000000000000000n, "sub-003")
    ).rejects.toThrow(InsufficientBalanceError);
  });

  it("succeeds and leaves 0 balance when balance exactly equals required", async () => {
    const campaign = await createCampaign();
    const required = 50000000000000000n + 150000000000000000n; // reward + fee
    await createCampaignBalance(campaign.id, required);

    await expect(
      checkAndDebit(campaign.id, 50000000000000000n, "sub-004")
    ).resolves.not.toThrow();

    const balance = await prisma.campaignBalance.findUnique({ where: { campaignId: campaign.id } });
    expect(balance?.balanceWei).toBe(0n);
  });
});

// ── getBalanceSummary ──────────────────────────────────────────────────────────

describe("getBalanceSummary", () => {
  it("returns balanceWei and estimated submissions remaining", async () => {
    const campaign = await createCampaign({ rewardWei: 50000000000000000n });
    await createCampaignBalance(campaign.id, 400000000000000000n);

    // PLATFORM_FEE_WEI=150000000000000000, rewardWei=50000000000000000
    // cost per submission = 200000000000000000 (0.2 cUSD)
    // balance = 400000000000000000 (0.4 cUSD) → 2 submissions
    const summary = await getBalanceSummary(campaign.id, 50000000000000000n);

    expect(summary.balanceWei).toBe(400000000000000000n);
    expect(summary.estimatedSubmissionsRemaining).toBe(2);
  });

  it("returns 0 remaining when no balance row exists", async () => {
    const campaign = await createCampaign();
    const summary = await getBalanceSummary(campaign.id, 50000000000000000n);

    expect(summary.balanceWei).toBe(0n);
    expect(summary.estimatedSubmissionsRemaining).toBe(0);
  });

  it("returns null estimate when PLATFORM_FEE_WEI is not set", async () => {
    delete process.env.PLATFORM_FEE_WEI;
    const campaign = await createCampaign({ rewardWei: 50000000000000000n });
    await createCampaignBalance(campaign.id, 400000000000000000n);

    const summary = await getBalanceSummary(campaign.id, 50000000000000000n);

    expect(summary.balanceWei).toBe(400000000000000000n);
    expect(summary.estimatedSubmissionsRemaining).toBeNull();
  });

  it("floors fractional submissions", async () => {
    const campaign = await createCampaign({ rewardWei: 50000000000000000n });
    // 0.3 cUSD balance / 0.2 cUSD per sub = 1.5 → floor to 1
    await createCampaignBalance(campaign.id, 300000000000000000n);

    const summary = await getBalanceSummary(campaign.id, 50000000000000000n);
    expect(summary.estimatedSubmissionsRemaining).toBe(1);
  });
});
