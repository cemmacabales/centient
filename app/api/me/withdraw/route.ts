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
      pendingBalanceUnits: true,
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

  // P4c — every withdrawal blocked below is recorded for the admin review queue
  // with its trigger reason. Best-effort: a failure to record must never turn a
  // clean 403 rejection into a 500, so it is captured and swallowed.
  const flag = (
    reason: "BANNED_IDENTITY" | "SHARED_WALLET" | "INELIGIBLE",
    detail: Record<string, unknown>,
  ) =>
    recordFlaggedWithdrawal({
      userId: userId!,
      walletAddress: user.walletAddress,
      reason,
      detail: detail as never,
      balanceUnits: user.pendingBalanceUnits,
    }).catch((err) => {
      Sentry.captureException(err, { extra: { context: "flag-withdrawal", userId } });
    });

  // P4b — identity-based anti-fraud gates: reject if the account's email or
  // wallet is banned, or if the wallet is shared across too many accounts.
  const banError = await isAnyIdentifierBanned(user.email, user.walletAddress, userId!);
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

  const sharedWalletError = await checkSharedWallet(user.walletAddress, userId!);
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

  // The linked destination must be a valid `G…` StrKey (case-sensitive). A legacy
  // EVM `0x…` or any corrupted value can never receive USDC and would fail at
  // payout with `op_no_destination` — reject it here so the labeler re-links via
  // the Stellar wallet flow (ST-4b). Checked on the payout path (after the fraud
  // gates) so ban/shared-wallet matching is unaffected until ST-4d retargets it.
  if (!isValidStellarAddress(user.walletAddress)) {
    return NextResponse.json({ error: "invalid_wallet" }, { status: 400 });
  }

  // USDC-trustline precheck before locking any balance: an untrusted `G…` would
  // fail the on-chain payout with a non-retryable `op_no_trust`. Reject up front
  // with guidance so funds are never locked against an unpayable destination.
  // (ST-4e #314 will offer an in-app sponsored trustline instead of rejecting.)
  let hasTrustline: boolean;
  try {
    hasTrustline = await accountHasUsdcTrustline(user.walletAddress);
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
      user.walletAddress,
      getMinWithdrawalUnits(),
    );

    return NextResponse.json({
      status: "queued",
      withdrawalId: result.payoutJobId,
      amountUnits: result.amountUnits.toString(),
      destinationAddress: user.walletAddress,
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
      walletAddress: true,
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

  // A valid `G…` StrKey is linked. Distinct from a legacy EVM `0x…` still sitting
  // in `walletAddress` — the client uses this (not mere truthiness of the address)
  // to decide the link-button label.
  const walletLinked = !!user.walletAddress && isValidStellarAddress(user.walletAddress);

  const canWithdraw =
    !user.isBanned &&
    walletLinked &&
    eligibility.eligible &&
    user.pendingBalanceUnits >= minUnits &&
    !hasInFlightWithdrawal;

  return NextResponse.json({
    pendingBalanceUnits: user.pendingBalanceUnits.toString(),
    thresholdUnits: minUnits.toString(),
    walletLinked,
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
