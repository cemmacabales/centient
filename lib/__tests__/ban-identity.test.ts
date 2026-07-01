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

// ST-4d — the fraud controls now operate on Stellar `G…` StrKey addresses, which
// are **case-sensitive base32**. Every address below is a real, valid StrKey so
// the validation helper (StrKey.isValidEd25519PublicKey) accepts it; lowercasing
// any of them corrupts it into an invalid address. The old code lowercased wallet
// values, which silently broke matching once addresses became case-significant.
const BANNED_WALLET = "GDJ3LPVCSFVJHBTX47I7OBG2ZK2ZH3KQAHAHMNTJW3JLSLZUWC4OQQ7P";
const SHARED_WALLET = "GAX7VLUK2MZAQJ5JNRTUFSYO677CF642STTPECUJYCOZ3AD5BQS45SQZ";
const USER_WALLETS = [
  "GCPE6PVCMTWNN3M3LSUW5NBLMDAF7OYK5ITU7VWVHC6PUQKOZ4V6ZQXD",
  "GB4PQVRZKT6IJF4XFTXS553JYFL2LC2HOML2N3YOGZUXPW42ERBNFSGV",
  "GCKPZ3UTFJAAMPWA2INEQKPQNLLI7EEI7QKQ6FVWV2ETRPVIJWM3AXE7",
  "GADPVKQTFTGCCTHEEVU5SVBBVRPHV7PPSQROHSBEZPYNYSZEVAPTMQDU",
];

beforeEach(async () => {
  await truncateAll();
});

describe("isAnyIdentifierBanned", () => {
  it("returns null when no identifiers are banned", async () => {
    const result = await isAnyIdentifierBanned("test@example.com", BANNED_WALLET, "user-123");
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

    const result = await isAnyIdentifierBanned("banned@example.com", BANNED_WALLET, "user-123");

    expect(result).toBeInstanceOf(BannedIdentityError);
    expect(result!.bannedIdentifierType).toBe("EMAIL");
    expect(result!.identifierValue).toBe("banned@example.com");
    expect(result!.reason).toBe("spam");
  });

  it("returns BannedIdentityError when wallet is banned", async () => {
    await prisma.bannedIdentity.create({
      data: {
        identifierType: "WALLET",
        identifierValue: BANNED_WALLET,
        reason: "fraud",
      },
    });

    const result = await isAnyIdentifierBanned("test@example.com", BANNED_WALLET, "user-123");

    expect(result).toBeInstanceOf(BannedIdentityError);
    expect(result!.bannedIdentifierType).toBe("WALLET");
    expect(result!.identifierValue).toBe(BANNED_WALLET);
  });

  // Regression for the ST-4d hazard: a banned `G…` StrKey with uppercase chars
  // must still match. Under the old `.toLowerCase()` on the lookup value the
  // stored (case-preserved) ban and the lowercased lookup never compared equal,
  // so the Sybil/ban defense was silently dead.
  it("matches a banned case-sensitive G… StrKey without lowercasing it", async () => {
    expect(BANNED_WALLET).not.toBe(BANNED_WALLET.toLowerCase()); // guard: address has case

    await prisma.bannedIdentity.create({
      data: {
        identifierType: "WALLET",
        identifierValue: BANNED_WALLET,
        reason: "sybil",
      },
    });

    const result = await isAnyIdentifierBanned("test@example.com", BANNED_WALLET, "user-123");

    expect(result).toBeInstanceOf(BannedIdentityError);
    expect(result!.identifierValue).toBe(BANNED_WALLET);
  });

  // StrKey is exact-match, never case-folded: a lowercased variant of a banned
  // address is a *different* (in fact invalid) address and must not match.
  it("does not match a lowercased (corrupted) variant of a banned G… address", async () => {
    await prisma.bannedIdentity.create({
      data: {
        identifierType: "WALLET",
        identifierValue: BANNED_WALLET,
        reason: "sybil",
      },
    });

    const result = await isAnyIdentifierBanned(
      "test@example.com",
      BANNED_WALLET.toLowerCase(),
      "user-123",
    );

    expect(result).toBeNull();
  });

  it("returns BannedIdentityError when userId is banned", async () => {
    await prisma.bannedIdentity.create({
      data: {
        identifierType: "USER_ID",
        identifierValue: "banned-user-id",
        reason: "abuse",
      },
    });

    const result = await isAnyIdentifierBanned("test@example.com", BANNED_WALLET, "banned-user-id");

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

    const result = await isAnyIdentifierBanned("old@example.com", BANNED_WALLET, "user-123");

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

    const result = await isAnyIdentifierBanned("test@example.com", BANNED_WALLET, "user-123");

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
  it("returns null when wallet has received from fewer than MAX_SHARED_WALLET_ACCOUNTS accounts", async () => {
    const users = await Promise.all(
      Array.from({ length: MAX_SHARED_WALLET_ACCOUNTS - 1 }, (_, i) =>
        prisma.user.create({
          data: {
            walletAddress: USER_WALLETS[i],
            pendingBalanceUnits: 0n,
          },
        }),
      ),
    );

    for (const user of users) {
      await prisma.payoutJob.create({
        data: {
          type: "WITHDRAWAL",
          userId: user.id,
          amountUnits: 1000000000000000000n,
          destinationAddress: SHARED_WALLET,
          status: "done",
        },
      });
    }

    const result = await checkSharedWallet(SHARED_WALLET);
    expect(result).toBeNull();
  });

  it("returns SharedWalletError with the case-preserved G… address when the threshold is hit", async () => {
    const users = await Promise.all(
      Array.from({ length: MAX_SHARED_WALLET_ACCOUNTS }, (_, i) =>
        prisma.user.create({
          data: {
            walletAddress: USER_WALLETS[i],
            pendingBalanceUnits: 0n,
          },
        }),
      ),
    );

    for (const user of users) {
      await prisma.payoutJob.create({
        data: {
          type: "WITHDRAWAL",
          userId: user.id,
          amountUnits: 1000000000000000000n,
          destinationAddress: SHARED_WALLET,
          status: "done",
        },
      });
    }

    const result = await checkSharedWallet(SHARED_WALLET);

    expect(result).toBeInstanceOf(SharedWalletError);
    // Raw StrKey, NOT lowercased — otherwise the surfaced address would be invalid.
    expect(result!.walletAddress).toBe(SHARED_WALLET);
    expect(result!.accountCount).toBe(MAX_SHARED_WALLET_ACCOUNTS);
  });

  it("excludes current user from count", async () => {
    const currentUser = await prisma.user.create({
      data: {
        walletAddress: USER_WALLETS[MAX_SHARED_WALLET_ACCOUNTS - 1],
        pendingBalanceUnits: 0n,
      },
    });

    const otherUsers = await Promise.all(
      Array.from({ length: MAX_SHARED_WALLET_ACCOUNTS - 1 }, (_, i) =>
        prisma.user.create({
          data: {
            walletAddress: USER_WALLETS[i],
            pendingBalanceUnits: 0n,
          },
        }),
      ),
    );

    for (const user of otherUsers) {
      await prisma.payoutJob.create({
        data: {
          type: "WITHDRAWAL",
          userId: user.id,
          amountUnits: 1000000000000000000n,
          destinationAddress: SHARED_WALLET,
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
            walletAddress: USER_WALLETS[i],
            pendingBalanceUnits: 0n,
          },
        }),
      ),
    );

    for (const user of users) {
      await prisma.payoutJob.create({
        data: {
          type: "WITHDRAWAL",
          userId: user.id,
          amountUnits: 1000000000000000000n,
          destinationAddress: SHARED_WALLET,
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
    await addBannedIdentity("WALLET", BANNED_WALLET, "first reason");
    await addBannedIdentity("WALLET", BANNED_WALLET, "updated reason");

    const banned = await prisma.bannedIdentity.findUnique({
      where: { identifierType_identifierValue: { identifierType: "WALLET", identifierValue: BANNED_WALLET } },
    });
    expect(banned!.reason).toBe("updated reason");
  });

  // Store-path validation: a malformed `G…` StrKey must be rejected, not silently
  // stored as an un-matchable ban record.
  it("rejects a malformed WALLET StrKey on store", async () => {
    await expect(addBannedIdentity("WALLET", "not-a-real-stellar-address", "bad")).rejects.toThrow();

    const count = await prisma.bannedIdentity.count({ where: { identifierType: "WALLET" } });
    expect(count).toBe(0);
  });

  it("stores a WALLET StrKey case-preserved (no lowercasing)", async () => {
    await addBannedIdentity("WALLET", BANNED_WALLET, "fraud");

    const banned = await prisma.bannedIdentity.findUnique({
      where: {
        identifierType_identifierValue: { identifierType: "WALLET", identifierValue: BANNED_WALLET },
      },
    });
    expect(banned).not.toBeNull();
    expect(banned!.identifierValue).toBe(BANNED_WALLET);
  });
});
