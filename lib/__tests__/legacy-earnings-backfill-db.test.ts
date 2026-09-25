// #39 (ADR-0007, D2) — "Total earned" now reads `totalEarnedUnits`, which only an
// on-chain payout ever raised, and `submissionCount` was likewise raised only by
// a payer. Answers accrued under accumulate-then-withdraw were credited to
// `pendingBalanceUnits` alone, so without this backfill every contributor from
// that period would see their earnings and answer count drop. The migration adds
// each user's accrued sum and count once, records it in `legacy_earnings_backfill`, and is
// a no-op if it ever runs again.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser, createTask, VALID_REASON } from "@/tests/helpers/factories";

const MIGRATION = path.resolve(
  __dirname,
  "../../prisma/migrations/20260921210000_legacy_earnings_backfill/migration.sql",
);

/** Run the migration's statements in order, as `prisma migrate deploy` would. */
async function runMigration() {
  const statements = readFileSync(MIGRATION, "utf8")
    .split(/;\s*\n/)
    .map((chunk) => chunk.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
  for (const statement of statements) await prisma.$executeRawUnsafe(statement);
}

async function userEarning(totalEarnedUnits: bigint, pendingBalanceUnits = 0n, submissionCount = 0) {
  const user = await createUser({ pendingBalanceUnits });
  return prisma.user.update({ where: { id: user.id }, data: { totalEarnedUnits, submissionCount } });
}

async function submission(userId: string, payoutStatus: string, payoutAmountUnits: bigint) {
  const task = await createTask();
  return prisma.submission.create({
    data: { userId, taskId: task.id, choice: "A", reason: VALID_REASON, payoutStatus, payoutAmountUnits },
  });
}

beforeEach(async () => {
  await prisma.legacyEarningsBackfill.deleteMany();
  await truncateAll();
});

describe("legacy earnings backfill migration (#39)", () => {
  it("adds each user's accrued answers to totalEarnedUnits and records what it added", async () => {
    const legacy = await userEarning(5_000_000n, 2_000_000n, 1);
    await submission(legacy.id, "accrued", 2_000_000n);
    await submission(legacy.id, "accrued", 3_000_000n);
    // Already counted in totalEarnedUnits by the payer that sent it.
    await submission(legacy.id, "confirmed", 5_000_000n);
    const instantOnly = await userEarning(2_500_000n, 0n, 1);
    await submission(instantOnly.id, "sent", 2_500_000n);

    await runMigration();

    const after = await prisma.user.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(after.totalEarnedUnits).toBe(10_000_000n);
    // Accrual never counted the answer either: the one paid answer, plus two accrued.
    expect(after.submissionCount).toBe(3);
    // The owed balance is a separate liability; the backfill never touches it.
    expect(after.pendingBalanceUnits).toBe(2_000_000n);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: instantOnly.id } })).toMatchObject({
      totalEarnedUnits: 2_500_000n,
      submissionCount: 1,
    });
    expect(await prisma.legacyEarningsBackfill.findMany()).toMatchObject([
      { userId: legacy.id, amountUnits: 5_000_000n, accruedCount: 2 },
    ]);
  });

  it("adds nothing the second time it runs", async () => {
    const legacy = await userEarning(0n);
    await submission(legacy.id, "accrued", 4_000_000n);

    await runMigration();
    await runMigration();

    expect(await prisma.user.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({
      totalEarnedUnits: 4_000_000n,
      submissionCount: 1,
    });
    expect(await prisma.legacyEarningsBackfill.count()).toBe(1);
  });
});
