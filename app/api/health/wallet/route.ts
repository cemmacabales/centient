import { NextResponse } from "next/server";
import { getWalletHealth } from "@/lib/stellar/balance";

export const dynamic = "force-dynamic";

export async function GET() {
  const health = await getWalletHealth();
  return NextResponse.json({
    usdcBalance: health.usdcBalance,
    rewardTokenSymbol: health.rewardTokenSymbol,
    xlmBalance: health.xlmBalance,
    numSponsoring: health.numSponsoring,
    sponsoredReserveXlm: health.sponsoredReserveXlm,
    healthy: health.healthy,
    warnings: health.warnings,
    pages: health.pages,
  });
}
