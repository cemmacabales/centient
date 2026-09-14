import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, truncateAll } from "@/tests/helpers/db";

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("@/lib/stellar/balance", () => ({
  getWalletHealth: vi.fn(async () => ({ address: "—", usdcBalance: "—" })),
}));

import { getHealthSnapshot } from "@/lib/admin-data";

const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  await truncateAll();
  process.env = { ...ORIGINAL_ENV, DAILY_PAYOUT_CAP_UNITS: "2000000000" };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("admin health snapshot daily cap accounting", () => {
  it("counts broadcast withdrawal jobs that have no submission row", async () => {
    await prisma.payoutJob.create({
      data: {
        type: "WITHDRAWAL",
        status: "done",
        amountUnits: 1_600_000_000n,
        txHash: "withdrawal-only-broadcast",
        broadcastAt: new Date(),
      },
    });

    const snapshot = await getHealthSnapshot();

    expect(snapshot.dailyPayoutCapUnits).toBe("2000000000");
    expect(snapshot.dailyPayoutSpentUnits).toBe("1600000000");
    expect(snapshot.dailyPayoutRemainingUnits).toBe("400000000");
    expect(snapshot.dailyPayoutSpentPct).toBe(80);
  });

  it("ignores submission rows that never produced a broadcast payout job", async () => {
    const user = await prisma.user.create({
      data: { walletAddress: "GCAPACCOUNTINGUSER000000000000000000000000000000000000" },
    });
    const task = await prisma.task.create({
      data: { prompt: "cap accounting", responseA: "a", responseB: "b" },
    });
    await prisma.submission.create({
      data: {
        userId: user.id,
        taskId: task.id,
        choice: "A",
        reason: "cap accounting",
        payoutStatus: "sent",
        payoutAmountUnits: 900_000_000n,
      },
    });

    const snapshot = await getHealthSnapshot();

    expect(snapshot.dailyPayoutSpentUnits).toBe("0");
    expect(snapshot.dailyPayoutRemainingUnits).toBe("2000000000");
    expect(snapshot.dailyPayoutSpentPct).toBe(0);
  });
});
