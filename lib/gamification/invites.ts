// Invites against the database (#203, ADR-0012). Rules in invite-rules.ts.
//
// An invite is captured only when the invitee's account is created (the wallet
// sign-in route, from the link's cookie), and pays once, when the invitee first
// reaches Skilled: InviteReward's key is the invitee. The inviter's row is held
// while their count is read, so the cap of 10 holds when two friends qualify
// together. Invite XP counts toward tiers but not on the weekly board.

import prisma from "@/lib/prisma";
import { INVITE_RULES, newInviteCode, normalizeInviteCode } from "./invite-rules";
import { captureServer } from "./server-analytics";
import { manilaDayKey, weekKeyOf } from "./time";
import type { InviteStanding } from "./types";

export const INVITEE_STAMP = "invited-in";
export const INVITER_STAMP = "brought-a-friend";

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "P2002";
}

/** The labeler's invite code, made on first use. */
export async function inviteCodeFor(userId: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { inviteCode: true } });
    if (user.inviteCode) return user.inviteCode;
    try {
      const set = await prisma.user.updateMany({ where: { id: userId, inviteCode: null }, data: { inviteCode: newInviteCode() } });
      if (set.count === 1) continue;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error("inviteCodeFor: no free code");
}

/** Record who invited a just-created account. False when the code can't apply. */
export async function attachInviter(inviteeId: string, rawCode: unknown): Promise<boolean> {
  const code = normalizeInviteCode(rawCode);
  if (!code) return false;
  const inviter = await prisma.user.findUnique({ where: { inviteCode: code }, select: { id: true } });
  if (!inviter || inviter.id === inviteeId) return false;
  const set = await prisma.user.updateMany({ where: { id: inviteeId, invitedById: null }, data: { invitedById: inviter.id } });
  return set.count === 1;
}

/**
 * Pay an invite off. Called when the invitee's tier opens; does nothing for an
 * account nobody invited, or one already paid.
 */
export async function qualifyInvite(inviteeId: string, at: Date = new Date()): Promise<void> {
  const invitee = await prisma.user.findUnique({ where: { id: inviteeId }, select: { invitedById: true, tier: true } });
  const inviterId = invitee?.invitedById;
  if (!inviterId || invitee.tier < 1) return;

  const dayKey = manilaDayKey(at);
  const weekKey = weekKeyOf(dayKey);
  const xpRow = (userId: string, side: "invitee" | "inviter") => ({
    userId,
    kind: "INVITE" as const,
    amount: INVITE_RULES.xp,
    dedupeKey: `invite:${inviteeId}:${side}`,
    dayKey,
    weekKey,
    createdAt: at,
  });

  let result: { inviterRewarded: boolean; stamps: [string, string][] };
  try {
    result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${inviterId} FOR UPDATE`;
      const inviter = await tx.user.findUnique({ where: { id: inviterId }, select: { isBanned: true } });
      const paid = await tx.inviteReward.count({ where: { inviterId, inviterRewarded: true } });
      const inviterRewarded = !!inviter && !inviter.isBanned && paid < INVITE_RULES.cap;
      await tx.inviteReward.create({ data: { inviteeId, inviterId, inviterRewarded, createdAt: at } });

      const pay: [string, "invitee" | "inviter", string][] = [[inviteeId, "invitee", INVITEE_STAMP]];
      if (inviterRewarded) pay.push([inviterId, "inviter", INVITER_STAMP]);
      const stamps: [string, string][] = [];
      for (const [userId, side, stampId] of pay) {
        await tx.xpEvent.create({ data: xpRow(userId, side) });
        await tx.user.update({ where: { id: userId }, data: { xp: { increment: INVITE_RULES.xp } } });
        const made = await tx.userStamp.createMany({ data: [{ userId, stampId, awardedAt: at }], skipDuplicates: true });
        if (made.count === 1) stamps.push([userId, stampId]);
      }
      return { inviterRewarded, stamps };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return;
    throw err;
  }

  captureServer(inviteeId, "invite_qualified", { inviter_rewarded: result.inviterRewarded });
  for (const [userId, stamp] of result.stamps) captureServer(userId, "stamp_awarded", { stamp });
}

/** The invite card: the code, and how many invites have paid off for this labeler. */
export async function readInvite(userId: string): Promise<InviteStanding> {
  const [code, qualified] = await Promise.all([
    inviteCodeFor(userId),
    prisma.inviteReward.count({ where: { inviterId: userId, inviterRewarded: true } }),
  ]);
  return { code, qualified, cap: INVITE_RULES.cap };
}
