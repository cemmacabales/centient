import { NextRequest, NextResponse } from "next/server";
import { getLabelerSession } from "@/lib/labeler-auth";
import { readProgress } from "@/lib/gamification/ledger";
import { readStanding } from "@/lib/gamification/standing";
import { readBoard } from "@/lib/gamification/leaderboard";
import { readQuests } from "@/lib/gamification/quest-ledger";
import { readInvite } from "@/lib/gamification/invites";

// #201: the labeler's XP, today's goal, the Manila week and the effective
// streak. Kept apart from /api/me, which stays the profile. #202 adds the
// tier card and the stamps; #203, each event stamp, where the labeler stands
// on this week's board, this week's quests and the invite card.
export async function GET(req: NextRequest) {
  const userId = await getLabelerSession(req);
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const [progress, standing] = await Promise.all([readProgress(userId), readStanding(userId)]);
  if (!progress || !standing) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const [{ you, bestRank }, quests, invite] = await Promise.all([readBoard(userId), readQuests(userId), readInvite(userId)]);
  const board = { rank: you.rank, xp: you.xp, placed: you.placed, bestRank };
  return NextResponse.json({ ...progress, ...standing, board, quests, invite });
}
