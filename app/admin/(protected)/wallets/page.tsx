import WalletTable, { type WalletTableItem } from "@/components/admin/WalletTable";
import { getWalletRows } from "@/lib/admin-data";
import { REWARD_TOKEN_SYMBOL } from "@/lib/constants";
import { requireRoleForPage } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export default async function AdminWalletsPage() {
  await requireRoleForPage("SUPER_ADMIN");
  const rows = await getWalletRows();
  const serialized: WalletTableItem[] = rows.map((r) => ({
    walletAddress: r.walletAddress,
    createdAt: r.createdAt.toISOString(),
    submissionCount: r.submissionCount,
    totalEarned: r.totalEarned,
    goldCorrect: r.goldCorrect,
    goldAttempted: r.goldAttempted,
    goldAccuracyPct: r.goldAccuracyPct,
    isBanned: r.isBanned,
  }));

  return (
    <div className="space-y-6">
      <header>
        <div className="font-label text-[11px] font-bold uppercase tracking-[0.2em] text-outline">
          Per-wallet performance
        </div>
        <h1 className="mt-1 font-headline text-3xl font-extrabold tracking-tight text-on-surface">
          Wallets
        </h1>
        <p className="mt-2 font-body text-sm text-on-surface-variant">
          {rows.length} wallet{rows.length === 1 ? "" : "s"} have submitted at least one task.
          Click a wallet to deep-link (route stubbed for a future release).
        </p>
      </header>

      <WalletTable rows={serialized} rewardSymbol={REWARD_TOKEN_SYMBOL} />
    </div>
  );
}
