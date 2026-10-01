import { NextResponse } from "next/server";
import { fetchRecentPayouts } from "@/lib/recent-payouts";

export const dynamic = "force-dynamic";

/**
 * Recent USDC payouts from the payout account, for the landing page's live
 * feed. Public ledger data only: amounts, shortened recipients, timestamps and
 * explorer links. A failed Horizon read is a 502, so the page can say the ledger
 * could not be reached rather than showing an empty feed.
 */
export async function GET() {
  try {
    const result = await fetchRecentPayouts();
    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, max-age=15, stale-while-revalidate=30" },
    });
  } catch (err) {
    console.warn("[payouts/recent] horizon_unavailable", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "horizon_unavailable" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
