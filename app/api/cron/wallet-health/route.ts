import { NextRequest, NextResponse } from "next/server";
import { authenticateCron } from "@/lib/cron-auth";
import { runHealthMonitor } from "@/lib/health-monitor";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const authError = authenticateCron(request);
  if (authError) return authError;

  try {
    return NextResponse.json(await runHealthMonitor());
  } catch (error) {
    console.error(
      "[cron/wallet-health] health check failed",
      error instanceof Error ? error.name : typeof error,
    );
    return NextResponse.json(
      { error: "Wallet health check failed" },
      { status: 500 },
    );
  }
}
