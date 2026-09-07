import { NextRequest, NextResponse } from "next/server";
import { authenticateCron } from "@/lib/cron-auth";
import {
  loadReserveRefillStatus,
  type ReserveRefillPlan,
} from "@/lib/stellar/reserve-refill";

export const dynamic = "force-dynamic";

/** Convert every bigint in a refill plan to a JSON-safe decimal string. */
function serializePlan(plan: ReserveRefillPlan) {
  switch (plan.status) {
    case "healthy":
      return {
        status: plan.status,
        hotBalanceUnits: plan.hotBalanceUnits.toString(),
        coldBalanceUnits: plan.coldBalanceUnits.toString(),
      };
    case "refill_required":
      return {
        status: plan.status,
        amountUnits: plan.amountUnits.toString(),
        hotBalanceUnits: plan.hotBalanceUnits.toString(),
        coldBalanceUnits: plan.coldBalanceUnits.toString(),
        coldAfterUnits: plan.coldAfterUnits.toString(),
      };
    case "insufficient_reserve":
      return {
        status: plan.status,
        requiredUnits: plan.requiredUnits.toString(),
        availableUnits: plan.availableUnits.toString(),
        hotBalanceUnits: plan.hotBalanceUnits.toString(),
        coldBalanceUnits: plan.coldBalanceUnits.toString(),
      };
  }
}

/** Authenticate a scheduled reserve check and return its non-mutating plan. */
export async function POST(request: NextRequest) {
  const authError = authenticateCron(request);
  if (authError) return authError;

  try {
    const plan = await loadReserveRefillStatus();
    const status =
      plan.status === "healthy"
        ? 200
        : plan.status === "refill_required"
          ? 202
          : 503;
    return NextResponse.json(serializePlan(plan), { status });
  } catch (error) {
    console.error(
      "[cron/reserve-refill] reserve check failed",
      error instanceof Error ? error.name : typeof error,
    );
    return NextResponse.json(
      { error: "Reserve refill check failed" },
      { status: 500 },
    );
  }
}
