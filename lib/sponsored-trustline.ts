// ST-4e follow-up (#330) — bound platform-sponsored USDC trustlines per labeler.
//
// Each successful sponsorship (CAP-33) locks ~0.5 XLM (trustline) or ~1.5 XLM
// (account creation + trustline) of the pooled platform account's reserves on a
// recipient's behalf. The sponsor route authenticates the session but the only
// spend-shaped throttle is a per-address rate limit — a labeler can loop fresh
// keypairs to bypass it and drive the platform toward `op_low_reserve`, halting
// ALL real USDC payouts (an economic DoS on mainnet). Reserves are recovered by
// reserve reclaim (#29, `lib/sponsorship-reclaim.ts`), which works from these rows.
//
// This module enforces two gates, backed by the `sponsored_trustlines` table:
//   1. a hard cap on OUTSTANDING sponsorships per user, and
//   2. a cross-user lock so an address already sponsored (outstanding) by one
//      user can't be re-sponsored by another.
//
// #27 adds the write order. A sponsorship is recorded as `pending` BEFORE its
// envelope is broadcast, because Horizon accepting it is irreversible while any
// write after it can still fail. "Outstanding" therefore means pending or
// confirmed and not revoked: a pending row's reserve may already be locked. A
// partial unique index allows one outstanding row per address, which makes the
// cross-user lock and duplicate protection hold under concurrency rather than
// only when requests happen to arrive one at a time.
//
// `address` is a case-sensitive `G…` StrKey and is never normalized/lowercased.
import prisma from "./prisma";

export type SponsorshipKind = "trustline" | "account+trustline";

/**
 * Base reserves a sponsorship locks on the sponsor: a sponsored account entry
 * takes two, a trustline one. Horizon's `num_sponsoring` counts the same units.
 */
export const SPONSORSHIP_RESERVE_UNITS: Readonly<Record<SponsorshipKind, number>> = {
  trustline: 1,
  "account+trustline": 3,
};

/** Rows whose reserve is, or may already be, locked on-chain. */
function outstanding() {
  return { revokedAt: null, status: { not: "failed" } };
}

/**
 * Max outstanding sponsored trustlines per labeler. A legitimate user links one
 * wallet and only occasionally re-links, so a small cap is ample; the default of
 * 2 leaves one headroom slot for a re-link before the old reserve is reclaimed.
 * Env-overridable so mainnet reserve sizing can be tuned without a deploy.
 */
export function sponsorMaxOutstanding(): number {
  const raw = Number(process.env.SPONSOR_MAX_OUTSTANDING ?? "2");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2;
}

/**
 * Count of this user's sponsorships whose reserves are, or may be, locked.
 * `exceptAddress` leaves one address out, so a retry for an address the user
 * already holds a pending row for is not counted against itself.
 */
export function countOutstandingSponsorships(userId: string, exceptAddress?: string): Promise<number> {
  return prisma.sponsoredTrustline.count({
    where: {
      userId,
      ...outstanding(),
      ...(exceptAddress ? { address: { not: exceptAddress } } : {}),
    },
  });
}

/** True iff `address` has an outstanding sponsorship owned by a *different* user. */
export async function addressSponsoredByOther(
  address: string,
  userId: string,
): Promise<boolean> {
  const row = await prisma.sponsoredTrustline.findFirst({
    where: { address, ...outstanding(), userId: { not: userId } },
    select: { id: true },
  });
  return row !== null;
}

export type SponsorGateResult =
  | { ok: true }
  | { ok: false; reason: "cap_reached" | "address_sponsored_by_other" };

/**
 * Pre-submit gate. Rejects when the address is already sponsored (outstanding)
 * by another user, or when this user already holds the cap's worth of
 * sponsorships for other addresses. Checked at both the build (GET) and submit
 * (POST) steps so an over-cap user never even receives an XDR. It reads before
 * it writes, so it is a courtesy under concurrency: the unique index behind
 * {@link openSponsorshipIntent} is what actually holds the address lock.
 */
export async function checkSponsorAllowed(
  userId: string,
  address: string,
): Promise<SponsorGateResult> {
  if (await addressSponsoredByOther(address, userId)) {
    return { ok: false, reason: "address_sponsored_by_other" };
  }
  if ((await countOutstandingSponsorships(userId, address)) >= sponsorMaxOutstanding()) {
    return { ok: false, reason: "cap_reached" };
  }
  return { ok: true };
}

/**
 * True while an earlier envelope for `address` is pending and could still land.
 * The build step uses it so a contributor is not asked to sign a second
 * envelope that the submit step would then refuse.
 */
export async function livePendingSponsorship(address: string, now: Date = new Date()): Promise<boolean> {
  const row = await prisma.sponsoredTrustline.findFirst({
    where: { address, revokedAt: null, status: "pending", expiresAt: { gt: now } },
    select: { id: true },
  });
  return row !== null;
}

/**
 * True while this user holds a confirmed, unreleased sponsorship of `address`.
 * The sponsor route leans on it only when Horizon cannot say whether the
 * trustline exists; a withdrawal always checks the chain itself.
 */
export async function hasConfirmedSponsorship(userId: string, address: string): Promise<boolean> {
  const row = await prisma.sponsoredTrustline.findFirst({
    where: { userId, address, status: "confirmed", revokedAt: null },
    select: { id: true },
  });
  return row !== null;
}

/** Horizon's view of a transaction hash — `getTxStatus` in production. */
export type TxStatusLookup = (hash: string) => Promise<"confirmed" | "failed" | "not_found">;

/** What the chain shows for an address — `readSponsorshipOnChain` in production. */
export type SponsorshipChainLookup = (address: string) => Promise<{
  /** The address holds a USDC trustline, whoever pays its reserve. */
  usdcTrustline: boolean;
  /** Its entries whose reserve the sponsor pays right now. */
  sponsoredEntries: Array<"trustline" | "account">;
}>;

export interface SponsorshipIntent {
  userId: string;
  address: string;
  kind: SponsorshipKind;
  /** Hash of the exact envelope about to be broadcast. */
  txHash: string;
  /** The envelope's `maxTime`; after it the envelope can no longer apply. */
  expiresAt: Date;
}

export type SponsorshipIntentDecision =
  /** Broadcast the envelope; settle row `id` with the result. */
  | { action: "submit"; id: string }
  /** This user's sponsorship of the address has already landed. Do not broadcast. */
  | { action: "already_confirmed" }
  /** An earlier envelope for the address could still land. Do not broadcast a second. */
  | { action: "prior_pending" }
  /** Another user holds the address. */
  | { action: "address_in_use" };

const INTENT_ATTEMPTS = 3;

/**
 * Record the intent to broadcast `intent.txHash`, and decide whether to.
 *
 * Re-broadcasting the identical envelope is safe — Horizon applies one hash at
 * most once — so a retry of the same hash is sent against the same row. A
 * *different* envelope for an address with a pending one is only allowed once
 * the earlier one provably cannot land: Horizon reports it failed, or it was
 * never seen and its time bound has passed. If Horizon shows the earlier one
 * landed, nothing new is broadcast.
 *
 * A `confirmed` row is only trusted while the chain still shows the trustline
 * (see {@link resetConfirmed}).
 *
 * A unique violation means another request claimed the address between this
 * read and this write; the decision is simply taken again against what it wrote.
 * A failed Horizon lookup propagates without writing anything.
 */
export async function openSponsorshipIntent(
  intent: SponsorshipIntent,
  opts: { txStatus: TxStatusLookup; chain: SponsorshipChainLookup; now?: Date },
): Promise<SponsorshipIntentDecision> {
  const now = opts.now ?? new Date();
  for (let attempt = 1; ; attempt++) {
    try {
      return await decideIntent(intent, opts, now);
    } catch (err) {
      if (!(isUniqueViolation(err) || err instanceof IntentRace) || attempt >= INTENT_ATTEMPTS) throw err;
    }
  }
}

/** A conditional write found the row changed since it was read; decide again. */
class IntentRace extends Error {}

/** One read-then-write pass of {@link openSponsorshipIntent}; a racing writer surfaces as P2002. */
async function decideIntent(
  intent: SponsorshipIntent,
  deps: { txStatus: TxStatusLookup; chain: SponsorshipChainLookup },
  now: Date,
): Promise<SponsorshipIntentDecision> {
  const current = await prisma.sponsoredTrustline.findFirst({
    where: { address: intent.address, ...outstanding() },
  });
  if (!current) return { action: "submit", id: await createPending(intent) };
  if (current.userId !== intent.userId) return { action: "address_in_use" };
  if (current.status === "confirmed") {
    const onChain = await deps.chain(intent.address);
    if (onChain.usdcTrustline) return { action: "already_confirmed" };
    return { action: "submit", id: await resetConfirmed(current, intent, onChain.sponsoredEntries) };
  }
  if (current.txHash === intent.txHash) return { action: "submit", id: current.id };

  const prior = await deps.txStatus(current.txHash);
  if (prior === "confirmed") {
    await confirmSponsorship(current.id, current.txHash);
    return { action: "already_confirmed" };
  }
  // A pending row always carries an expiry; one without is treated as expired
  // rather than blocking the address forever.
  const expired = !current.expiresAt || current.expiresAt.getTime() < now.getTime();
  if (prior === "not_found" && !expired) return { action: "prior_pending" };

  await failSponsorship(current.id, current.txHash);
  return { action: "submit", id: await createPending(intent) };
}

/**
 * A `confirmed` row whose USDC trustline is gone from the chain: the owner
 * removed it, or merged the account away, before reclaim (#29) noticed. Answering
 * `already_confirmed` would report setup done without broadcasting, while every
 * withdrawal kept failing `payout_setup_required`. Instead the row is reset and
 * the new envelope takes the normal submit path. Returns the row id to settle.
 *
 * - Nothing the row paid for is still sponsored: its reserve is already back, so
 *   the row is recorded released by its owner, as reclaim would record it, and
 *   the envelope gets a fresh pending row.
 * - The account is still sponsored (only the trustline went): its reserve is
 *   still locked, so releasing the row would understate the liability. The row
 *   itself is reopened as pending for the new envelope instead. It keeps its
 *   `confirmedAt`, which is how {@link failSponsorship} knows to return it to
 *   confirmed if that envelope never lands.
 *
 * A row carrying a reclaim intent is left alone. Every write is conditional on
 * the row still being as read; a concurrent change is decided again.
 */
async function resetConfirmed(
  current: { id: string; kind: string },
  intent: SponsorshipIntent,
  sponsoredEntries: Array<"trustline" | "account">,
): Promise<string> {
  const paidFor = current.kind === "account+trustline" ? ["trustline", "account"] : ["trustline"];
  const stillSponsored = sponsoredEntries.some((entry) => paidFor.includes(entry));
  const unchanged = { id: current.id, status: "confirmed", revokedAt: null, reclaimTxHash: null };

  if (!stillSponsored) {
    const released = await prisma.sponsoredTrustline.updateMany({
      where: unchanged,
      data: { revokedAt: new Date(), releasedBy: "owner" },
    });
    if (released.count === 0) throw new IntentRace("sponsorship row changed before its release");
    return createPending(intent);
  }

  const reopened = await prisma.sponsoredTrustline.updateMany({
    where: unchanged,
    data: { status: "pending", txHash: intent.txHash, expiresAt: intent.expiresAt },
  });
  if (reopened.count === 0) throw new IntentRace("sponsorship row changed before it was reopened");
  return current.id;
}

/** Insert the pending row for `intent` and return its id. The unique index may refuse it. */
async function createPending(intent: SponsorshipIntent): Promise<string> {
  const row = await prisma.sponsoredTrustline.create({
    data: { ...intent, status: "pending" },
    select: { id: true },
  });
  return row.id;
}

/** True for Prisma's unique-constraint violation (P2002). */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown })?.code === "P2002";
}

/**
 * Mark row `id` confirmed — only while it still carries `txHash`, so a late
 * result for a replaced envelope cannot settle its successor.
 */
export async function confirmSponsorship(id: string, txHash: string): Promise<void> {
  await prisma.sponsoredTrustline.updateMany({
    where: { id, txHash, status: { not: "confirmed" } },
    data: { status: "confirmed", confirmedAt: new Date() },
  });
}

/**
 * Release row `id` after a definite failure — only while it is still pending
 * with `txHash`. A confirmed sponsorship is never downgraded. A row that was
 * confirmed before, and reopened for a new envelope because its account is still
 * sponsored, goes back to confirmed rather than failed: that reserve is still
 * locked whatever became of the new envelope.
 */
export async function failSponsorship(id: string, txHash: string): Promise<void> {
  await prisma.sponsoredTrustline.updateMany({
    where: { id, txHash, status: "pending", confirmedAt: { not: null } },
    data: { status: "confirmed" },
  });
  await prisma.sponsoredTrustline.updateMany({
    where: { id, txHash, status: "pending", confirmedAt: null },
    data: { status: "failed" },
  });
}

export interface SponsorshipLiability {
  /** Outstanding sponsorships, pending included. */
  outstanding: number;
  /** Of those, how many have not been confirmed. */
  pending: number;
  /** Base reserves the ledger says are locked; compare with Horizon `num_sponsoring`. */
  reserveUnits: number;
  byKind: Record<SponsorshipKind, { confirmed: number; pending: number }>;
}

/**
 * The sponsor's reserve liability as the ledger records it. Wallet health sets
 * this beside Horizon's on-chain count, and reserve reclaim (#29) works from
 * the same rows.
 */
export async function sponsorshipLiability(): Promise<SponsorshipLiability> {
  const groups = await prisma.sponsoredTrustline.groupBy({
    by: ["kind", "status"],
    where: outstanding(),
    _count: { _all: true },
  });

  const liability: SponsorshipLiability = {
    outstanding: 0,
    pending: 0,
    reserveUnits: 0,
    byKind: {
      trustline: { confirmed: 0, pending: 0 },
      "account+trustline": { confirmed: 0, pending: 0 },
    },
  };
  for (const group of groups) {
    // `kind` is unconstrained TEXT. An unrecognised value has no known reserve
    // cost, and skipping it would understate the liability, so refuse to report.
    if (!Object.prototype.hasOwnProperty.call(SPONSORSHIP_RESERVE_UNITS, group.kind)) {
      throw new Error(`sponsorshipLiability: unknown sponsored trustline kind "${group.kind}"`);
    }
    const kind = group.kind as SponsorshipKind;
    const status = group.status === "pending" ? "pending" : "confirmed";
    const count = group._count._all;
    liability.outstanding += count;
    if (status === "pending") liability.pending += count;
    liability.reserveUnits += count * SPONSORSHIP_RESERVE_UNITS[kind];
    liability.byKind[kind][status] += count;
  }
  return liability;
}
