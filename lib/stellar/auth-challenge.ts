// Wallet sign-in challenges (#25): prove control of a Stellar address, without
// an email/password session, by signing a one-time server challenge.
//
// The signed format and its bindings were settled on the real Freighter
// extension by #24 (docs/superpowers/specs/2026-09-14-freighter-wallet-signing-design.md).
// This module is that proof made durable: the harness kept challenges in
// process memory, but `web` can run more than one process and restarts lose
// memory, so production keeps them in `wallet_nonces`, tagged with
// PROOF_ACTION so the payout-link flow's rows are never touched.
import { randomBytes } from "crypto";
import prisma from "../prisma";
import { Prisma, type PrismaClient } from "@/app/generated/prisma/client";
import { networkPassphrase } from "./config";
import { isValidStellarAddress, verify } from "./signature";
import { CHALLENGE_TTL_MS, PROOF_ACTION, buildChallengeMessage } from "./challenge-message";

export interface IssuedSignInChallenge {
  nonce: string;
  message: string;
  expiresAt: Date;
}

type StoredSignInChallenge = {
  walletAddress: string;
  networkPassphrase: string | null;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
};

/** Rebuild the public challenge response from the row that won issuance. */
function issuedChallengeFrom(row: StoredSignInChallenge): IssuedSignInChallenge {
  if (!row.networkPassphrase) {
    throw new Error("issueSignInChallenge: stored sign-in challenge has no network passphrase");
  }
  const fields = {
    address: row.walletAddress,
    networkPassphrase: row.networkPassphrase,
    nonce: row.nonce,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
  };
  return { nonce: row.nonce, message: buildChallengeMessage(fields), expiresAt: row.expiresAt };
}

/**
 * Issue a sign-in challenge for `address`.
 *
 * Reuses an earlier live sign-in challenge for the same address, so concurrent
 * callers all receive the one row protected by the database constraint. It
 * prunes expired rows before creating a replacement. Payout-link challenges
 * that have not expired are left alone.
 */
export async function issueSignInChallenge(
  address: string,
  now?: Date,
): Promise<IssuedSignInChallenge> {
  // Callers validate first; this is the backstop. Never normalize: StrKey is
  // case-sensitive, and a lowercased key is a different, invalid key.
  if (!isValidStellarAddress(address)) {
    throw new Error("issueSignInChallenge: address is not a valid Stellar G… key");
  }

  const passphrase = networkPassphrase();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const issuedAt = now ?? new Date();
    const fields = {
      address,
      networkPassphrase: passphrase,
      nonce: randomBytes(16).toString("hex"),
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + CHALLENGE_TTL_MS),
    };

    await prisma.walletNonce.deleteMany({
      where: {
        OR: [
          { expiresAt: { lte: issuedAt } },
          {
            walletAddress: address,
            action: PROOF_ACTION,
            NOT: { networkPassphrase: passphrase },
          },
        ],
      },
    });

    try {
      const row = await prisma.walletNonce.create({
        data: {
          walletAddress: fields.address,
          action: PROOF_ACTION,
          networkPassphrase: fields.networkPassphrase,
          nonce: fields.nonce,
          issuedAt: fields.issuedAt,
          expiresAt: fields.expiresAt,
        },
      });
      return issuedChallengeFrom(row);
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      const readAt = now ?? new Date();
      const committed = await prisma.walletNonce.findFirst({
        where: {
          walletAddress: address,
          action: PROOF_ACTION,
          networkPassphrase: passphrase,
          expiresAt: { gt: readAt },
        },
      });
      if (committed) return issuedChallengeFrom(committed);
      if (attempt === 2) throw err;
    }
  }

  throw new Error("issueSignInChallenge: unreachable");
}

export type SignInRejection =
  | "challenge_not_found"
  | "challenge_expired"
  | "wrong_address"
  | "wrong_network"
  | "wrong_signer"
  | "bad_signature";

export type SignInProofResult =
  | { ok: true; address: string }
  | { ok: false; reason: SignInRejection };

/**
 * Verify a sign-in proof, consuming its challenge only if the proof is accepted.
 *
 * A challenge's nonce is not a secret: issuance hands the one live row for an
 * address to anyone who asks for it. So a rejected proof must not use the
 * challenge up, or anyone could request a contributor's challenge and post a bad
 * signature against it while they sign, failing their attempt every time. A
 * rejection leaves the row for the real signer; an expired one is removed, as
 * it can no longer be used by anyone.
 *
 * Every check runs against a read of the row. Access is granted by one
 * conditional delete of that nonce, still for this address and still live, after
 * the signature verifies: two concurrent accepted attempts race on that delete,
 * exactly one removes the row, and the other is refused. A replay finds no row.
 *
 * The signed message is rebuilt from the stored row, never from anything the
 * client sent.
 */
export async function consumeSignInChallenge({
  address,
  nonce,
  signature,
  signerAddress,
  now = new Date(),
}: {
  address: string;
  nonce: string;
  signature: string;
  signerAddress?: string;
  now?: Date;
}): Promise<SignInProofResult> {
  const row = await prisma.walletNonce.findUnique({ where: { nonce } });
  if (!row || row.action !== PROOF_ACTION) return { ok: false, reason: "challenge_not_found" };

  if (now.getTime() >= row.expiresAt.getTime()) {
    await prisma.walletNonce.deleteMany({ where: { nonce, action: PROOF_ACTION, expiresAt: { lte: now } } });
    return { ok: false, reason: "challenge_expired" };
  }
  if (row.walletAddress !== address) return { ok: false, reason: "wrong_address" };

  const passphrase = networkPassphrase();
  if (row.networkPassphrase !== passphrase) return { ok: false, reason: "wrong_network" };

  if (signerAddress !== undefined && signerAddress !== address) {
    return { ok: false, reason: "wrong_signer" };
  }

  const message = buildChallengeMessage({
    address: row.walletAddress,
    networkPassphrase: passphrase,
    nonce: row.nonce,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
  });
  if (!verify(address, message, signature)) return { ok: false, reason: "bad_signature" };

  const consumed = await prisma.walletNonce.deleteMany({
    where: { nonce, action: PROOF_ACTION, walletAddress: address, expiresAt: { gt: now } },
  });
  if (consumed.count === 0) return { ok: false, reason: "challenge_not_found" };

  return { ok: true, address };
}

/**
 * Let an email account claim an address held by an account nobody has used.
 *
 * A legacy email contributor who presses "Connect Freighter" on the sign-in
 * screen, rather than signing in with email and claiming, gets a new wallet-only
 * account holding their address (see {@link findOrCreateWalletUser}). Claiming
 * that address from the email account then failed `address_already_linked`, and
 * signing in with the wallet opened the empty account, so the email account's
 * balance could not be reached.
 *
 * The caller has just verified the claimant's proof of `address`. When the
 * account holding it is wallet-only (no email or password) and has nothing to
 * lose — no submissions, earnings, balance, ledger entries, withdrawals, flags,
 * disputes or bans — it is deleted and the address is bound to `claimantId`, in
 * one transaction that first locks the holder's row. Its sponsorship rows move
 * to the claimant: the reserve they record is locked for this address whoever
 * holds it, and #29 protects it as the claimant's linked wallet. Its onboarding
 * answers go with it. Its session, keyed on the deleted id, stops resolving.
 *
 * Returns false, writing nothing, when the claimant is not an email account that
 * can take a wallet, or the holder is anything but such an unused account.
 */
export async function takeOverUnusedWalletAccount(address: string, claimantId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const claimant = await tx.user.findUnique({
      where: { id: claimantId },
      select: { email: true, walletAddress: true },
    });
    if (!claimant?.email) return false;
    if (claimant.walletAddress && !claimant.walletAddress.startsWith("0x")) return false;

    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM users WHERE "walletAddress" = ${address} FOR UPDATE
    `;
    const holderId = locked[0]?.id;
    if (!holderId || holderId === claimantId) return false;

    const holder = await tx.user.findUnique({
      where: { id: holderId },
      select: {
        email: true,
        passwordHash: true,
        submissionCount: true,
        goldAttempted: true,
        totalEarnedUnits: true,
        pendingBalanceUnits: true,
        isBanned: true,
        banCount: true,
        _count: {
          select: { submissions: true, disputes: true, balanceLedger: true, payoutJobs: true, flaggedWithdrawals: true },
        },
      },
    });
    const unused =
      holder !== null &&
      holder.email === null &&
      holder.passwordHash === null &&
      holder.submissionCount === 0 &&
      holder.goldAttempted === 0 &&
      holder.totalEarnedUnits === 0n &&
      holder.pendingBalanceUnits === 0n &&
      !holder.isBanned &&
      holder.banCount === 0 &&
      Object.values(holder._count).every((count) => count === 0);
    if (!unused) return false;

    await tx.sponsoredTrustline.updateMany({ where: { userId: holderId }, data: { userId: claimantId } });
    await tx.user.delete({ where: { id: holderId } });
    const bound = await tx.user.updateMany({
      where: { id: claimantId, OR: [{ walletAddress: null }, { walletAddress: { startsWith: "0x" } }] },
      data: { walletAddress: address },
    });
    if (bound.count !== 1) throw new Error("takeOverUnusedWalletAccount: claimant changed during takeover");
    return true;
  });
}

/** The slice of Prisma `findOrCreateWalletUser` uses, so the race path is testable. */
export type WalletUserClient = { user: Pick<PrismaClient["user"], "findUnique" | "create"> };

/**
 * Resolve a proven Stellar address to exactly one contributor.
 *
 * The `User` holding the address wins, including an email account that linked
 * it through `/api/me/wallet`. Otherwise a wallet-only `User` is created.
 * `User.walletAddress` is `@unique`, so when two first sign-ins race, one create
 * fails with P2002 and resolves to the row the other created: one address never
 * becomes two identities.
 *
 * Find-then-create rather than `upsert`: Prisma may run an upsert as a native
 * `INSERT … ON CONFLICT`, which cannot report whether it created the row.
 */
export async function findOrCreateWalletUser(
  walletAddress: string,
  client: WalletUserClient = prisma,
): Promise<{ id: string; created: boolean }> {
  const existing = await client.user.findUnique({ where: { walletAddress }, select: { id: true } });
  if (existing) return { id: existing.id, created: false };

  try {
    const user = await client.user.create({ data: { walletAddress }, select: { id: true } });
    return { id: user.id, created: true };
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    const winner = await client.user.findUnique({ where: { walletAddress }, select: { id: true } });
    if (!winner) throw err;
    return { id: winner.id, created: false };
  }
}
