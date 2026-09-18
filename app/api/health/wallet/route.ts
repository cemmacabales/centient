import { NextResponse } from "next/server";
import { getWalletHealth } from "@/lib/stellar/balance";
import { sponsorshipLiability, type SponsorshipLiability } from "@/lib/sponsored-trustline";
import { sponsorPublicKey } from "@/lib/stellar/client";

export const dynamic = "force-dynamic";

/**
 * Public wallet-health contract: balances, live reserve accounting, and per-asset
 * status. Unavailable reserve counts serialize as null, never as zero.
 *
 * #27 adds the sponsorship liability the ledger records, and its drift from
 * Horizon's `num_sponsoring` when the monitored account is the sponsor. A
 * non-zero drift means on-chain reserves the ledger cannot account for (or the
 * reverse), which reserve reclaim (#29) must reconcile before it can trust
 * either side. The ledger read never takes wallet health down with it.
 */
export async function GET() {
  const [health, liability] = await Promise.all([getWalletHealth(), readLiability()]);
  const sponsorshipReserveDriftUnits =
    liability && health.numSponsoring !== null && sponsorPublicKey() === health.address
      ? health.numSponsoring - liability.reserveUnits
      : null;

  // Reports the pooled platform account's USDC float + XLM fee/reserve floor,
  // now including sponsored-reserve liability (num_sponsoring × 0.5 XLM).
  return NextResponse.json({
    address: health.address,
    usdcBalance: health.usdcBalance,
    rewardTokenSymbol: health.rewardTokenSymbol,
    xlmBalance: health.xlmBalance,
    availableXlmBalance: health.availableXlmBalance,
    baseReserveXlm: health.baseReserveXlm,
    minimumBalanceXlm: health.minimumBalanceXlm,
    nativeSellingLiabilitiesXlm: health.nativeSellingLiabilitiesXlm,
    numSubentries: health.numSubentries,
    numSponsoring: health.numSponsoring,
    numSponsored: health.numSponsored,
    sponsoredReserveXlm: health.sponsoredReserveXlm,
    sponsorshipLiability: liability,
    sponsorshipReserveDriftUnits,
    monitoringStatus: health.monitoringStatus,
    assetStatus: health.assetStatus,
    healthy: health.healthy,
    warnings: health.warnings,
    pages: health.pages,
  });
}

/** The ledger's sponsorship liability, or null when the ledger cannot be read. */
async function readLiability(): Promise<SponsorshipLiability | null> {
  try {
    return await sponsorshipLiability();
  } catch (error) {
    // Class only, as balance.ts does: a driver error can quote the connection URL.
    console.error(
      "[health/wallet] sponsorship ledger unavailable",
      error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
    );
    return null;
  }
}
