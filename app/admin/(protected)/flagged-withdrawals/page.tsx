import { formatUnits } from "viem";
import { requireRoleForPage } from "@/lib/admin-auth";
import prisma from "@/lib/prisma";
import { severityForReason, severityRank } from "@/lib/flagged-withdrawal";
import { REWARD_TOKEN_DECIMALS, REWARD_TOKEN_SYMBOL } from "@/lib/constants";
import FlaggedWithdrawalTable from "@/components/admin/FlaggedWithdrawalTable";

export const dynamic = "force-dynamic";

export default async function AdminFlaggedWithdrawalsPage() {
  await requireRoleForPage("SUPER_ADMIN");

  const flags = await prisma.flaggedWithdrawal.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      user: { select: { email: true, walletAddress: true, isBanned: true } },
    },
  });

  const rows = flags
    .map((f) => ({
      id: f.id,
      userId: f.userId,
      walletAddress: f.walletAddress,
      reason: f.reason,
      severity: severityForReason(f.reason),
      detail: (f.detail ?? null) as Record<string, unknown> | null,
      balance: formatUnits(f.balanceWei, REWARD_TOKEN_DECIMALS),
      createdAt: f.createdAt.toISOString(),
      email: f.user.email,
      userWallet: f.user.walletAddress,
      userIsBanned: f.user.isBanned,
    }))
    // Highest-risk first (CRITICAL → HIGH → LOW), newest within a tier.
    .sort((a, b) => severityRank(a.reason) - severityRank(b.reason) || b.createdAt.localeCompare(a.createdAt));

  return (
    <div className="space-y-6">
      <header>
        <div className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
          Trust &amp; Safety
        </div>
        <h1 className="mt-1 font-headline text-3xl font-extrabold tracking-tight text-on-surface">
          Flagged withdrawals
        </h1>
        <p className="mt-2 font-body text-sm text-on-surface-variant">
          Withdrawals blocked by the anti-fraud gates (banned identity, shared wallet, or
          a failed eligibility check). Approve to let the labeler retry, reject to dismiss,
          or ban to block the account. Every action is written to the audit log.
        </p>
      </header>

      <FlaggedWithdrawalTable rows={rows} tokenSymbol={REWARD_TOKEN_SYMBOL} />
    </div>
  );
}
