import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "@/tests/helpers/db";
import {
  isAnyIdentifierBanned,
  checkSharedWallet,
  addBannedIdentity,
  removeBannedIdentity,
  BannedIdentityError,
  SharedWalletError,
  MAX_SHARED_WALLET_ACCOUNTS,
} from "../ban-identity";

beforeEach(async () => {
  await truncateAll();
});

describe("isAnyIdentifierBanned", () => {
  it("returns null when no identifiers are banned", async () => {
    const result = await isAnyIdentifierBanned("test@example.com", "0x123", "user-123");
    expect(result).toBeNull();
  });

  it("returns BannedIdentityError when email is banned", async () => {
    await prisma.bannedIdentity.create({
      data: {
        identifierType: "EMAIL",
        identifierValue: "banned@example.com",
        reason: "spam",
      },
    });

    const result = await isAnyIdentifierBanned("banned@example.com", "0x123", "user-123");

    expect(result).toBeInstanceOf(BannedIdentityError);
    expect(result!.bannedIdentifierType).toBe("EMAIL");
    expect(result!.identifierValue).toBe("banned@example.com");
    expect(result!.reason).toBe("spam");
  });

  it("returns BannedIdentityError when wallet is banned", async () => {
    await prisma.bannedIdentity.create({
      data: {
        identifierType: "WALLET",
        identifierValue: "0xabc",
        reason: "fraud",
      },
    });

    const result = await isAnyIdentifierBanned("test@example.com", "0xabc", "user-123");

    expect(result).toBeInstanceOf(BannedIdentityError);
    expect(result!.bannedIdentifierType).toBe("WALLET");
    expect(result!.identifierValue).toBe("0xabc");
  });

  it("returns BannedIdentityError when userId is banned", async () => {
    await prisma.bannedIdentity.create({
      data: {
        identifierType: "USER_ID",
        identifierValue: "banned-user-id",
        reason: "abuse",
      },
    });

    const result = await isAnyIdentifierBanned("test@example.com", "0x123", "banned-user-id");

    expect(result).toBeInstanceOf(BannedIdentityError);
    expect(result!.bannedIdentifierType).toBe("USER_ID");
    expect(result!.identifierValue).toBe("banned-user-id");
  });

  it("returns null when ban has expired", async () => {
    await prisma.bannedIdentity.create({
      data: {
        identifierType: "EMAIL",
        identifierValue: "old@example.com",
        bannedUntil: new Date(Date.now() - 86400000),
      },
    });

    const result = await isAnyIdentifierBanned("old@example.com", "0x123", "user-123");

    expect(result).toBeNull();
  });

  it("checks all identifiers in priority order", async () => {
    await prisma.bannedIdentity.create({
      data: {
        identifierType: "USER_ID",
        identifierValue: "user-123",
        reason: "user-level ban",
      },
    });

    const result = await isAnyIdentifierBanned("test@example.com", "0x123", "user-123");

    expect(result).toBeInstanceOf(BannedIdentityError);
    expect(result!.bannedIdentifierType).toBe("USER_ID");
    expect(result!.identifierValue).toBe("user-123");
  });

  it("handles null email and wallet gracefully", async () => {
    const result = await isAnyIdentifierBanned(null, null, "user-123");
    expect(result).toBeNull();
  });
});

describe("checkSharedWallet", () => {
  const SHARED_WALLET = "0x0000000000000000000000000000000000000cCc";

  it("returns null when wallet has received from fewer than MAX_SHARED_WALLET_ACCOUNTS accounts", async () => {
    const users = await Promise.all(
      Array.from({ length: MAX_SHARED_WALLET_ACCOUNTS - 1 }, (_, i) =>
        prisma.user.create({
          data: {
            walletAddress: `0x00000000000000000000000000000000000000${i}`,
            pendingBalanceWei: 0n,
          },
        }),
      ),
    );

    for (const user of users) {
      await prisma.payoutJob.create({
        data: {
          type: "WITHDRAWAL",
          userId: user.id,
          amountWei: 1000000000000000000n,
          destinationAddress: SHARED_WALLET.toLowerCase(),
          status: "done",
        },
      });
    }

    const result = await checkSharedWallet(SHARED_WALLET);
    expect(result).toBeNull();
  });

  it("returns SharedWalletError when wallet has received from MAX_SHARED_WALLET_ACCOUNTS accounts", async () => {
    const users = await Promise.all(
      Array.from({ length: MAX_SHARED_WALLET_ACCOUNTS }, (_, i) =>
        prisma.user.create({
          data: {
            walletAddress: `0x0000000000000000000000000000000000000${i}d`,
            pendingBalanceWei: 0n,
          },
        }),
      ),
    );

    for (const user of users) {
      await prisma.payoutJob.create({
        data: {
          type: "WITHDRAWAL",
          userId: user.id,
          amountWei: 1000000000000000000n,
          destinationAddress: SHARED_WALLET.toLowerCase(),
          status: "done",
        },
      });
    }

    const result = await checkSharedWallet(SHARED_WALLET);

    expect(result).toBeInstanceOf(SharedWalletError);
    expect(result!.walletAddress).toBe(SHARED_WALLET.toLowerCase());
    expect(result!.accountCount).toBe(MAX_SHARED_WALLET_ACCOUNTS);
  });

  it("excludes current user from count", async () => {
    const currentUser = await prisma.user.create({
      data: {
        walletAddress: "0x0000000000000000000000000000000000000eEe",
        pendingBalanceWei: 0n,
      },
    });

    const otherUsers = await Promise.all(
      Array.from({ length: MAX_SHARED_WALLET_ACCOUNTS - 1 }, (_, i) =>
        prisma.user.create({
          data: {
            walletAddress: `0x0000000000000000000000000000000000000${i}f`,
            pendingBalanceWei: 0n,
          },
        }),
      ),
    );

    for (const user of otherUsers) {
      await prisma.payoutJob.create({
        data: {
          type: "WITHDRAWAL",
          userId: user.id,
          amountWei: 1000000000000000000n,
          destinationAddress: SHARED_WALLET.toLowerCase(),
          status: "done",
        },
      });
    }

    const result = await checkSharedWallet(SHARED_WALLET, currentUser.id);

    expect(result).toBeNull();
  });

  it("only counts done/failed withdrawals", async () => {
    const users = await Promise.all(
      Array.from({ length: MAX_SHARED_WALLET_ACCOUNTS }, (_, i) =>
        prisma.user.create({
          data: {
            walletAddress: `0x0000000000000000000000000000000000000${i}g`,
            pendingBalanceWei: 0n,
          },
        }),
      ),
    );

    for (const user of users) {
      await prisma.payoutJob.create({
        data: {
          type: "WITHDRAWAL",
          userId: user.id,
          amountWei: 1000000000000000000n,
          destinationAddress: SHARED_WALLET.toLowerCase(),
          status: "queued",
        },
      });
    }

    const result = await checkSharedWallet(SHARED_WALLET);

    expect(result).toBeNull();
  });
});

describe("addBannedIdentity / removeBannedIdentity", () => {
  it("adds and removes a banned identity", async () => {
    await addBannedIdentity("EMAIL", "test@example.com", "test reason");

    const banned = await prisma.bannedIdentity.findUnique({
      where: { identifierType_identifierValue: { identifierType: "EMAIL", identifierValue: "test@example.com" } },
    });
    expect(banned).not.toBeNull();
    expect(banned!.reason).toBe("test reason");

    await removeBannedIdentity("EMAIL", "test@example.com");

    const after = await prisma.bannedIdentity.findUnique({
      where: { identifierType_identifierValue: { identifierType: "EMAIL", identifierValue: "test@example.com" } },
    });
    expect(after).toBeNull();
  });

  it("upserts an existing banned identity", async () => {
    await addBannedIdentity("WALLET", "0x123", "first reason");
    await addBannedIdentity("WALLET", "0x123", "updated reason");

    const banned = await prisma.bannedIdentity.findUnique({
      where: { identifierType_identifierValue: { identifierType: "WALLET", identifierValue: "0x123" } },
    });
    expect(banned!.reason).toBe("updated reason");
  });
});
