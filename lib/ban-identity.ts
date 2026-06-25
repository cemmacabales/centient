import prisma from "@/lib/prisma";
import { BannedIdentifierType, PayoutJobStatus } from "@/app/generated/prisma/client";
import { MAX_SHARED_WALLET_ACCOUNTS } from "./constants";

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
  if (walletAddress) {
    identifiers.push({ type: "WALLET", value: walletAddress.toLowerCase() });
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
      destinationAddress: destinationAddress.toLowerCase(),
      type: "WITHDRAWAL",
      status: { in: completedStatuses },
      ...(excludeUserId ? { userId: { not: excludeUserId } } : {}),
    },
  });

  const accountCount = result.length;
  const walletLower = destinationAddress.toLowerCase();

  if (accountCount >= MAX_SHARED_WALLET_ACCOUNTS) {
    return new SharedWalletError(walletLower, accountCount);
  }

  return null;
}

export async function addBannedIdentity(
  identifierType: BannedIdentifierType,
  identifierValue: string,
  reason?: string,
  bannedUntil?: Date | null,
): Promise<void> {
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
  if (oldValue) {
    await prisma.userIdentifierHistory.updateMany({
      where: { userId, identifierType, identifierValue: oldValue, isActive: true },
      data: { isActive: false, unlinkedAt: new Date() },
    });
  }

  if (newValue) {
    await prisma.userIdentifierHistory.create({
      data: {
        userId,
        identifierType,
        identifierValue: newValue.toLowerCase(),
        isActive: true,
      },
    });
  }
}
