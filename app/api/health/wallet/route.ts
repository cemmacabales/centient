import { NextResponse } from "next/server";
import { getWalletHealth } from "@/lib/stellar/balance";

export const dynamic = "force-dynamic";

export async function GET() {
  const health = await getWalletHealth();
  return NextResponse.json({
    // USDC payout float + XLM fee/reserve floor of the pooled platform account.
    usdcBalance: health.usdcBalance,
    rewardTokenSymbol: health.rewardTokenSymbol,
    xlmBalance: health.xlmBalance,
    healthy: health.healthy,
    warnings: health.warnings,
    pages: health.pages,
  });
}
