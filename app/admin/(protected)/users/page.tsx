import { requireRoleForPage } from "@/lib/admin-auth";
import { getUserRows } from "@/lib/admin-data";
import { REWARD_TOKEN_SYMBOL } from "@/lib/constants";
import UserTable, { type UserTableItem } from "@/components/admin/UserTable";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  await requireRoleForPage("SUPER_ADMIN");

  const rows = await getUserRows();
  const serialized: UserTableItem[] = rows.map((r) => ({
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
    country: r.country,
    gender: r.gender,
    ageRange: r.ageRange,
    onboardingCompleted: r.onboardingCompleted,
    lastSubmissionAt: r.lastSubmissionAt?.toISOString() ?? null,
  }));

  return (
    <div className="space-y-6">
      <header>
        <div className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
          Users
        </div>
        <h1 className="mt-1 font-headline text-3xl font-extrabold tracking-tight text-on-surface">
          Users
        </h1>
        <p className="mt-2 font-body text-sm text-on-surface-variant">
          {rows.length} wallet{rows.length === 1 ? "" : "s"} have submitted at least one task.
          Demographics, gold accuracy, and ban state per wallet. Click a row for the full profile
          (submissions + payout history).
        </p>
      </header>

      <UserTable rows={serialized} rewardSymbol={REWARD_TOKEN_SYMBOL} />
    </div>
  );
}
