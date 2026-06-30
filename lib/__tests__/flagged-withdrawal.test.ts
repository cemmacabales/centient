import { describe, it, expect, beforeEach } from "vitest";
import {
  severityForReason,
  severityRank,
  recordFlaggedWithdrawal,
} from "@/lib/flagged-withdrawal";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser } from "@/tests/helpers/factories";

beforeEach(async () => {
  await truncateAll();
});

describe("severity classification", () => {
  it("maps each reason to a severity", () => {
    expect(severityForReason("BANNED_IDENTITY")).toBe("CRITICAL");
    expect(severityForReason("SHARED_WALLET")).toBe("HIGH");
    expect(severityForReason("INELIGIBLE")).toBe("LOW");
  });

  it("ranks critical above high above low", () => {
    expect(severityRank("BANNED_IDENTITY")).toBeLessThan(severityRank("SHARED_WALLET"));
    expect(severityRank("SHARED_WALLET")).toBeLessThan(severityRank("INELIGIBLE"));
  });
});

describe("recordFlaggedWithdrawal", () => {
  it("creates a PENDING flag", async () => {
    const user = await createUser({ email: "a@example.com" });
    await recordFlaggedWithdrawal({
      userId: user.id,
      walletAddress: user.walletAddress,
      reason: "SHARED_WALLET",
      detail: { accountCount: 4 },
      balanceUnits: 1000n,
    });

    const flags = await prisma.flaggedWithdrawal.findMany({ where: { userId: user.id } });
    expect(flags).toHaveLength(1);
    expect(flags[0].status).toBe("PENDING");
    expect(flags[0].balanceUnits).toBe(1000n);
  });

  it("refreshes an existing PENDING flag of the same reason instead of duplicating", async () => {
    const user = await createUser({ email: "b@example.com" });
    const params = {
      userId: user.id,
      walletAddress: user.walletAddress,
      reason: "SHARED_WALLET" as const,
      balanceUnits: 1000n,
    };
    await recordFlaggedWithdrawal({ ...params, detail: { accountCount: 4 } });
    await recordFlaggedWithdrawal({ ...params, detail: { accountCount: 5 }, balanceUnits: 2000n });

    const flags = await prisma.flaggedWithdrawal.findMany({ where: { userId: user.id } });
    expect(flags).toHaveLength(1);
    expect(flags[0].balanceUnits).toBe(2000n);
    expect((flags[0].detail as Record<string, unknown>).accountCount).toBe(5);
  });

  it("keeps separate flags for different reasons", async () => {
    const user = await createUser({ email: "c@example.com" });
    await recordFlaggedWithdrawal({
      userId: user.id,
      walletAddress: user.walletAddress,
      reason: "SHARED_WALLET",
      balanceUnits: 1000n,
    });
    await recordFlaggedWithdrawal({
      userId: user.id,
      walletAddress: user.walletAddress,
      reason: "INELIGIBLE",
      balanceUnits: 1000n,
    });

    const flags = await prisma.flaggedWithdrawal.findMany({ where: { userId: user.id } });
    expect(flags).toHaveLength(2);
  });

  it("allows a new PENDING flag when a resolved flag for the same reason already exists", async () => {
    const user = await createUser({ email: "d@example.com" });
    await recordFlaggedWithdrawal({
      userId: user.id,
      walletAddress: user.walletAddress,
      reason: "SHARED_WALLET",
      balanceUnits: 1000n,
    });
    await prisma.flaggedWithdrawal.updateMany({
      where: { userId: user.id },
      data: { status: "REJECTED" },
    });

    await recordFlaggedWithdrawal({
      userId: user.id,
      walletAddress: user.walletAddress,
      reason: "SHARED_WALLET",
      balanceUnits: 2000n,
    });

    const flags = await prisma.flaggedWithdrawal.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });
    expect(flags).toHaveLength(2);
    expect(flags[0].status).toBe("REJECTED");
    expect(flags[1].status).toBe("PENDING");
    expect(flags[1].balanceUnits).toBe(2000n);
  });
});
