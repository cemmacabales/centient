import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { getLabelerSession, requireLabelerSession } from "@/lib/labeler-auth";
import {
  getMinWithdrawalWei,
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

/**
 * P3a — withdrawal endpoint. Turns the labeler's whole accumulated off-chain
 * balance into a single queued lump-sum payout to their linked wallet.
 *
 * Auth is cookie-session only (the strongest available): the destination is the
 * authenticated user's own linked wallet, never an address supplied in the body,
 * so knowing someone's wallet can't trigger a withdrawal. The atomic
 * lock-decrement-enqueue (and the one-in-flight unique index) live in
 * `enqueueWithdrawal`, so this handler only does auth, policy gates, and response
 * shaping.
 */
export async function POST(req: NextRequest) {
  const userId = await getLabelerSession(req);
  const unauthorized = requireLabelerSession(userId);
  if (unauthorized) return unauthorized;

  const user = await prisma.user.findUnique({
    where: { id: userId! },
    select: {
      walletAddress: true,
      email: true,
      isBanned: true,
      submissionCount: true,
      goldCorrect: true,
      goldAttempted: true,
      createdAt: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (user.isBanned) {
    return NextResponse.json({ error: "account_frozen" }, { status: 403 });
  }
  if (!user.walletAddress) {
    return NextResponse.json({ error: "no_wallet_linked" }, { status: 400 });
  }

  // P4b — identity-based anti-fraud gates: reject if the account's email or
  // wallet is banned, or if the wallet is shared across too many accounts.
  const banError = await isAnyIdentifierBanned(user.email, user.walletAddress, userId!);
  if (banError) {
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

  const sharedWalletError = await checkSharedWallet(user.walletAddress, userId!);
  if (sharedWalletError) {
    return NextResponse.json(
      {
        error: "shared_wallet_detected",
        walletAddress: sharedWalletError.walletAddress,
        accountCount: sharedWalletError.accountCount,
      },
      { status: 403 },
    );
  }

  // P4a — anti-fraud eligibility gates: quality history (gold rate), minimum
  // submissions, and account age. Checked before locking any balance so a
  // rejection never touches funds. The reason is surfaced so the UI can tell the
  // labeler exactly which gate they have not yet cleared.
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

  try {
    const result = await enqueueWithdrawal(
      userId!,
      user.walletAddress,
      getMinWithdrawalWei(),
    );

    return NextResponse.json({
      status: "queued",
      withdrawalId: result.payoutJobId,
      amountWei: result.amountWei.toString(),
      destinationAddress: user.walletAddress,
      token: REWARD_TOKEN_SYMBOL,
    });
  } catch (err) {
    if (err instanceof BelowMinimumWithdrawalError) {
      return NextResponse.json(
        {
          error: "below_minimum",
          minimumWei: err.minimumWei.toString(),
          balanceWei: err.balanceWei.toString(),
        },
        { status: 400 },
      );
    }
    if (err instanceof WithdrawalInFlightError) {
      return NextResponse.json({ error: "withdrawal_in_flight" }, { status: 409 });
    }
    if (err instanceof BannedIdentityError) {
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
