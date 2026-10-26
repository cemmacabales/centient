// #202 review — the retest backfill migration marks, for each labeler with a
// ban, the first 3 quality checks after their latest ban as retest, and touches
// nothing else.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createGoldTask, createUser, VALID_REASON } from "@/tests/helpers/factories";

const SQL = readFileSync(join(process.cwd(), "prisma/migrations/20261014130000_retest_backfill/migration.sql"), "utf8");
const BAN = new Date("2026-09-22T09:09:39Z");
const minutes = (n: number) => new Date(BAN.getTime() + n * 60_000);

beforeEach(async () => {
  await truncateAll();
});

async function check(userId: string, createdAt: Date, goldPassed = true) {
  const task = await createGoldTask("A");
  return prisma.submission.create({
    data: {
      userId,
      taskId: task.id,
      choice: goldPassed ? "A" : "B",
      reason: VALID_REASON,
      isGoldCheck: true,
      goldPassed,
      payoutAmountUnits: 0n,
      payoutStatus: "skipped",
      createdAt,
    },
  });
}

const retestOf = async (id: string) => (await prisma.submission.findUniqueOrThrow({ where: { id } })).retest;

describe("20261014130000_retest_backfill", () => {
  it("marks the first 3 checks after the latest ban, and nothing before or after them", async () => {
    const banned = (await createUser({ banCount: 1, lastBanAt: BAN })).id;
    const before = await check(banned, minutes(-10), false);
    const retest = [await check(banned, minutes(60 * 24 + 1)), await check(banned, minutes(60 * 24 + 2)), await check(banned, minutes(60 * 24 + 3), false)];
    const later = await check(banned, minutes(60 * 24 * 3));
    const clean = (await createUser()).id;
    const other = await check(clean, minutes(60 * 24 + 1));

    await prisma.$executeRawUnsafe(SQL);

    expect(await Promise.all(retest.map((s) => retestOf(s.id)))).toEqual([true, true, true]);
    expect(await retestOf(before.id)).toBe(false);
    expect(await retestOf(later.id)).toBe(false);
    expect(await retestOf(other.id)).toBe(false);

    // Running it again changes nothing.
    await prisma.$executeRawUnsafe(SQL);
    expect(await prisma.submission.count({ where: { retest: true } })).toBe(3);
  });
});
