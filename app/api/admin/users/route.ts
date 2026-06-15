import { NextRequest, NextResponse } from "next/server";
import { getAdminSession, requireRoleForRoute } from "@/lib/admin-auth";
import { getUserRows } from "@/lib/admin-data";

export async function GET(_req: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const forbidden = await requireRoleForRoute("SUPER_ADMIN", session);
  if (forbidden) return forbidden;

  const rows = await getUserRows();
  return NextResponse.json(
    rows.map((r) => ({
      walletAddress: r.walletAddress,
      createdAt: r.createdAt.toISOString(),
      submissionCount: r.submissionCount,
      totalEarned: r.totalEarned,
      goldCorrect: r.goldCorrect,
      goldAttempted: r.goldAttempted,
      goldAccuracyPct: r.goldAccuracyPct,
      isBanned: r.isBanned,
      bannedAt: r.bannedAt?.toISOString() ?? null,
      bannedReason: r.bannedReason,
      banCount: r.banCount,
      bannedUntil: r.bannedUntil?.toISOString() ?? null,
      country: r.country,
      gender: r.gender,
      ageRange: r.ageRange,
      onboardingCompleted: r.onboardingCompleted,
      lastSubmissionAt: r.lastSubmissionAt?.toISOString() ?? null,
    })),
  );
}
