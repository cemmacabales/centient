// The tier and stamp writer (#202, ADR-0011). Like the XP writer it runs beside
// the payout rail, after the write it follows has committed, so a failure here
// never unwinds an answer, a payout or its XP. Callers treat it as best effort.
//
// One transaction per event, holding the labeler's row: concurrent events for
// the same labeler evaluate one after another, so a tier opens once and a stamp
// is awarded once, and each PostHog event is sent once.

import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { unitsToUsdcDisplay } from "@/lib/stellar/config";
import { readStampStats, readTierSignals } from "./quality-window";
import { captureStanding } from "./server-analytics";
import { answerXp } from "./rules";
import { eventCodeIdOf, eventStampId, isEventStampId } from "./events";
import { qualifyInvite } from "./invites";
import { newlyEarned, stampProgress, STAMPS } from "./stamps";
import { evaluateTier, nextTier, TIER_RULES, TIERS, type TierEvent } from "./tiers";
import type { StandingSummary, TierBand } from "./types";

export interface Standing {
  tier: number;
  onHold: boolean;
  holdChecksPassed: number;
  /** The tier this event opened, if any. */
  tierUp: number | null;
  heldNow: boolean;
  reopened: boolean;
  stampsAwarded: string[];
}

export async function updateStanding(userId: string, event: TierEvent): Promise<Standing> {
  const standing = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { tier: true, tierOnHold: true, holdChecksPassed: true },
    });
    const current = { tier: user.tier, onHold: user.tierOnHold, holdChecksPassed: user.holdChecksPassed };
    const r = evaluateTier(current, await readTierSignals(tx, userId), event);
    if (
      r.state.tier !== current.tier ||
      r.state.onHold !== current.onHold ||
      r.state.holdChecksPassed !== current.holdChecksPassed
    ) {
      await tx.user.update({
        where: { id: userId },
        data: { tier: r.state.tier, tierOnHold: r.state.onHold, holdChecksPassed: r.state.holdChecksPassed },
      });
    }

    const held = await tx.userStamp.findMany({ where: { userId }, select: { stampId: true } });
    const earned = newlyEarned(await readStampStats(tx, userId), new Set(held.map((s) => s.stampId)));
    if (earned.length > 0) {
      await tx.userStamp.createMany({ data: earned.map((stampId) => ({ userId, stampId })) });
    }

    return {
      tier: r.state.tier,
      onHold: r.state.onHold,
      holdChecksPassed: r.state.holdChecksPassed,
      tierUp: r.tierUp,
      heldNow: r.heldNow,
      reopened: r.reopened,
      stampsAwarded: earned,
    };
  });

  // #203: an invite pays off when the invited labeler's first tier opens.
  if (standing.tierUp !== null) {
    try {
      await qualifyInvite(userId);
    } catch (err) {
      Sentry.captureException(err, { extra: { context: "invite-qualify", userId } });
    }
  }

  if (standing.tierUp !== null || standing.heldNow || standing.stampsAwarded.length > 0) {
    captureStanding(userId, {
      tier: standing.tier,
      tierUp: standing.tierUp,
      heldNow: standing.heldNow,
      reopened: standing.reopened,
      stampsAwarded: standing.stampsAwarded,
    });
  }
  return standing;
}

/** The live tasks in a tier's own band (Skilled: 4–5): how many this labeler hasn't answered, and their pay. */
async function band(tier: number, userId: string): Promise<TierBand> {
  const from = TIERS[tier - 1].maxDifficulty + 1;
  const to = TIERS[tier].maxDifficulty;
  const [row] = await prisma.$queryRaw<{ tasks: number; low: bigint | null; high: bigint | null }[]>`
    SELECT COUNT(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM "submissions" s WHERE s."taskId" = t.id AND s."userId" = ${userId}
           ))::int AS tasks,
           MIN(COALESCE(NULLIF(t."rewardUnits", 0), NULLIF(c."rewardUnits", 0))) AS low,
           MAX(COALESCE(NULLIF(t."rewardUnits", 0), NULLIF(c."rewardUnits", 0))) AS high
    FROM "tasks" t LEFT JOIN "campaigns" c ON c.id = t."campaignId"
    WHERE t."disabled" = false AND t."isGold" = false
      AND t."difficulty" >= ${from} AND t."difficulty" <= ${to}`;
  const [xpLow, xpHigh] = [answerXp(from), answerXp(to)];
  return {
    difficulty: `${from}\u2013${to}`,
    tasks: row?.tasks ?? 0,
    payFrom: row?.low ? unitsToUsdcDisplay(row.low) : null,
    payTo: row?.high ? unitsToUsdcDisplay(row.high) : null,
    xp: xpLow === xpHigh ? String(xpLow) : `${xpLow}\u2013${xpHigh}`,
  };
}

/** The tier card and stamps for `GET /api/me/progress`; null when the account is gone. */
export async function readStanding(userId: string): Promise<StandingSummary | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { xp: true, tier: true, tierOnHold: true, holdChecksPassed: true },
  });
  if (!user) return null;
  const next = nextTier(user.tier);
  const [signals, stats, held, own, ahead] = await Promise.all([
    readTierSignals(prisma, userId),
    readStampStats(prisma, userId),
    prisma.userStamp.findMany({ where: { userId }, select: { stampId: true, awardedAt: true } }),
    user.tier > 0 ? band(user.tier, userId) : Promise.resolve(null),
    next ? band(next.id, userId) : Promise.resolve(null),
  ]);
  const awarded = new Map(held.map((s) => [s.stampId, s.awardedAt]));
  // #203: each event code's own stamp, held beside the twelve, oldest first.
  const eventHeld = held.filter((s) => isEventStampId(s.stampId)).sort((a, b) => a.awardedAt.getTime() - b.awardedAt.getTime());
  const codes = eventHeld.length
    ? await prisma.eventCode.findMany({
        where: { id: { in: eventHeld.map((s) => eventCodeIdOf(s.stampId)) } },
        select: { id: true, stampTitle: true, stampIcon: true },
      })
    : [];
  const codeById = new Map(codes.map((c) => [eventStampId(c.id), c]));

  return {
    tier: {
      tier: user.tier,
      name: TIERS[user.tier].name,
      onHold: user.tierOnHold,
      holdChecksPassed: user.holdChecksPassed,
      reopenAfter: TIER_RULES.reopenAfterPasses,
      checks: signals.checks,
      crowd: signals.crowd,
      activeDays: signals.activeDays,
      answers: stats.answers,
      band: own,
      next: next
        ? { tier: next.id, name: next.name, xp: next.xp, xpToGo: Math.max(0, next.xp - user.xp), payUpTo: ahead?.payTo ?? null }
        : null,
    },
    stamps: [
      ...STAMPS.map((def) => ({
        id: def.id,
        awardedAt: awarded.get(def.id)?.toISOString() ?? null,
        progress: stampProgress(def, stats),
      })),
      ...eventHeld.flatMap((s) => {
        const code = codeById.get(s.stampId);
        return code
          ? [{ id: s.stampId, awardedAt: s.awardedAt.toISOString(), progress: null, event: { title: code.stampTitle, icon: code.stampIcon } }]
          : [];
      }),
    ],
  };
}
