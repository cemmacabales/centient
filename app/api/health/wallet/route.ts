import { NextResponse } from "next/server";
import { getWalletHealth } from "@/lib/stellar/balance";

export const dynamic = "force-dynamic";

export async function GET() {
  const health = await getWalletHealth();
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
    monitoringStatus: health.monitoringStatus,
    assetStatus: health.assetStatus,
    healthy: health.healthy,
    warnings: health.warnings,
    pages: health.pages,
  });
}
