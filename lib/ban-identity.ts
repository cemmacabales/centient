import prisma from "@/lib/prisma";
import { BannedIdentifierType, PayoutJobStatus } from "@/app/generated/prisma/client";
import { MAX_SHARED_WALLET_ACCOUNTS } from "./constants";
import { isValidStellarAddress } from "@/lib/stellar/signature";

// ST-4d — the fraud controls key off Stellar `G…` StrKey addresses, which are
// **case-sensitive base32**. NEVER `.toLowerCase()` a WALLET/StrKey value: doing
// so corrupts it into a different (invalid) address, so a stored ban and a live
// destination would never compare equal and the ban/Sybil defense silently dies.
// `.toLowerCase()` remains correct only for EMAIL identifiers (case-insensitive).

export { MAX_SHARED_WALLET_ACCOUNTS };

export class BannedIdentityError extends Error {
  constructor(
    public readonly bannedIdentifierType: BannedIdentifierType,
    public readonly identifierValue: string,
    public readonly reason: string | null,
  ) {
    super(`Banned identity: ${bannedIdentifierType} = ${identifierValue}`);
    this.name = "BannedIdentityError";
  }
}

export class SharedWalletError extends Error {
  constructor(
    public readonly walletAddress: string,
    public readonly accountCount: number,
  ) {
    super(`Wallet ${walletAddress} has received withdrawals from ${accountCount} accounts, exceeding the limit`);
    this.name = "SharedWalletError";
  }
}

export async function isAnyIdentifierBanned(
  email: string | null,
  walletAddress: string | null,
  userId: string,
): Promise<BannedIdentityError | null> {
  const identifiers: Array<{ type: BannedIdentifierType; value: string }> = [];

  if (email) {
    identifiers.push({ type: "EMAIL", value: email });
  }
  // Case-preserved StrKey. A malformed value can't match a well-formed stored
  // ban, so skip it rather than lowercasing (which would corrupt a valid `G…`).
  if (walletAddress && isValidStellarAddress(walletAddress)) {
    identifiers.push({ type: "WALLET", value: walletAddress });
  }
  identifiers.push({ type: "USER_ID", value: userId });

  if (identifiers.length === 0) {
    return null;
  }

  for (const { type, value } of identifiers) {
    const banError = await checkIdentifierBan(type, value);
    if (banError) return banError;
  }

  const historicalIdentifiers = await getHistoricalIdentifiers(userId);
  for (const hist of historicalIdentifiers) {
    const banError = await checkIdentifierBan(hist.identifierType, hist.identifierValue);
    if (banError) return banError;
  }

  return null;
}

async function checkIdentifierBan(
  identifierType: BannedIdentifierType,
  identifierValue: string,
): Promise<BannedIdentityError | null> {
  const banned = await prisma.bannedIdentity.findUnique({
    where: {
      identifierType_identifierValue: { identifierType, identifierValue },
    },
  });

  if (banned) {
    const isExpired = banned.bannedUntil && new Date() > banned.bannedUntil;
    if (!isExpired) {
      return new BannedIdentityError(identifierType, identifierValue, banned.reason);
    }
  }

  return null;
}

async function getHistoricalIdentifiers(userId: string): Promise<
  Array<{ identifierType: BannedIdentifierType; identifierValue: string }>
> {
  const history = await prisma.userIdentifierHistory.findMany({
    where: { userId },
    select: { identifierType: true, identifierValue: true, isActive: true },
  });

  return history.map((h) => ({
    identifierType: h.identifierType as BannedIdentifierType,
    identifierValue: h.identifierValue,
  }));
}

export async function checkSharedWallet(
  destinationAddress: string,
  excludeUserId?: string,
): Promise<SharedWalletError | null> {
  const completedStatuses: PayoutJobStatus[] = ["done", "failed"];

  const result = await prisma.payoutJob.groupBy({
    by: ["userId"],
    where: {
      // Exact, case-preserved StrKey match against the proven withdrawal
      // destination (bound in ST-4b) — no `.toLowerCase()`.
      destinationAddress,
      type: "WITHDRAWAL",
      status: { in: completedStatuses },
      ...(excludeUserId ? { userId: { not: excludeUserId } } : {}),
    },
  });

  const accountCount = result.length;

  if (accountCount >= MAX_SHARED_WALLET_ACCOUNTS) {
    return new SharedWalletError(destinationAddress, accountCount);
  }

  return null;
}

export async function addBannedIdentity(
  identifierType: BannedIdentifierType,
  identifierValue: string,
  reason?: string,
  bannedUntil?: Date | null,
): Promise<void> {
  // Reject a malformed `G…` StrKey on store rather than silently persisting an
  // un-matchable ban record. Case is preserved — never normalize a StrKey.
  if (identifierType === "WALLET" && !isValidStellarAddress(identifierValue)) {
    throw new Error(`Invalid Stellar wallet address for ban: ${identifierValue}`);
  }

  await prisma.bannedIdentity.upsert({
    where: {
      identifierType_identifierValue: { identifierType, identifierValue },
    },
    update: {
      bannedAt: new Date(),
      bannedUntil: bannedUntil ?? null,
      reason: reason ?? null,
    },
    create: {
      identifierType,
      identifierValue,
      bannedUntil: bannedUntil ?? null,
      reason: reason ?? null,
    },
  });
}

export async function removeBannedIdentity(
  identifierType: BannedIdentifierType,
  identifierValue: string,
): Promise<void> {
  await prisma.bannedIdentity.delete({
    where: {
      identifierType_identifierValue: { identifierType, identifierValue },
    },
  });
}

export async function trackIdentifierChange(
  userId: string,
  identifierType: "EMAIL" | "WALLET",
  oldValue: string | null,
  newValue: string | null,
): Promise<void> {
  // EMAIL is case-insensitive → canonicalize lowercase. WALLET is a
  // case-sensitive StrKey → keep it verbatim (lowercasing corrupts it). The SAME
  // canonicalization must apply to both old and new values, or the unlink below
  // matches on a raw mixed-case EMAIL that no longer equals the stored (lowercased)
  // row, leaving the old identifier active alongside the new one.
  const canonicalize = (value: string) =>
    identifierType === "EMAIL" ? value.toLowerCase() : value;

  if (oldValue) {
    await prisma.userIdentifierHistory.updateMany({
      where: { userId, identifierType, identifierValue: canonicalize(oldValue), isActive: true },
      data: { isActive: false, unlinkedAt: new Date() },
    });
  }

  if (newValue) {
    await prisma.userIdentifierHistory.create({
      data: {
        userId,
        identifierType,
        identifierValue: canonicalize(newValue),
        isActive: true,
      },
    });
  }
}
