// Event codes against the database (#203, ADR-0012). Like every XP write, this
// runs apart from the payout rail: a code gives a stamp and XP, never money.
//
// One transaction per redemption. The redemption row's key (code, account) is
// what refuses a second one, so a double tap, or two tabs, redeem once; the
// stamp and the XP row carry their own unique keys as a second guard.

import prisma from "@/lib/prisma";
import { takeRateLimit } from "@/lib/rate-limit";
import { isValidStellarAddress } from "@/lib/stellar/signature";
import type { RedeemError } from "./redeem-types";
import { codeWindow, EVENT_CODE_XP, EVENT_RULES, eventStampId, normalizeCode, type EventCodeInput } from "./events";
import { captureServer } from "./server-analytics";
import { manilaDayKey, weekKeyOf } from "./time";

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "P2002";
}

export type { RedeemError };

export type RedeemResult =
  | {
      ok: true;
      code: string;
      stamp: { id: string; title: string; icon: string };
      xp: number;
      xpTotal: number;
    }
  | { ok: false; error: Exclude<RedeemError, "rate_limited"> }
  | { ok: false; error: "rate_limited"; retryAfterSeconds: number };

/**
 * Redeem a code for a labeler. Null when the account is gone. Every attempt
 * counts toward the guess limit, so a right code can't be found by trying.
 */
export async function redeemEventCode(userId: string, raw: unknown, at: Date = new Date()): Promise<RedeemResult | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { walletAddress: true, isBanned: true } });
  if (!user) return null;
  // The same gate as /api/task: a code is for an account that can be served work.
  if (!user.walletAddress || !isValidStellarAddress(user.walletAddress)) return { ok: false, error: "wallet_required" };
  // Cooldown, retest and a permanent ban all keep isBanned until it's lifted.
  if (user.isBanned) return { ok: false, error: "banned" };

  const limit = await takeRateLimit(`event-code:${userId}`, EVENT_RULES.guesses);
  if (limit.limited) return { ok: false, error: "rate_limited", retryAfterSeconds: limit.retryAfterSeconds };

  const code = normalizeCode(raw);
  const row = code ? await prisma.eventCode.findUnique({ where: { code } }) : null;
  if (!row) return { ok: false, error: "unknown_code" };

  const dayKey = manilaDayKey(at);
  const window = codeWindow(row, dayKey);
  if (window === "before") return { ok: false, error: "not_open" };
  if (window === "after") return { ok: false, error: "ended" };

  const stampId = eventStampId(row.id);
  let xpTotal: number;
  try {
    xpTotal = await prisma.$transaction(async (tx) => {
      await tx.eventRedemption.create({ data: { eventCodeId: row.id, userId, createdAt: at } });
      await tx.userStamp.create({ data: { userId, stampId, awardedAt: at } });
      await tx.xpEvent.create({
        data: {
          userId,
          kind: "EVENT_CODE",
          amount: EVENT_CODE_XP,
          dedupeKey: `event:${row.id}:${userId}`,
          dayKey,
          weekKey: weekKeyOf(dayKey),
          createdAt: at,
        },
      });
      const updated = await tx.user.update({
        where: { id: userId },
        data: { xp: { increment: EVENT_CODE_XP } },
        select: { xp: true },
      });
      return updated.xp;
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: "already_redeemed" };
    throw err;
  }

  // The XP counts toward tiers. It opens one on the labeler's next answer,
  // where the tier-up screen shows, as crowd XP does (ADR-0011).
  captureServer(userId, "event_code_redeemed", { code: row.code, xp: EVENT_CODE_XP });
  captureServer(userId, "stamp_awarded", { stamp: stampId });
  return {
    ok: true,
    code: row.code,
    stamp: { id: stampId, title: row.stampTitle, icon: row.stampIcon },
    xp: EVENT_CODE_XP,
    xpTotal,
  };
}

export type CreateResult =
  | { ok: true; code: { id: string; code: string } }
  | { ok: false; error: "code_taken" };

export async function createEventCode(adminUserId: string, input: EventCodeInput): Promise<CreateResult> {
  try {
    const row = await prisma.eventCode.create({
      data: { ...input, createdByAdminId: adminUserId },
      select: { id: true, code: true },
    });
    return { ok: true, code: row };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: "code_taken" };
    throw err;
  }
}

export interface EventCodeRow {
  id: string;
  code: string;
  stampTitle: string;
  stampIcon: string;
  startsDay: string;
  endsDay: string;
  redeemed: number;
  createdAt: string;
}

/** Every code, newest first, with how many accounts redeemed it. */
export async function listEventCodes(): Promise<EventCodeRow[]> {
  const rows = await prisma.eventCode.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { redemptions: true } } },
  });
  return rows.map(({ _count, createdByAdminId: _admin, createdAt, ...r }) => ({
    ...r,
    redeemed: _count.redemptions,
    createdAt: createdAt.toISOString(),
  }));
}
