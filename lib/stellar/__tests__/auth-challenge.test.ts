import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { Prisma } from "@/app/generated/prisma/client";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { sep53Digest } from "@/lib/stellar/signature";
import {
  CHALLENGE_TTL_MS,
  PROOF_ACTION,
  WALLET_LINK_ACTION,
  buildChallengeMessage,
} from "@/lib/stellar/challenge-message";
import {
  consumeSignInChallenge,
  findOrCreateWalletUser,
  issueSignInChallenge,
  takeOverUnusedWalletAccount,
  type WalletUserClient,
} from "@/lib/stellar/auth-challenge";

// Real database: the one-time delete, the action scoping and the unique index
// are the properties under test, and a mocked Prisma cannot prove any of them.

const ORIGINAL_NETWORK = process.env.STELLAR_NETWORK;

beforeEach(async () => {
  process.env.STELLAR_NETWORK = "testnet";
  await truncateAll();
});

afterEach(() => {
  if (ORIGINAL_NETWORK === undefined) delete process.env.STELLAR_NETWORK;
  else process.env.STELLAR_NETWORK = ORIGINAL_NETWORK;
});

/** Sign exactly what Freighter's SEP-53 `signMessage` signs. */
const sign = (keypair: Keypair, message: string) =>
  keypair.sign(sep53Digest(message)).toString("base64");

/** Count sign-in challenges without including the wallet-link flow. */
const signInRows = (walletAddress: string) =>
  prisma.walletNonce.count({ where: { walletAddress, action: PROOF_ACTION } });

/** Seed a payout-link challenge to exercise action isolation. */
async function seedLinkChallenge(walletAddress: string, expiresAt: Date) {
  return prisma.walletNonce.create({
    data: {
      walletAddress,
      action: WALLET_LINK_ACTION,
      nonce: `link-${Keypair.random().publicKey().slice(1, 20)}`,
      expiresAt,
    },
  });
}

describe("issueSignInChallenge", () => {
  it("issues the #24 message and stores everything needed to rebuild it", async () => {
    const kp = Keypair.random();
    const now = new Date("2026-09-14T06:00:00.000Z");

    const challenge = await issueSignInChallenge(kp.publicKey(), now);

    expect(challenge.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(challenge.expiresAt.getTime()).toBe(now.getTime() + CHALLENGE_TTL_MS);
    expect(challenge.message).toBe(
      buildChallengeMessage({
        address: kp.publicKey(),
        networkPassphrase: Networks.TESTNET,
        nonce: challenge.nonce,
        issuedAt: now,
        expiresAt: challenge.expiresAt,
      }),
    );

    const row = await prisma.walletNonce.findUniqueOrThrow({ where: { nonce: challenge.nonce } });
    expect(row).toMatchObject({
      walletAddress: kp.publicKey(),
      action: PROOF_ACTION,
      networkPassphrase: Networks.TESTNET,
      issuedAt: now,
      expiresAt: challenge.expiresAt,
    });
  });

  it("keeps one outstanding sign-in challenge per address", async () => {
    const address = Keypair.random().publicKey();
    const first = await issueSignInChallenge(address);
    const second = await issueSignInChallenge(address);

    expect(await signInRows(address)).toBe(1);
    expect(second).toEqual(first);
    expect(await prisma.walletNonce.findUnique({ where: { nonce: first.nonce } })).not.toBeNull();
  });

  it("returns one committed challenge when issuers race for the same address", async () => {
    const address = Keypair.random().publicKey();

    const challenges = await Promise.all([
      issueSignInChallenge(address),
      issueSignInChallenge(address),
      issueSignInChallenge(address),
    ]);

    expect(await signInRows(address)).toBe(1);
    expect(new Set(challenges.map((challenge) => challenge.nonce))).toHaveLength(1);
  });

  it("replaces a live challenge that was issued for a different network", async () => {
    const address = Keypair.random().publicKey();
    const testnet = await issueSignInChallenge(address);

    process.env.STELLAR_NETWORK = "public";
    const publicNetwork = await issueSignInChallenge(address);

    expect(publicNetwork.nonce).not.toBe(testnet.nonce);
    expect(publicNetwork.message).toContain(`Network: ${Networks.PUBLIC}`);
    expect(await signInRows(address)).toBe(1);
  });

  it("replaces a challenge at its exact expiration timestamp", async () => {
    const address = Keypair.random().publicKey();
    const first = await issueSignInChallenge(address, new Date("2026-09-14T06:00:00.000Z"));

    const replacement = await issueSignInChallenge(address, first.expiresAt);

    expect(replacement.nonce).not.toBe(first.nonce);
    expect(await signInRows(address)).toBe(1);
  });

  it("leaves the same address's pending payout-link challenge alone", async () => {
    const address = Keypair.random().publicKey();
    const link = await seedLinkChallenge(address, new Date(Date.now() + CHALLENGE_TTL_MS));

    await issueSignInChallenge(address);

    expect(await prisma.walletNonce.findUnique({ where: { id: link.id } })).not.toBeNull();
  });

  it("prunes expired challenges of either action", async () => {
    const stale = await seedLinkChallenge(Keypair.random().publicKey(), new Date(Date.now() - 1000));

    await issueSignInChallenge(Keypair.random().publicKey());

    expect(await prisma.walletNonce.findUnique({ where: { id: stale.id } })).toBeNull();
  });

  it("refuses an address that is not a valid G… key, including a lowercased one", async () => {
    const address = Keypair.random().publicKey();
    await expect(issueSignInChallenge(address.toLowerCase())).rejects.toThrow();
    await expect(issueSignInChallenge("0xdeadbeef")).rejects.toThrow();
    expect(await prisma.walletNonce.count()).toBe(0);
  });
});

describe("consumeSignInChallenge", () => {
  async function issued(kp = Keypair.random(), now = new Date()) {
    const challenge = await issueSignInChallenge(kp.publicKey(), now);
    return { kp, address: kp.publicKey(), now, ...challenge };
  }

  it("accepts a valid proof and consumes the challenge", async () => {
    const c = await issued();
    const result = await consumeSignInChallenge({
      address: c.address,
      nonce: c.nonce,
      signature: sign(c.kp, c.message),
      signerAddress: c.address,
    });

    expect(result).toEqual({ ok: true, address: c.address });
    expect(await signInRows(c.address)).toBe(0);
  });

  it("refuses a replay of an accepted proof", async () => {
    const c = await issued();
    const proof = { address: c.address, nonce: c.nonce, signature: sign(c.kp, c.message) };

    expect((await consumeSignInChallenge(proof)).ok).toBe(true);
    expect(await consumeSignInChallenge(proof)).toEqual({ ok: false, reason: "challenge_not_found" });
  });

  it("refuses an unknown nonce", async () => {
    const c = await issued();
    const result = await consumeSignInChallenge({
      address: c.address,
      nonce: "f".repeat(32),
      signature: sign(c.kp, c.message),
    });
    expect(result).toEqual({ ok: false, reason: "challenge_not_found" });
  });

  it("cannot consume a payout-link challenge, and leaves it in place", async () => {
    const kp = Keypair.random();
    const link = await seedLinkChallenge(kp.publicKey(), new Date(Date.now() + CHALLENGE_TTL_MS));

    const result = await consumeSignInChallenge({
      address: kp.publicKey(),
      nonce: link.nonce,
      signature: sign(kp, "anything"),
    });

    expect(result).toEqual({ ok: false, reason: "challenge_not_found" });
    expect(await prisma.walletNonce.findUnique({ where: { id: link.id } })).not.toBeNull();
  });

  it("refuses an expired challenge, and consumes it", async () => {
    const c = await issued();
    const result = await consumeSignInChallenge({
      address: c.address,
      nonce: c.nonce,
      signature: sign(c.kp, c.message),
      now: new Date(c.expiresAt.getTime() + 1),
    });

    expect(result).toEqual({ ok: false, reason: "challenge_expired" });
    expect(await signInRows(c.address)).toBe(0);
  });

  it("refuses a challenge at its exact expiration timestamp", async () => {
    const c = await issued();
    const result = await consumeSignInChallenge({
      address: c.address,
      nonce: c.nonce,
      signature: sign(c.kp, c.message),
      now: c.expiresAt,
    });

    expect(result).toEqual({ ok: false, reason: "challenge_expired" });
    expect(await signInRows(c.address)).toBe(0);
  });

  it("checks expiry before the address", async () => {
    const c = await issued();
    const other = Keypair.random();
    const result = await consumeSignInChallenge({
      address: other.publicKey(),
      nonce: c.nonce,
      signature: sign(other, c.message),
      now: new Date(c.expiresAt.getTime() + 1),
    });
    expect(result).toEqual({ ok: false, reason: "challenge_expired" });
  });

  it("refuses a proof for a different address than the challenge was issued to", async () => {
    const c = await issued();
    const other = Keypair.random();
    const result = await consumeSignInChallenge({
      address: other.publicKey(),
      nonce: c.nonce,
      signature: sign(other, c.message),
    });
    expect(result).toEqual({ ok: false, reason: "wrong_address" });
    expect(await signInRows(c.address)).toBe(1);
  });

  it("compares the address exactly: a lowercased address is a different address", async () => {
    const c = await issued();
    const result = await consumeSignInChallenge({
      address: c.address.toLowerCase(),
      nonce: c.nonce,
      signature: sign(c.kp, c.message),
    });
    expect(result).toEqual({ ok: false, reason: "wrong_address" });
  });

  it("refuses a challenge issued on another network", async () => {
    const c = await issued();
    process.env.STELLAR_NETWORK = "public";
    const result = await consumeSignInChallenge({
      address: c.address,
      nonce: c.nonce,
      signature: sign(c.kp, c.message),
    });
    expect(result).toEqual({ ok: false, reason: "wrong_network" });
  });

  it("refuses when the wallet reports a different signer", async () => {
    const c = await issued();
    const result = await consumeSignInChallenge({
      address: c.address,
      nonce: c.nonce,
      signature: sign(c.kp, c.message),
      signerAddress: Keypair.random().publicKey(),
    });
    expect(result).toEqual({ ok: false, reason: "wrong_signer" });
  });

  describe("bad signatures", () => {
    const cases: Array<[string, (kp: Keypair, message: string) => string]> = [
      ["signed by a different key", (_kp, message) => sign(Keypair.random(), message)],
      [
        "signed over the raw message instead of the SEP-53 digest",
        (kp, message) => kp.sign(Buffer.from(message, "utf8")).toString("base64"),
      ],
      [
        "bit-flipped",
        (kp, message) => {
          const bytes = Buffer.from(sign(kp, message), "base64");
          bytes[0] ^= 0x01;
          return bytes.toString("base64");
        },
      ],
      [
        "truncated",
        (kp, message) => Buffer.from(sign(kp, message), "base64").subarray(0, 63).toString("base64"),
      ],
      ["not base64 at all", () => "not a signature!!"],
    ];

    it.each(cases)("refuses a signature %s, and leaves the challenge in place", async (_name, forge) => {
      const c = await issued();
      const result = await consumeSignInChallenge({
        address: c.address,
        nonce: c.nonce,
        signature: forge(c.kp, c.message),
      });
      expect(result).toEqual({ ok: false, reason: "bad_signature" });
      expect(await signInRows(c.address)).toBe(1);
    });
  });

  // PR #105 review: issuance hands the live nonce to anyone who asks, so a
  // rejection that consumed the row would let a stranger fail every attempt.
  it.each([
    ["a bad signature", (c: Awaited<ReturnType<typeof issued>>) => ({
      address: c.address,
      nonce: c.nonce,
      signature: sign(Keypair.random(), c.message),
    })],
    ["another address", (c: Awaited<ReturnType<typeof issued>>) => {
      const other = Keypair.random();
      return { address: other.publicKey(), nonce: c.nonce, signature: sign(other, c.message) };
    }],
    ["a different reported signer", (c: Awaited<ReturnType<typeof issued>>) => ({
      address: c.address,
      nonce: c.nonce,
      signature: sign(c.kp, c.message),
      signerAddress: Keypair.random().publicKey(),
    })],
  ])("lets the real signer through after a stranger posts %s against their challenge", async (_name, forged) => {
    const c = await issued();
    const stranger = await issueSignInChallenge(c.address);
    expect(stranger.nonce).toBe(c.nonce);

    expect((await consumeSignInChallenge(forged(c))).ok).toBe(false);

    expect(
      await consumeSignInChallenge({ address: c.address, nonce: c.nonce, signature: sign(c.kp, c.message) }),
    ).toEqual({ ok: true, address: c.address });
    expect(await signInRows(c.address)).toBe(0);
  });

  it("accepts exactly one of two concurrent valid proofs for one challenge", async () => {
    const c = await issued();
    const proof = { address: c.address, nonce: c.nonce, signature: sign(c.kp, c.message) };

    const results = await Promise.all([consumeSignInChallenge(proof), consumeSignInChallenge(proof)]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "challenge_not_found" }]);
  });
});

describe("takeOverUnusedWalletAccount (PR #105 review)", () => {
  /** A legacy email account with a balance and no wallet, and the empty account a wallet sign-in made for its address. */
  async function accidentalSignIn() {
    const address = Keypair.random().publicKey();
    const claimant = await prisma.user.create({
      data: { email: `legacy-${address.slice(1, 9)}@example.com`, passwordHash: "x", pendingBalanceUnits: 7n },
    });
    const holder = await findOrCreateWalletUser(address);
    expect(holder.created).toBe(true);
    return { address, claimant, holderId: holder.id };
  }

  it("binds the address to the email account and removes the empty wallet-only account", async () => {
    const { address, claimant, holderId } = await accidentalSignIn();

    expect(await takeOverUnusedWalletAccount(address, claimant.id)).toBe(true);

    expect(await prisma.user.findUnique({ where: { id: holderId } })).toBeNull();
    expect(await prisma.user.findUniqueOrThrow({ where: { id: claimant.id } })).toMatchObject({
      walletAddress: address,
      pendingBalanceUnits: 7n,
    });
    // From now on, signing in with the wallet opens the email account and its balance.
    expect(await findOrCreateWalletUser(address)).toEqual({ id: claimant.id, created: false });
  });

  it("moves the empty account's sponsorship to the claimant, keeping the reserve on the ledger", async () => {
    const { address, claimant, holderId } = await accidentalSignIn();
    const row = await prisma.sponsoredTrustline.create({
      data: { userId: holderId, address, kind: "account+trustline", txHash: "H1", confirmedAt: new Date() },
    });

    expect(await takeOverUnusedWalletAccount(address, claimant.id)).toBe(true);

    expect(await prisma.sponsoredTrustline.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      userId: claimant.id,
      revokedAt: null,
    });
  });

  it("replaces a legacy 0x wallet on the email account", async () => {
    const { address, claimant } = await accidentalSignIn();
    await prisma.user.update({ where: { id: claimant.id }, data: { walletAddress: `0x${"ab".repeat(20)}` } });

    expect(await takeOverUnusedWalletAccount(address, claimant.id)).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: claimant.id } })).walletAddress).toBe(address);
  });

  it.each<[string, Record<string, unknown>]>([
    ["has an email", { email: "wallet-holder@example.com" }],
    ["has a password", { passwordHash: "x" }],
    ["has submitted work", { submissionCount: 1 }],
    ["has attempted gold tasks", { goldAttempted: 1 }],
    ["has earned", { totalEarnedUnits: 1n }],
    ["holds a balance", { pendingBalanceUnits: 1n }],
    ["is banned", { isBanned: true, banCount: 1 }],
    ["was banned before", { banCount: 1 }],
  ])("leaves the holder alone, and binds nothing, when it %s", async (_label, data) => {
    const { address, claimant, holderId } = await accidentalSignIn();
    await prisma.user.update({ where: { id: holderId }, data });

    expect(await takeOverUnusedWalletAccount(address, claimant.id)).toBe(false);

    expect((await prisma.user.findUniqueOrThrow({ where: { id: holderId } })).walletAddress).toBe(address);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: claimant.id } })).walletAddress).toBeNull();
  });

  it("refuses a claimant that is not an email account, or already holds a Stellar wallet", async () => {
    const { address, holderId } = await accidentalSignIn();
    const walletOnly = await prisma.user.create({ data: {} });
    const bound = await prisma.user.create({
      data: { email: "bound@example.com", walletAddress: Keypair.random().publicKey() },
    });

    expect(await takeOverUnusedWalletAccount(address, walletOnly.id)).toBe(false);
    expect(await takeOverUnusedWalletAccount(address, bound.id)).toBe(false);
    expect(await prisma.user.findUnique({ where: { id: holderId } })).not.toBeNull();
  });

  it("does nothing when no account holds the address, or the claimant already does", async () => {
    const { address, claimant, holderId } = await accidentalSignIn();
    expect(await takeOverUnusedWalletAccount(Keypair.random().publicKey(), claimant.id)).toBe(false);
    expect(await takeOverUnusedWalletAccount(address, holderId)).toBe(false);
  });
});

describe("findOrCreateWalletUser", () => {
  it("resolves an existing wallet-only contributor to itself", async () => {
    const walletAddress = Keypair.random().publicKey();
    const existing = await prisma.user.create({ data: { walletAddress }, select: { id: true } });

    expect(await findOrCreateWalletUser(walletAddress)).toEqual({ id: existing.id, created: false });
  });

  it("resolves an email account that linked the address to that account", async () => {
    const walletAddress = Keypair.random().publicKey();
    const emailUser = await prisma.user.create({
      data: { email: "linked@example.com", passwordHash: "x", isVerified: true, walletAddress },
      select: { id: true },
    });

    expect(await findOrCreateWalletUser(walletAddress)).toEqual({ id: emailUser.id, created: false });
  });

  it("creates exactly one wallet-only contributor for an unknown address", async () => {
    const walletAddress = Keypair.random().publicKey();

    const result = await findOrCreateWalletUser(walletAddress);

    expect(result.created).toBe(true);
    const users = await prisma.user.findMany({ where: { walletAddress } });
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ id: result.id, email: null, passwordHash: null });
  });

  it("never splits one address into two contributors under concurrent first sign-ins", async () => {
    const walletAddress = Keypair.random().publicKey();

    const results = await Promise.all([
      findOrCreateWalletUser(walletAddress),
      findOrCreateWalletUser(walletAddress),
      findOrCreateWalletUser(walletAddress),
    ]);

    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await prisma.user.count({ where: { walletAddress } })).toBe(1);
  });

  it("falls back to the winning row when its create loses the unique-index race", async () => {
    const findUnique = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "winner" });
    const create = vi.fn().mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    const client = { user: { findUnique, create } } as unknown as WalletUserClient;

    const result = await findOrCreateWalletUser(Keypair.random().publicKey(), client);

    expect(result).toEqual({ id: "winner", created: false });
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("rethrows any other create failure", async () => {
    const boom = new Error("connection reset");
    const client = {
      user: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockRejectedValue(boom) },
    } as unknown as WalletUserClient;

    await expect(findOrCreateWalletUser(Keypair.random().publicKey(), client)).rejects.toBe(boom);
  });
});
