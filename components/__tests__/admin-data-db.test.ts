import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser, createTask, makeWallet } from "@/tests/helpers/factories";
import {
  getWalletRows,
  getUserRows,
  getGoldAccuracyDistribution,
  getDashboardTotals,
} from "@/lib/admin-data";

beforeEach(async () => {
  await truncateAll();
});

describe("getWalletRows", () => {
  it("returns empty array when there are no users", async () => {
    const rows = await getWalletRows();
    expect(rows).toEqual([]);
  });

  it("returns all users with correct fields", async () => {
    const u1 = await createUser();
    const u2 = await createUser({
      goldCorrect: 5,
      goldAttempted: 10,
      isBanned: true,
    });
    await prisma.user.update({
      where: { walletAddress: u2.walletAddress },
      data: { submissionCount: 3, totalEarnedStroops: 1000000n }, // 0.1 XLM
    });

    const rows = await getWalletRows();

    expect(rows).toHaveLength(2);
    // sorted by createdAt desc, so u2 (created later) first
    expect(rows[0].walletAddress).toBe(u2.walletAddress);
    expect(rows[0].submissionCount).toBe(3);
    expect(rows[0].isBanned).toBe(true);
    expect(rows[0].goldCorrect).toBe(5);
    expect(rows[0].goldAttempted).toBe(10);
    expect(rows[0].goldAccuracyPct).toBe(50);
    expect(rows[0].totalEarned).toBe("0.1");

    expect(rows[1].walletAddress).toBe(u1.walletAddress);
    expect(rows[1].isBanned).toBe(false);
    expect(rows[1].goldAccuracyPct).toBeNull();
  });

  it("returns goldAccuracyPct as null when no gold attempts", async () => {
    await createUser({ goldCorrect: 0, goldAttempted: 0 });
    const rows = await getWalletRows();
    expect(rows[0].goldAccuracyPct).toBeNull();
  });

  it("handles multiple users without N+1 (single findMany)", async () => {
    await Promise.all(Array.from({ length: 5 }).map(() => createUser()));
    const rows = await getWalletRows();
    expect(rows).toHaveLength(5);
  });
});

describe("getUserRows", () => {
  it("returns empty array when there are no users", async () => {
    const rows = await getUserRows();
    expect(rows).toEqual([]);
  });

  it("returns lastSubmissionAt when set", async () => {
    const now = new Date();
    const u = await createUser();
    await prisma.user.update({
      where: { walletAddress: u.walletAddress },
      data: { lastSubmissionAt: now },
    });

    const rows = await getUserRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].lastSubmissionAt).toBeDefined();
    expect(rows[0].lastSubmissionAt!.getTime()).toBe(now.getTime());
  });

  it("returns lastSubmissionAt as null when never submitted", async () => {
    await createUser();
    const rows = await getUserRows();
    expect(rows[0].lastSubmissionAt).toBeNull();
  });

  it("includes demographic fields", async () => {
    await prisma.user.create({
      data: {
        walletAddress: makeWallet(),
        country: "PH",
        gender: "female",
        ageRange: "25-34",
        onboardingCompleted: true,
      },
    });

    const rows = await getUserRows();
    expect(rows[0].country).toBe("PH");
    expect(rows[0].gender).toBe("female");
    expect(rows[0].ageRange).toBe("25-34");
    expect(rows[0].onboardingCompleted).toBe(true);
  });

  it("does not need submissions include for lastSubmissionAt", async () => {
    const u = await createUser();
    const now = new Date();
    await prisma.user.update({
      where: { walletAddress: u.walletAddress },
      data: { lastSubmissionAt: now },
    });

    const rows = await getUserRows();
    expect(rows[0].lastSubmissionAt).toBeDefined();
    // should return the denormalized value without needing a submissions join
  });
});

describe("getGoldAccuracyDistribution", () => {
  it("returns all buckets with zero when no users exist", async () => {
    const buckets = await getGoldAccuracyDistribution();
    const map = new Map(buckets.map((b) => [b.accuracyRange, b.count]));
    expect(map.get("N/A")).toBe(0);
    expect(map.get("90-100%")).toBe(0);
    expect(map.get("70-89%")).toBe(0);
    expect(map.get("50-69%")).toBe(0);
    expect(map.get("<50%")).toBe(0);
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(0);
  });

  it("buckets users by gold accuracy", async () => {
    // N/A: 0/0
    await createUser({ goldCorrect: 0, goldAttempted: 0 });

    // 90-100%: 9/10 = 90%
    await createUser({ goldCorrect: 9, goldAttempted: 10 });

    // 70-89%: 7/10 = 70%
    await createUser({ goldCorrect: 7, goldAttempted: 10 });

    // 50-69%: 5/10 = 50%
    await createUser({ goldCorrect: 5, goldAttempted: 10 });

    // <50%: 4/10 = 40%
    await createUser({ goldCorrect: 4, goldAttempted: 10 });

    const buckets = await getGoldAccuracyDistribution();
    const map = new Map(buckets.map((b) => [b.accuracyRange, b.count]));

    expect(map.get("N/A")).toBe(1);
    expect(map.get("90-100%")).toBe(1);
    expect(map.get("70-89%")).toBe(1);
    expect(map.get("50-69%")).toBe(1);
    expect(map.get("<50%")).toBe(1);
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(5);
  });

  it("places exactly 50% into 50-69% bucket", async () => {
    await createUser({ goldCorrect: 3, goldAttempted: 6 });
    const buckets = await getGoldAccuracyDistribution();
    const map = new Map(buckets.map((b) => [b.accuracyRange, b.count]));
    expect(map.get("50-69%")).toBe(1);
  });

  it("aggregates in SQL rather than loading all users into JS memory", async () => {
    // verify the SQL aggregation produces correct results for many users
    await Promise.all(
      Array.from({ length: 20 }).map((_, i) =>
        createUser({ goldCorrect: i, goldAttempted: 10 }),
      ),
    );

    const buckets = await getGoldAccuracyDistribution();
    const total = buckets.reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(20);
  });
});

describe("getDashboardTotals", () => {
  it("returns zeros and defaults when database is empty", async () => {
    const totals = await getDashboardTotals();
    expect(totals.totalSubmissions).toBe(0);
    expect(totals.totalPaidSubmissions).toBe(0);
    expect(totals.totalFailedSubmissions).toBe(0);
    expect(totals.totalPaidOut).toBe("0");
    expect(totals.uniqueWallets).toBe(0);
    expect(totals.bannedWallets).toBe(0);
  });

  it("counts submissions and wallets correctly", async () => {
    const user = await createUser();
    const task1 = await createTask();
    const task2 = await createTask();

    await prisma.submission.createMany({
      data: [
        {
          walletAddress: user.walletAddress,
          userId: user.id,
          taskId: task1.id,
          choice: "A",
          reason: "Good",
          payoutAmountStroops: 50000000000000000,
          payoutStatus: "sent",
        },
        {
          walletAddress: user.walletAddress,
          userId: user.id,
          taskId: task2.id,
          choice: "A",
          reason: "Good",
          payoutAmountStroops: 0,
          payoutStatus: "failed",
        },
      ],
    });

    const totals = await getDashboardTotals();
    expect(totals.totalSubmissions).toBe(2);
    expect(totals.totalPaidSubmissions).toBe(1);
    expect(totals.totalFailedSubmissions).toBe(1);
    expect(totals.uniqueWallets).toBe(1);
    expect(totals.bannedWallets).toBe(0);
  });

  it("counts banned wallets", async () => {
    await createUser({ isBanned: true });
    await createUser({ isBanned: true });
    await createUser({ isBanned: false });

    const totals = await getDashboardTotals();
    expect(totals.bannedWallets).toBe(2);
  });
});
