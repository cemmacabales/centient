// ST-4e follow-up (#330) — bound platform-sponsored USDC trustlines per labeler.
//
// Each successful sponsorship (CAP-33) locks ~0.5 XLM (trustline) or ~1.5 XLM
// (account creation + trustline) of the pooled platform account's reserves on a
// recipient's behalf. The sponsor route authenticates the session but the only
// spend-shaped throttle is a per-address rate limit — a labeler can loop fresh
// keypairs to bypass it and drive the platform toward `op_low_reserve`, halting
// ALL real USDC payouts (an economic DoS on mainnet). Reserves are only
// recoverable by a revocation/reclaim job that does not exist yet.
//
// This module enforces two gates, backed by the `sponsored_trustlines` table:
//   1. a hard cap on OUTSTANDING sponsorships per user (revokedAt = null), and
//   2. a cross-user lock so an address already sponsored (outstanding) by one
//      user can't be re-sponsored by another.
//
// `address` is a case-sensitive `G…` StrKey and is never normalized/lowercased.
import prisma from "./prisma";

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

/** Count of this user's sponsorships whose reserves are still locked. */
export function countOutstandingSponsorships(userId: string): Promise<number> {
  return prisma.sponsoredTrustline.count({ where: { userId, revokedAt: null } });
}

/** True iff `address` has an outstanding sponsorship owned by a *different* user. */
export async function addressSponsoredByOther(
  address: string,
  userId: string,
): Promise<boolean> {
  const row = await prisma.sponsoredTrustline.findFirst({
    where: { address, revokedAt: null, userId: { not: userId } },
    select: { id: true },
  });
  return row !== null;
}

export type SponsorGateResult =
  | { ok: true }
  | { ok: false; reason: "cap_reached" | "address_sponsored_by_other" };

/**
 * Authoritative pre-submit gate. Rejects when the address is already sponsored
 * (outstanding) by another user, or when this user is already at the outstanding
 * cap. Checked at both the build (GET) and submit (POST) steps so an over-cap
 * user never even receives an XDR.
 */
export async function checkSponsorAllowed(
  userId: string,
  address: string,
): Promise<SponsorGateResult> {
  if (await addressSponsoredByOther(address, userId)) {
    return { ok: false, reason: "address_sponsored_by_other" };
  }
  if ((await countOutstandingSponsorships(userId)) >= sponsorMaxOutstanding()) {
    return { ok: false, reason: "cap_reached" };
  }
  return { ok: true };
}

/**
 * Record a successful sponsorship so it counts against the cap. Idempotent per
 * outstanding (userId, address): if this user already has an outstanding row for
 * the address (e.g. a duplicate submit of the same flow), no second row is added.
 */
export async function recordSponsorship(opts: {
  userId: string;
  address: string;
  kind: string;
  txHash: string;
}): Promise<void> {
  const existing = await prisma.sponsoredTrustline.findFirst({
    where: { userId: opts.userId, address: opts.address, revokedAt: null },
    select: { id: true },
  });
  if (existing) return;
  await prisma.sponsoredTrustline.create({ data: opts });
}
