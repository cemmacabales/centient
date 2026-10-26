import { NextRequest, NextResponse } from "next/server";
import { authenticateCron } from "@/lib/cron-auth";
import { closeFinishedWeeks } from "@/lib/gamification/leaderboard";
import { addDays, manilaWeekKey } from "@/lib/gamification/time";

export const dynamic = "force-dynamic";

// #203: close every finished week's board (results and Top 3 stamps), up to
// last week. The first board read of a new week does this already; this is the
// backstop for a quiet stretch. Safe to call any time: a week closes once.
export async function POST(req: NextRequest) {
  const authErr = authenticateCron(req);
  if (authErr) return authErr;

  const weeks = await closeFinishedWeeks();
  const closed = weeks.filter((w) => w.closed);
  return NextResponse.json({
    weekKey: addDays(manilaWeekKey(), -7),
    closed: closed.map((w) => w.weekKey),
    stamped: closed.reduce((n, w) => n + w.stamped.length, 0),
  });
}
