import { NextResponse } from "next/server";
import { getWalletHealth } from "@/lib/celo-balance";

export const dynamic = "force-dynamic";

export async function GET() {
  const health = await getWalletHealth();
  return NextResponse.json({
    address: health.address,
    rewardTokenBalance: health.rewardTokenBalance,
    rewardTokenSymbol: health.rewardTokenSymbol,
    celoBalance: health.celoBalance,
    healthy: health.healthy,
    warnings: health.warnings,
    pages: health.pages,
  });
}