// #203 — the weekly board against a real database: ranks match the XP ledger
// for the Manila week, event-code XP and other weeks are left out, the weekly
// quality floor reads only that week's checks, and closing a week awards the
// Top 3 stamp once, however many reads race to close it.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../server-analytics", () => ({ captureStanding: vi.fn(), captureServer: vi.fn() }));

import { prisma, truncateAll } from "@/tests/helpers/db";
import { createGoldTask, createUser, VALID_REASON } from "@/tests/helpers/factories";
import { captureServer } from "../server-analytics";
import { closeFinishedWeeks, closeWeek, readBoard, weekEntries } from "../leaderboard";
import type { XpKind } from "@/app/generated/prisma/client";

// Wednesday 14 Oct 2026, 10:00 Manila. The week runs 12–18 Oct.
const NOW = new Date("2026-10-14T02:00:00Z");
const WEEK = "2026-10-12";
const LAST_WEEK = "2026-10-05";

let seq = 0;

beforeEach(async () => {
  await truncateAll();
  vi.mocked(captureServer).mockReset();
  seq = 0;
});

async function xp(userId: string, amount: number, opts: { weekKey?: string; kind?: XpKind; at?: Date } = {}) {
  const weekKey = opts.weekKey ?? WEEK;
  await prisma.xpEvent.create({
    data: {
      userId,
      kind: opts.kind ?? "ANSWER",
      amount,
      dedupeKey: `test:${++seq}`,
      dayKey: weekKey,
      weekKey,
      createdAt: opts.at ?? new Date(NOW.getTime() - 3600_000 + seq * 1000),
    },
  });
}

async function check(userId: string, passed: boolean, at: Date) {
  const task = await createGoldTask("A");
  await prisma.submission.create({
    data: {
      userId,
      taskId: task.id,
      choice: passed ? "A" : "B",
      reason: VALID_REASON,
      isGoldCheck: true,
      goldPassed: passed,
      payoutAmountUnits: 0n,
      payoutStatus: "skipped",
      createdAt: at,
    },
  });
}

async function labeler(name?: string, shown = true) {
  const u = await createUser();
  if (name) await prisma.user.update({ where: { id: u.id }, data: { displayName: name, showOnBoard: shown } });
  return u.id;
}

describe("weekEntries", () => {
  it("sums each labeler's XP for the week, leaving out event codes and other weeks", async () => {
    const a = await labeler();
    await xp(a, 15);
    await xp(a, 20, { kind: "DAILY_GOAL" });
    await xp(a, 25, { kind: "EVENT_CODE" });
    await xp(a, 500, { weekKey: LAST_WEEK, at: new Date("2026-10-07T02:00:00Z") });
    const entries = await weekEntries(WEEK);
    expect(entries).toMatchObject([{ userId: a, xp: 35 }]);
  });

  it("counts only checks inside the Manila week, retest left out", async () => {
    const a = await labeler();
    await xp(a, 50);
    // Sunday 11 Oct 23:59 Manila is last week; Monday 12 Oct 00:00 is this one.
    await check(a, false, new Date("2026-10-11T15:59:00Z"));
    await check(a, true, new Date("2026-10-11T16:00:00Z"));
    await check(a, false, new Date("2026-10-13T02:00:00Z"));
    const task = await createGoldTask("A");
    await prisma.submission.create({
      data: {
        userId: a,
        taskId: task.id,
        choice: "B",
        reason: VALID_REASON,
        isGoldCheck: true,
        goldPassed: false,
        retest: true,
        payoutAmountUnits: 0n,
        payoutStatus: "skipped",
        createdAt: new Date("2026-10-13T03:00:00Z"),
      },
    });
    const [entry] = await weekEntries(WEEK);
    expect(entry.checks).toEqual({ passed: 1, total: 2 });
  });

  it("leaves out a banned labeler, so they can't place or take a Top 3 stamp", async () => {
    const [a, banned] = [await labeler(), await labeler()];
    await xp(a, 40);
    await xp(banned, 900);
    await prisma.user.update({ where: { id: banned }, data: { isBanned: true } });
    expect((await weekEntries(WEEK)).map((e) => e.userId)).toEqual([a]);
  });
});

describe("readBoard", () => {
  it("ranks to match the ledger and marks the caller", async () => {
    const [a, b, c] = [await labeler("migs.dela"), await labeler(), await labeler("tala.labels")];
    await xp(a, 610);
    await xp(b, 545);
    await xp(c, 330);
    const board = await readBoard(c, NOW);
    expect(board.weekKey).toBe(WEEK);
    expect(board.endsDay).toBe("2026-10-18");
    expect(board.rows).toEqual([
      { rank: 1, name: "migs.dela", tier: 0, xp: 610, you: false },
      { rank: 2, name: null, tier: 0, xp: 545, you: false },
      { rank: 3, name: "tala.labels", tier: 0, xp: 330, you: true },
    ]);
    expect(board.you).toMatchObject({ rank: 3, xp: 330, placed: true, inTop: true });
  });

  it("shows a hidden labeler's tier but never their name", async () => {
    const shy = await labeler("secret.name", false);
    await prisma.user.update({ where: { id: shy }, data: { tier: 2 } });
    const hid = await labeler("was.hidden");
    await prisma.user.update({ where: { id: hid }, data: { displayNameHiddenAt: new Date() } });
    await xp(shy, 100);
    await xp(hid, 90);
    const board = await readBoard(await labeler(), NOW);
    expect(board.rows.map((r) => [r.name, r.tier])).toEqual([
      [null, 2],
      [null, 0],
    ]);
    const raw = JSON.stringify(board);
    expect(raw).not.toContain("secret.name");
    expect(raw).not.toContain("was.hidden");
  });

  it("adds the caller's own row below the top 20", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const id = await labeler();
      ids.push(id);
      await xp(id, 1000 - i * 10);
    }
    const board = await readBoard(ids[23], NOW);
    expect(board.rows).toHaveLength(20);
    expect(board.rows.some((r) => r.you)).toBe(false);
    expect(board.you).toMatchObject({ rank: 24, xp: 770, placed: true, inTop: false });
  });

  it("leaves a labeler under 80% this week off the board, and tells them", async () => {
    const sloppy = await labeler("sloppy");
    await xp(sloppy, 900);
    for (const passed of [true, false, false]) await check(sloppy, passed, new Date("2026-10-13T02:00:00Z"));
    const other = await labeler();
    await xp(other, 10);
    const board = await readBoard(sloppy, NOW);
    expect(board.rows.map((r) => r.xp)).toEqual([10]);
    expect(board.you).toMatchObject({ rank: null, xp: 900, placed: false, inTop: false });
  });

  it("returns the caller's own name settings", async () => {
    const me = await labeler("tala.labels", false);
    const board = await readBoard(me, NOW);
    expect(board.settings).toEqual({ displayName: "tala.labels", showOnBoard: false, nameHidden: false });
  });
});

describe("closing a week", () => {
  async function lastWeekBoard() {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await labeler();
      ids.push(id);
      await xp(id, 500 - i * 50, { weekKey: LAST_WEEK, at: new Date(Date.UTC(2026, 9, 6 + i, 2)) });
    }
    return ids;
  }

  it("records last week's places and awards the Top 3 stamp on the first read of a new week", async () => {
    const ids = await lastWeekBoard();
    await readBoard(ids[4], NOW);

    const results = await prisma.weeklyResult.findMany({ where: { weekKey: LAST_WEEK }, orderBy: { rank: "asc" } });
    expect(results.map((r) => [r.userId, r.rank, r.xp])).toEqual(ids.map((id, i) => [id, i + 1, 500 - i * 50]));
    const stamped = await prisma.userStamp.findMany({ where: { stampId: "top-3-week" } });
    expect(stamped.map((s) => s.userId).sort()).toEqual(ids.slice(0, 3).sort());
    expect(vi.mocked(captureServer).mock.calls.filter((c) => c[1] === "stamp_awarded")).toHaveLength(3);
  });

  it("closes a week once, however many reads race to close it", async () => {
    const ids = await lastWeekBoard();
    await Promise.all(ids.map((id) => readBoard(id, NOW)));
    await closeWeek(LAST_WEEK, NOW);
    expect(await prisma.boardWeek.count()).toBe(1);
    expect(await prisma.weeklyResult.count()).toBe(5);
    expect(await prisma.userStamp.count({ where: { stampId: "top-3-week" } })).toBe(3);
    expect(vi.mocked(captureServer).mock.calls.filter((c) => c[1] === "stamp_awarded")).toHaveLength(3);
  });

  it("doesn't award the stamp twice to a labeler who already holds it", async () => {
    const ids = await lastWeekBoard();
    await prisma.userStamp.create({ data: { userId: ids[0], stampId: "top-3-week" } });
    await closeWeek(LAST_WEEK, NOW);
    expect(await prisma.userStamp.count({ where: { stampId: "top-3-week" } })).toBe(3);
    const sent = vi.mocked(captureServer).mock.calls.filter((c) => c[1] === "stamp_awarded").map((c) => c[0]);
    expect(sent.sort()).toEqual([ids[1], ids[2]].sort());
  });

  it("closes a week nobody placed in, and never the week still running", async () => {
    expect(await closeWeek(LAST_WEEK, NOW)).toEqual({ closed: true, stamped: [] });
    expect(await closeWeek(LAST_WEEK, NOW)).toEqual({ closed: false, stamped: [] });
    expect(await closeWeek(WEEK, NOW)).toEqual({ closed: false, stamped: [] });
    expect(await prisma.boardWeek.findMany({ select: { weekKey: true } })).toEqual([{ weekKey: LAST_WEEK }]);
  });

  it("reports the caller's best finish", async () => {
    const ids = await lastWeekBoard();
    await prisma.weeklyResult.create({ data: { weekKey: "2026-09-28", userId: ids[4], rank: 2, xp: 700 } });
    const board = await readBoard(ids[4], NOW);
    expect(board.bestRank).toBe(2);
    expect((await readBoard(ids[3], NOW)).bestRank).toBe(4);
    expect((await readBoard(await labeler(), NOW)).bestRank).toBeNull();
  });
});

describe("closeFinishedWeeks", () => {
  const TWO_WEEKS_AGO = "2026-09-28";

  it("closes only last week before any week has closed, so earlier weeks stay open", async () => {
    const a = await labeler();
    await xp(a, 100, { weekKey: TWO_WEEKS_AGO, at: new Date("2026-09-30T02:00:00Z") });
    expect((await closeFinishedWeeks(NOW)).map((w) => w.weekKey)).toEqual([LAST_WEEK]);
    expect(await prisma.boardWeek.findUnique({ where: { weekKey: TWO_WEEKS_AGO } })).toBeNull();
  });

  it("closes a week nobody read the board after, with its finishes and Top 3 stamps", async () => {
    await prisma.boardWeek.create({ data: { weekKey: "2026-09-21" } });
    const a = await labeler();
    await xp(a, 100, { weekKey: TWO_WEEKS_AGO, at: new Date("2026-09-30T02:00:00Z") });

    const weeks = await closeFinishedWeeks(NOW);
    expect(weeks.map((w) => [w.weekKey, w.closed])).toEqual([[TWO_WEEKS_AGO, true], [LAST_WEEK, true]]);
    expect(await prisma.weeklyResult.findMany({ where: { weekKey: TWO_WEEKS_AGO } })).toMatchObject([{ userId: a, rank: 1 }]);
    expect(await prisma.userStamp.count({ where: { userId: a, stampId: "top-3-week" } })).toBe(1);
    expect(await closeFinishedWeeks(NOW)).toEqual([]);
  });

  it("closes a long gap a few weeks per call, oldest first, and the next call goes on", async () => {
    await prisma.boardWeek.create({ data: { weekKey: "2026-08-03" } });
    const first = await closeFinishedWeeks(NOW, 4);
    expect(first.map((w) => w.weekKey)).toEqual(["2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31"]);
    expect((await closeFinishedWeeks(NOW, 4))[0].weekKey).toBe("2026-09-07");
  });
});
