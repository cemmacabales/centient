// The weekly board against the database (#203, ADR-0012). The rules are in
// board.ts; this reads a week out of the XP ledger and closes finished weeks.
//
// The board shows no wallets, no earnings and no ids: a row is a rank, a name
// or null for "Hidden labeler", a tier and XP. The caller's own name settings
// come back only to the caller.
//
// Nothing in the app runs on a schedule, so a week closes lazily: the first
// board read of a new week records where everyone finished last week and
// awards its Top 3 stamps. POST /api/cron/weekly-board does the same, as a
// backstop. The week's row in board_weeks is written in the same transaction,
// so whichever gets there first closes it and the rest find it closed.

import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import type { Prisma, XpKind } from "@/app/generated/prisma/client";
import { BOARD_RULES, boardFor, publicName, rankWeek, type WeekEntry } from "./board";
import { countedCheck } from "./quality-window";
import { captureServer } from "./server-analytics";
import { addDays, dayStartUtc, manilaWeekKey } from "./time";
import type { BoardView } from "./types";

export type { BoardRow, BoardView } from "./types";

type Db = Prisma.TransactionClient;

/** XP the board doesn't rank: a booth code or an invite can't buy a place. Both still count toward tiers. */
export const UNRANKED_KINDS: readonly XpKind[] = ["EVENT_CODE", "INVITE"];

export const TOP_STAMP = "top-3-week";

/** Every labeler with ranked XP in the week, with that week's quality checks. */
export async function weekEntries(weekKey: string, db: Db = prisma): Promise<WeekEntry[]> {
  const sums = await db.xpEvent.groupBy({
    by: ["userId"],
    // A banned (or cooling-down) labeler doesn't place, so can't take a Top 3 stamp.
    where: { weekKey, kind: { notIn: [...UNRANKED_KINDS] }, user: { isBanned: false } },
    _sum: { amount: true },
    _max: { createdAt: true },
  });
  if (sums.length === 0) return [];

  // Checks by time: a failed check writes no XP row to carry a week key.
  const checks = await db.submission.groupBy({
    by: ["userId", "goldPassed"],
    where: {
      ...countedCheck,
      userId: { in: sums.map((s) => s.userId) },
      createdAt: { gte: dayStartUtc(weekKey), lt: dayStartUtc(addDays(weekKey, 7)) },
    },
    _count: { _all: true },
  });
  const tally = new Map<string, { passed: number; total: number }>();
  for (const c of checks) {
    const t = tally.get(c.userId) ?? { passed: 0, total: 0 };
    t.total += c._count._all;
    if (c.goldPassed) t.passed += c._count._all;
    tally.set(c.userId, t);
  }

  return sums.map((s) => ({
    userId: s.userId,
    xp: s._sum.amount ?? 0,
    reachedAt: s._max.createdAt ?? new Date(0),
    checks: tally.get(s.userId) ?? { passed: 0, total: 0 },
  }));
}

/**
 * Close a finished week: record each placed labeler's finish and award the Top
 * 3 stamp to those who don't hold it. Once per week; the week still running is
 * never closed.
 */
export async function closeWeek(weekKey: string, at: Date = new Date()): Promise<{ closed: boolean; stamped: string[] }> {
  if (weekKey >= manilaWeekKey(at)) return { closed: false, stamped: [] };

  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.$executeRaw`
      INSERT INTO "board_weeks" ("weekKey", "closedAt") VALUES (${weekKey}, ${at}) ON CONFLICT DO NOTHING`;
    if (claimed === 0) return { closed: false, stamped: [] };

    const ranked = rankWeek(await weekEntries(weekKey, tx));
    if (ranked.length > 0) {
      await tx.weeklyResult.createMany({
        data: ranked.map((r) => ({ weekKey, userId: r.userId, rank: r.rank, xp: r.xp })),
      });
    }
    const top = ranked.slice(0, BOARD_RULES.stamped).map((r) => r.userId);
    const held = await tx.userStamp.findMany({
      where: { stampId: TOP_STAMP, userId: { in: top } },
      select: { userId: true },
    });
    const holders = new Set(held.map((h) => h.userId));
    const stamped = top.filter((id) => !holders.has(id));
    if (stamped.length > 0) {
      await tx.userStamp.createMany({ data: stamped.map((userId) => ({ userId, stampId: TOP_STAMP, awardedAt: at })) });
    }
    return { closed: true, stamped };
  });

  for (const userId of result.stamped) captureServer(userId, "stamp_awarded", { stamp: TOP_STAMP });
  return result;
}

/** How far back a quiet stretch is caught up: a year of weeks at most. */
const CATCH_UP_WEEKS = 52;

/** Weeks one labeler's board read closes; the cron, or the next read, does the rest. */
export const READ_CATCH_UP_WEEKS = 4;

/**
 * Close every finished week that isn't closed yet, oldest first: each week
 * after the newest closed one, up to last week. A week nobody read the board
 * after still gets its finishes and Top 3 stamps. Before any week has closed,
 * only last week is, so weeks from before the board (backfilled XP) stay open.
 * At most `limit` weeks per call, oldest first, so the next call goes on.
 */
export async function closeFinishedWeeks(
  at: Date = new Date(),
  limit: number = CATCH_UP_WEEKS,
): Promise<{ weekKey: string; closed: boolean; stamped: string[] }[]> {
  const last = addDays(manilaWeekKey(at), -7);
  const newest = await prisma.boardWeek.findFirst({ orderBy: { weekKey: "desc" }, select: { weekKey: true } });
  const floor = addDays(last, -7 * (CATCH_UP_WEEKS - 1));
  let weekKey = newest ? addDays(newest.weekKey, 7) : last;
  if (weekKey < floor) weekKey = floor;

  const out: { weekKey: string; closed: boolean; stamped: string[] }[] = [];
  for (; weekKey <= last && out.length < limit; weekKey = addDays(weekKey, 7)) out.push({ weekKey, ...(await closeWeek(weekKey, at)) });
  return out;
}

const nameSelect = { displayName: true, showOnBoard: true, displayNameHiddenAt: true, tier: true } as const;

/** This week's board for one labeler. Closes any finished week first, best effort. */
export async function readBoard(userId: string, at: Date = new Date()): Promise<BoardView> {
  const weekKey = manilaWeekKey(at);
  try {
    await closeFinishedWeeks(at, READ_CATCH_UP_WEEKS);
  } catch (err) {
    Sentry.captureException(err, { extra: { context: "board-close-week", weekKey } });
  }

  const entries = await weekEntries(weekKey);
  const board = boardFor(rankWeek(entries), userId, entries);
  const ids = [...new Set([...board.top.map((r) => r.userId), userId])];
  const [users, best] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, ...nameSelect } }),
    prisma.weeklyResult.aggregate({ where: { userId }, _min: { rank: true } }),
  ]);
  const byId = new Map(users.map((u) => [u.id, u]));
  const me = byId.get(userId);

  return {
    weekKey,
    endsDay: addDays(weekKey, 6),
    rows: board.top.map((r) => {
      const u = byId.get(r.userId);
      return { rank: r.rank, name: u ? publicName(u) : null, tier: u?.tier ?? 0, xp: r.xp, you: r.userId === userId };
    }),
    you: {
      rank: board.you.rank,
      xp: board.you.xp,
      placed: board.you.placed,
      inTop: board.youInTop,
      tier: me?.tier ?? 0,
      name: me ? publicName(me) : null,
    },
    settings: {
      displayName: me?.displayName ?? null,
      showOnBoard: me?.showOnBoard ?? false,
      nameHidden: me?.displayNameHiddenAt != null,
    },
    bestRank: best._min.rank ?? null,
  };
}

export interface AdminBoardRow {
  rank: number;
  userId: string;
  /** The name the board shows; null when the labeler opted out or has none. */
  name: string | null;
  optedOut: boolean;
  tier: number;
  xp: number;
}

/** This week's top rows for the admin's Weekly board panel, with the ids a hide needs. */
export async function readAdminBoard(at: Date = new Date()): Promise<{ weekKey: string; rows: AdminBoardRow[] }> {
  const weekKey = manilaWeekKey(at);
  const top = rankWeek(await weekEntries(weekKey)).slice(0, BOARD_RULES.size);
  const users = await prisma.user.findMany({ where: { id: { in: top.map((r) => r.userId) } }, select: { id: true, ...nameSelect } });
  const byId = new Map(users.map((u) => [u.id, u]));
  return {
    weekKey,
    rows: top.map((r) => {
      const u = byId.get(r.userId);
      const name = u ? publicName(u) : null;
      return { rank: r.rank, userId: r.userId, name, optedOut: name === null, tier: u?.tier ?? 0, xp: r.xp };
    }),
  };
}
