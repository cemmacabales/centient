import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { getLabelerSession, requireLabelerSession } from "@/lib/labeler-auth";
import {
  getMinWithdrawalUnits,
  getWithdrawalThresholds,
  REWARD_TOKEN_SYMBOL,
} from "@/lib/constants";
import {
  enqueueWithdrawal,
  BelowMinimumWithdrawalError,
  WithdrawalInFlightError,
} from "@/lib/user-balance";
import {
  isAnyIdentifierBanned,
  checkSharedWallet,
  BannedIdentityError,
  SharedWalletError,
} from "@/lib/ban-identity";
import { checkWithdrawalEligibility } from "@/lib/withdrawal-eligibility";
import { recordFlaggedWithdrawal } from "@/lib/flagged-withdrawal";
import { isValidStellarAddress } from "@/lib/stellar/signature";
import { accountHasUsdcTrustline } from "@/lib/stellar/client";

export async function POST(req: NextRequest) {
  const userId = await getLabelerSession(req);
  const unauthorized = requireLabelerSession(userId);
  if (unauthorized) return unauthorized;

  const user = await prisma.user.findUnique({
    where: { id: userId! },
    select: {
      email: true,
      isBanned: true,
      submissionCount: true,
      goldCorrect: true,
      goldAttempted: true,
      createdAt: true,
      pendingBalanceUnits: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (user.isBanned) {
    return NextResponse.json({ error: "account_frozen" }, { status: 403 });
  }

  // Paste-and-send: the recipient Stellar address is supplied fresh in the body
  // on every withdrawal — no persistent linked wallet and no ownership proof.
  // This deliberately reverses the earlier "destination is never from the body"
  // rule (product decision, 2026-07-05 spec). A typo sends USDC irreversibly, so
  // the client shows a confirm step before calling this.
  const body = await req.json().catch(() => null);
  const destinationAddress =
    body && typeof body === "object"
      ? (body as { destinationAddress?: unknown }).destinationAddress
      : undefined;
  if (typeof destinationAddress !== "string" || !destinationAddress) {
    return NextResponse.json({ error: "missing_address" }, { status: 400 });
  }
  // StrKey is case-sensitive — never normalize. A malformed or legacy `0x…`
  // value can never receive USDC; reject before touching any balance.
  if (!isValidStellarAddress(destinationAddress)) {
    return NextResponse.json({ error: "invalid_wallet" }, { status: 400 });
  }

  // P4c — record blocked withdrawals for the admin queue. Best-effort; a failure
  // to record must never turn a clean 403 into a 500.
  const flag = (
    reason: "BANNED_IDENTITY" | "SHARED_WALLET" | "INELIGIBLE",
    detail: Record<string, unknown>,
  ) =>
    recordFlaggedWithdrawal({
      userId: userId!,
      walletAddress: destinationAddress,
      reason,
      detail: detail as never,
      balanceUnits: user.pendingBalanceUnits,
    }).catch((err) => {
      Sentry.captureException(err, { extra: { context: "flag-withdrawal", userId } });
    });

  // P4b — identity-based anti-fraud gates run against the typed destination.
  const banError = await isAnyIdentifierBanned(user.email, destinationAddress, userId!);
  if (banError) {
    await flag("BANNED_IDENTITY", {
      identifierType: banError.bannedIdentifierType,
      identifierValue: banError.identifierValue,
      reason: banError.reason,
    });
    return NextResponse.json(
      {
        error: "identity_banned",
        identifierType: banError.bannedIdentifierType,
        identifierValue: banError.identifierValue,
        reason: banError.reason,
      },
      { status: 403 },
    );
  }

  const sharedWalletError = await checkSharedWallet(destinationAddress, userId!);
  if (sharedWalletError) {
    await flag("SHARED_WALLET", {
      walletAddress: sharedWalletError.walletAddress,
      accountCount: sharedWalletError.accountCount,
    });
    return NextResponse.json(
      {
        error: "shared_wallet_detected",
        walletAddress: sharedWalletError.walletAddress,
        accountCount: sharedWalletError.accountCount,
      },
      { status: 403 },
    );
  }

  // P4a — quality/eligibility gates, checked before locking any balance.
  const eligibility = checkWithdrawalEligibility(
    {
      submissionCount: user.submissionCount,
      goldCorrect: user.goldCorrect,
      goldAttempted: user.goldAttempted,
      createdAt: user.createdAt,
    },
    getWithdrawalThresholds(),
  );
  if (!eligibility.eligible) {
    await flag("INELIGIBLE", {
      reason: eligibility.reason,
      required: eligibility.required,
      actual: eligibility.actual,
    });
    return NextResponse.json(
      {
        error: "not_eligible",
        reason: eligibility.reason,
        required: eligibility.required,
        actual: eligibility.actual,
      },
      { status: 403 },
    );
  }

  // USDC-trustline precheck on the typed address before locking any balance: an
  // untrusted address would fail the on-chain payout with `op_no_trust`. Reject
  // with guidance so the recipient adds the trustline in their own wallet.
  let hasTrustline: boolean;
  try {
    hasTrustline = await accountHasUsdcTrustline(destinationAddress);
  } catch (err) {
    Sentry.captureException(err, { extra: { context: "withdraw-trustline", userId } });
    return NextResponse.json({ error: "trustline_check_failed" }, { status: 502 });
  }
  if (!hasTrustline) {
    return NextResponse.json(
      {
        error: "no_trustline",
        message:
          "Your Stellar address has no USDC trustline yet. Add a USDC trustline in your wallet, then withdraw again.",
      },
      { status: 409 },
    );
  }

  try {
    const result = await enqueueWithdrawal(
      userId!,
      destinationAddress,
      getMinWithdrawalUnits(),
    );

    return NextResponse.json({
      status: "queued",
      withdrawalId: result.payoutJobId,
      amountUnits: result.amountUnits.toString(),
      destinationAddress,
      token: REWARD_TOKEN_SYMBOL,
    });
  } catch (err) {
    if (err instanceof BelowMinimumWithdrawalError) {
      return NextResponse.json(
        {
          error: "below_minimum",
          minimumUnits: err.minimumUnits.toString(),
          balanceUnits: err.balanceUnits.toString(),
        },
        { status: 400 },
      );
    }
    if (err instanceof WithdrawalInFlightError) {
      return NextResponse.json({ error: "withdrawal_in_flight" }, { status: 409 });
    }
    if (err instanceof BannedIdentityError) {
      await flag("BANNED_IDENTITY", {
        identifierType: err.bannedIdentifierType,
        identifierValue: err.identifierValue,
        reason: err.reason,
      });
      return NextResponse.json(
        {
          error: "identity_banned",
          identifierType: err.bannedIdentifierType,
          identifierValue: err.identifierValue,
          reason: err.reason,
        },
        { status: 403 },
      );
    }
    if (err instanceof SharedWalletError) {
      await flag("SHARED_WALLET", {
        walletAddress: err.walletAddress,
        accountCount: err.accountCount,
      });
      return NextResponse.json(
        {
          error: "shared_wallet_detected",
          walletAddress: err.walletAddress,
          accountCount: err.accountCount,
        },
        { status: 403 },
      );
    }
    Sentry.captureException(err, { extra: { context: "withdraw", userId } });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

/**
 * GET — withdrawal summary for the labeler's own account: pending balance, the
 * minimum-withdrawal threshold, whether a withdrawal can be attempted right now,
 * and recent lump-sum withdrawals. This is the read the withdrawal card loads on
 * open and re-fetches after a successful wallet link (ST-4b) or withdrawal, so a
 * freshly-linked `G…` payout address is reflected immediately.
 *
 * `canWithdraw` mirrors POST's cheap gates only — not banned, a valid Stellar
 * destination, eligibility, balance ≥ minimum, and no withdrawal already in
 * flight. The network USDC-trustline precheck deliberately stays on POST so this
 * read never blocks on Horizon; an untrusted address is surfaced there as
 * `no_trustline` with guidance.
 */
export async function GET(req: NextRequest) {
  const userId = await getLabelerSession(req);
  const unauthorized = requireLabelerSession(userId);
  if (unauthorized) return unauthorized;

  const user = await prisma.user.findUnique({
    where: { id: userId! },
    select: {
      isBanned: true,
      submissionCount: true,
      goldCorrect: true,
      goldAttempted: true,
      createdAt: true,
      pendingBalanceUnits: true,
    },
  });
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const minUnits = getMinWithdrawalUnits();
  const eligibility = checkWithdrawalEligibility(
    {
      submissionCount: user.submissionCount,
      goldCorrect: user.goldCorrect,
      goldAttempted: user.goldAttempted,
      createdAt: user.createdAt,
    },
    getWithdrawalThresholds(),
  );

  const jobs = await prisma.payoutJob.findMany({
    where: { userId: userId!, type: "WITHDRAWAL" },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      amountUnits: true,
      status: true,
      txHash: true,
      createdAt: true,
      completedAt: true,
      lastError: true,
    },
  });

  // A withdrawal already `queued`/`processing` would make POST return 409
  // `withdrawal_in_flight` (the `payout_jobs_user_inflight_withdrawal_key` partial
  // unique index allows at most one). Reflect that here so the card disables the
  // button proactively instead of surfacing the 409 only after a click.
  const hasInFlightWithdrawal = jobs.some(
    (j) => j.status === "queued" || j.status === "processing",
  );

  const canWithdraw =
    !user.isBanned &&
    eligibility.eligible &&
    user.pendingBalanceUnits >= minUnits &&
    !hasInFlightWithdrawal;

  return NextResponse.json({
    pendingBalanceUnits: user.pendingBalanceUnits.toString(),
    thresholdUnits: minUnits.toString(),
    canWithdraw,
    withdrawals: jobs.map((j) => ({
      id: j.id,
      amountUnits: (j.amountUnits ?? 0n).toString(),
      status: j.status,
      txHash: j.txHash,
      createdAt: j.createdAt.toISOString(),
      completedAt: j.completedAt ? j.completedAt.toISOString() : null,
      error: j.lastError,
    })),
  });
}
