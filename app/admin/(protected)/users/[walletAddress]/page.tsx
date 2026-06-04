import { notFound } from "next/navigation";
import { requireRoleForPage } from "@/lib/admin-auth";
import { getUserProfile } from "@/lib/admin-data";
import { REWARD_TOKEN_SYMBOL } from "@/lib/constants";
import UserProfileView, {
  type UserProfileProps,
} from "@/components/admin/UserProfileView";

export const dynamic = "force-dynamic";

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

export default async function AdminUserProfilePage({
  params,
}: {
  params: Promise<{ walletAddress: string }>;
}) {
  await requireRoleForPage("SUPER_ADMIN");

  const { walletAddress } = await params;
  if (!WALLET_RE.test(walletAddress)) {
    notFound();
  }

  const profile = await getUserProfile(walletAddress);
  if (!profile) {
    notFound();
  }

  const serialized: UserProfileProps = {
    walletAddress: profile.walletAddress,
    createdAt: profile.createdAt.toISOString(),
    totalEarned: profile.totalEarned,
    totalEarnedWei: profile.totalEarnedWei.toString(),
    submissionCount: profile.submissionCount,
    goldCorrect: profile.goldCorrect,
    goldAttempted: profile.goldAttempted,
    goldAccuracyPct: profile.goldAccuracyPct,
    isBanned: profile.isBanned,
    bannedAt: profile.bannedAt?.toISOString() ?? null,
    bannedReason: profile.bannedReason,
    country: profile.country,
    gender: profile.gender,
    ageRange: profile.ageRange,
    onboardingCompleted: profile.onboardingCompleted,
    payoutTotals: profile.payoutTotals,
    rewardSymbol: REWARD_TOKEN_SYMBOL,
    recentSubmissions: profile.recentSubmissions.map((s) => ({
      id: s.id,
      taskId: s.taskId,
      taskPrompt: s.taskPrompt,
      choice: s.choice,
      reason: s.reason,
      isGoldCheck: s.isGoldCheck,
      goldPassed: s.goldPassed,
      payoutAmountWei: s.payoutAmountWei.toString(),
      payoutStatus: s.payoutStatus,
      payoutTxHash: s.payoutTxHash,
      createdAt: s.createdAt.toISOString(),
    })),
  };

  return (
    <div className="space-y-6">
      <header>
        <div className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
          <a href="/admin/users" className="hover:underline">
            ← Users
          </a>
        </div>
        <h1 className="mt-1 font-headline text-2xl font-extrabold tracking-tight text-on-surface">
          <span className="font-mono text-base text-on-surface-variant">{profile.walletAddress}</span>
        </h1>
      </header>
      <UserProfileView profile={serialized} />
    </div>
  );
}
