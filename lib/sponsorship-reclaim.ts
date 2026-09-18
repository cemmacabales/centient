// Sponsored-reserve reclaim (#29, E2-6): an auditable disposition for every
// outstanding sponsorship, and a revocation for the ones that are safe to take.
//
// WHAT RECLAIM CAN DO. The chain allows exactly one reclaim the sponsor controls:
// `revokeSponsorship`, which leaves the contributor's account and trustline in
// place and moves their base reserve onto the contributor's own XLM. It fails
// with `op_low_reserve` when the contributor cannot cover it (see
// `lib/stellar/sponsorship-reclaim.ts` for the testnet probe). So a zero-XLM
// contributor — the only kind #27 and #28 onboard — can never be revoked; their
// reserve comes back only if they remove the trustline or merge the account, and
// reclaim's job there is to notice and record it.
//
// WHY PROTECTION IS NEEDED ANYWAY. A contributor who holds XLM can be revoked,
// and the chain will take the reserve from their balance without asking. That is
// harmless for a wallet nobody uses and wrong for one we are paying. Eligibility
// is therefore decided here, before any transaction is built, by rules checked in
// a fixed order so the same ledger and chain state always give the same answer:
//
//   1. A pending sponsorship is reconciled, never revoked. Its envelope landed
//      (confirm), provably cannot land (fail), or might still (skip). This is
//      also what closes the #27/#28 risk of a pending row nobody retried.
//   2. An earlier revocation that might still land is waited on, never repeated.
//   3. A sponsor-sponsored line to some other asset stops the address: a changed
//      USDC issuer must not read as a removed trustline.
//   4. Nothing of this sponsorship still sponsored on-chain: record it released.
//   5. Protected, and skipped, while the address is any user's linked wallet;
//      the destination of a queued, processing or flagged-pending withdrawal; the
//      wallet of a submission whose payout has not settled; owned by a user with
//      an unpaid balance; or holding USDC on its trustline.
//   6. The owner cannot cover the reserve: skipped, since the chain would refuse.
//   7. Otherwise eligible. A dry run reports it; an execute run revokes it.
//
// EXECUTION. Rows are processed one at a time. A revocation is built from the
// sponsor's current sequence, its hash is recorded on the row before broadcast
// (the claim only succeeds for a row with no live intent, so two runs cannot both
// send one), and the result is settled from what Horizon said. A stale sequence
// or an unanswered submit is resolved by hash, never by rebuilding in the same
// run. One row's failure is recorded and the run moves on.
//
// A dry run reads the chain and the ledger and writes nothing. An execute run
// stores its report in `sponsorship_reclaim_runs`, without wallet addresses.
import prisma from "./prisma";
import { Prisma } from "@/app/generated/prisma/client";
import {
  confirmSponsorship,
  failSponsorship,
  SPONSORSHIP_RESERVE_UNITS,
  type SponsorshipKind,
  type TxStatusLookup,
} from "./sponsored-trustline";
import type { ChainSponsorship, PreparedRevocation, SponsoredEntry } from "./stellar/sponsorship-reclaim";

export type ReclaimMode = "dry-run" | "execute";

/** The ledger entries each kind of sponsorship pays the reserve for. */
export const ENTRIES_BY_KIND: Readonly<Record<SponsorshipKind, readonly SponsoredEntry[]>> = {
  trustline: ["trustline"],
  "account+trustline": ["trustline", "account"],
};

/**
 * Submission payout statuses after which nothing more will be paid to the
 * submission's wallet. `accrued` moved the reward into the user's balance, which
 * the unpaid-balance rule covers. Every other status — including one added later
 * — protects the address.
 */
export const SETTLED_SUBMISSION_STATUSES = ["confirmed", "skipped", "abandoned", "accrued"] as const;

export type Disposition =
  /** The sponsorship's own envelope could still land. */
  | "sponsorship_pending"
  /** A pending sponsorship landed; the row is confirmed. */
  | "sponsorship_landed"
  /** A pending sponsorship expired unseen or failed; the row is released. */
  | "sponsorship_never_landed"
  /** An earlier revocation could still land. */
  | "reclaim_pending"
  /** Our revocation landed; the reserve is back. */
  | "revoked"
  /** The chain shows the entries gone or unsponsored without a revocation of ours. */
  | "released_by_owner"
  /** The sponsor sponsors a line to an asset other than the configured USDC. */
  | "unexpected_chain_state"
  | "protected_linked_wallet"
  | "protected_payout_in_flight"
  | "protected_unsettled_submission"
  | "protected_owed_balance"
  | "protected_holds_usdc"
  /** The owner's spendable XLM does not cover the reserve; the chain would refuse. */
  | "owner_cannot_cover_reserve"
  /** Dry run: would be revoked. */
  | "eligible"
  /** A lookup or revocation failed; nothing was released. Retried next run. */
  | "failed";

/** One sponsorship's disposition, as the report records it. No keys or user data. */
export interface SponsorshipDisposition {
  sponsorshipId: string;
  address: string;
  kind: SponsorshipKind;
  disposition: Disposition;
  /** Entries still sponsored on-chain, when the chain was read. */
  entries: SponsoredEntry[];
  /**
   * Base reserve units this disposition is about: released for `revoked` and
   * `released_by_owner`, to be released for `eligible`, still locked otherwise.
   */
  reserveUnits: number;
  /** Stroops this run returned to the sponsor through a revocation. */
  reclaimedStroops: string;
  txHash?: string;
  errorCode?: string;
  detail?: string;
}

export interface ReclaimReport {
  mode: ReclaimMode;
  network: string;
  sponsor: string;
  runId: string | null;
  startedAt: string;
  finishedAt: string;
  baseReserveStroops: string;
  totals: {
    sponsorships: number;
    byDisposition: Partial<Record<Disposition, number>>;
    /** Stroops returned by revocations that landed in this run's records. */
    reclaimedStroops: string;
    /** Stroops the chain shows the owner already released. */
    ownerReleasedStroops: string;
    /** Reserve units still locked after this run, counting eligible rows a dry run left. */
    lockedReserveUnits: number;
  };
  sponsorships: SponsorshipDisposition[];
}

/** Everything reclaim needs from the network, injectable so every rule is testable. */
export interface ReclaimDeps {
  network: string;
  /** The sponsor's public key; entries are sponsored by it or not at all. */
  sponsor: string;
  baseReserveStroops(): Promise<bigint>;
  readChain(address: string, baseReserveStroops: bigint): Promise<ChainSponsorship>;
  /** The entries of `address` a landed revocation actually revoked. */
  revokedEntries(hash: string, address: string): Promise<SponsoredEntry[]>;
  txStatus: TxStatusLookup;
  prepareRevocation(address: string, entries: SponsoredEntry[]): Promise<PreparedRevocation>;
  now(): Date;
}

/** The production dependencies: live Horizon and the configured sponsor key. */
export async function defaultReclaimDeps(): Promise<ReclaimDeps> {
  const [chain, client, config] = await Promise.all([
    import("./stellar/sponsorship-reclaim"),
    import("./stellar/client"),
    import("./stellar/config"),
  ]);
  const srv = config.server();
  return {
    network: config.stellarNetwork(),
    sponsor: client.sponsorKeypair().publicKey(),
    baseReserveStroops: () => chain.loadBaseReserveStroops(srv),
    readChain: (address, base) => chain.readChainSponsorship(address, client.sponsorKeypair().publicKey(), base, srv),
    revokedEntries: (hash, address) => chain.readRevokedEntries(hash, address, srv),
    txStatus: client.getTxStatus,
    prepareRevocation: (address, entries) => chain.prepareRevocation(address, entries, { srv }),
    now: () => new Date(),
  };
}

type Row = Prisma.SponsoredTrustlineGetPayload<object>;

interface Context {
  mode: ReclaimMode;
  deps: ReclaimDeps;
  base: bigint;
}

/** The kinds a row may carry; any other value is refused rather than guessed at. */
function kindOf(row: Row): SponsorshipKind {
  if (!Object.prototype.hasOwnProperty.call(ENTRIES_BY_KIND, row.kind)) {
    throw new Error(`sponsorship ${row.id} has unknown kind "${row.kind}"`);
  }
  return row.kind as SponsorshipKind;
}

/**
 * Walk every outstanding sponsorship and give each one a disposition. In
 * `execute` mode, act on it and store the report; in `dry-run`, write nothing.
 */
export async function runSponsorshipReclaim(opts: {
  mode: ReclaimMode;
  deps?: ReclaimDeps;
}): Promise<ReclaimReport> {
  const deps = opts.deps ?? (await defaultReclaimDeps());
  const startedAt = deps.now();
  const base = await deps.baseReserveStroops();
  const run =
    opts.mode === "execute"
      ? await prisma.sponsorshipReclaimRun.create({
          data: { network: deps.network, sponsor: deps.sponsor, startedAt },
          select: { id: true },
        })
      : null;

  const rows = await prisma.sponsoredTrustline.findMany({
    where: { revokedAt: null, status: { not: "failed" } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const ctx: Context = { mode: opts.mode, deps, base };
  const sponsorships: SponsorshipDisposition[] = [];
  for (const row of rows) {
    sponsorships.push(await dispose(row, ctx));
  }

  const report = buildReport({ mode: opts.mode, deps, runId: run?.id ?? null, startedAt, base, sponsorships });
  if (run) {
    await prisma.sponsorshipReclaimRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(report.finishedAt),
        reclaimedStroops: BigInt(report.totals.reclaimedStroops),
        report: storedReport(report) as unknown as Prisma.InputJsonValue,
      },
    });
  }
  return report;
}

/**
 * The report as it is stored: every disposition without its wallet address. The
 * address stays on the sponsorship row, which `sponsorshipId` joins to, for as
 * long as that row exists; it is not copied into an audit record that outlives
 * the row (a user's deletion cascades to their sponsorships). The returned and
 * printed report keeps addresses, so an operator can act on a dry run.
 *
 * A `detail` is free text from a thrown error or Horizon's answer, and can name
 * an address (`readChainSponsorship` does), so any account ID in it is replaced.
 */
function storedReport(report: ReclaimReport) {
  return {
    ...report,
    sponsorships: report.sponsorships.map(({ address: _address, detail, ...rest }) =>
      detail === undefined ? rest : { ...rest, detail: detail.replace(ACCOUNT_ID, "[address]") },
    ),
  };
}

/** A Stellar account ID, plain (G…) or muxed (M…), anywhere in free text. */
const ACCOUNT_ID = /\b(?:G[A-Z2-7]{55}|M[A-Z2-7]{68})\b/g;

/** One row's disposition. Any thrown lookup or write becomes `failed` for this row alone. */
async function dispose(row: Row, ctx: Context): Promise<SponsorshipDisposition> {
  let kind: SponsorshipKind;
  try {
    kind = kindOf(row);
  } catch (err) {
    return {
      sponsorshipId: row.id,
      address: row.address,
      kind: row.kind as SponsorshipKind,
      disposition: "failed",
      entries: [],
      reserveUnits: 0,
      reclaimedStroops: "0",
      errorCode: "unknown_kind",
      detail: messageOf(err),
    };
  }
  const result = (disposition: Disposition, extra: Partial<SponsorshipDisposition> = {}): SponsorshipDisposition => ({
    sponsorshipId: row.id,
    address: row.address,
    kind,
    disposition,
    entries: [],
    reserveUnits: SPONSORSHIP_RESERVE_UNITS[kind],
    reclaimedStroops: "0",
    ...extra,
  });

  try {
    return await decide(row, kind, ctx, result);
  } catch (err) {
    return result("failed", { errorCode: "lookup_failed", detail: messageOf(err) });
  }
}

type ResultFn = (disposition: Disposition, extra?: Partial<SponsorshipDisposition>) => SponsorshipDisposition;

/** The ordered rules from the module header, for one row. */
async function decide(row: Row, kind: SponsorshipKind, ctx: Context, result: ResultFn): Promise<SponsorshipDisposition> {
  const { deps, mode, base } = ctx;
  const execute = mode === "execute";
  const now = deps.now();

  // Rule 1: a pending sponsorship is reconciled, never revoked.
  if (row.status === "pending") return reconcilePending(row, kind, ctx, result);

  // Rule 2: an earlier revocation that might still land is waited on.
  let ourRevocationLanded = false;
  if (row.reclaimTxHash) {
    const status = await deps.txStatus(row.reclaimTxHash);
    const expired = !row.reclaimExpiresAt || row.reclaimExpiresAt.getTime() < now.getTime();
    if (status === "confirmed") {
      ourRevocationLanded = true;
    } else if (status === "not_found" && !expired) {
      return result("reclaim_pending", { txHash: row.reclaimTxHash });
    } else if (execute) {
      await clearIntent(row.id, row.reclaimTxHash);
    }
  }

  const chain = await deps.readChain(row.address, base);
  const kindEntries = ENTRIES_BY_KIND[kind];
  const entries = chain.exists ? chain.sponsoredEntries.filter((entry) => kindEntries.includes(entry)) : [];

  // Rule 3: never read a line to some other asset as a removed trustline.
  if (chain.exists && chain.straySponsoredLines > 0) {
    return result("unexpected_chain_state", {
      entries,
      detail: `${chain.straySponsoredLines} sponsored line(s) to an asset other than the configured USDC`,
    });
  }

  // Rule 4: nothing of this sponsorship is still sponsored.
  if (entries.length === 0) {
    if (ourRevocationLanded && row.reclaimTxHash) {
      // Credit only what that revocation carried, not the whole kind: the owner
      // may have removed an entry before it was built. Read before anything is
      // written, so a failed lookup leaves the row for the next run.
      const revokedUnits = unitsOf(await deps.revokedEntries(row.reclaimTxHash, row.address));
      if (execute) await markReleased(row.id, "sponsor_revoke", row.reclaimTxHash);
      return result("revoked", {
        txHash: row.reclaimTxHash,
        reserveUnits: revokedUnits,
        reclaimedStroops: stroopsFor(revokedUnits, base),
      });
    }
    if (execute) await markReleased(row.id, "owner", null);
    return result("released_by_owner");
  }
  if (ourRevocationLanded) {
    // Horizon says our revocation applied, yet the chain still shows these entries
    // sponsored by us. Neither answer is trusted over the other, and nothing is sent.
    return result("unexpected_chain_state", {
      entries,
      txHash: row.reclaimTxHash ?? undefined,
      detail: "revocation confirmed but the chain still shows the entries sponsored",
    });
  }

  const units = unitsOf(entries);

  // Rule 5: protect anyone we are, or may yet be, paying.
  const protectedBy = await protection(row);
  if (protectedBy) return result(protectedBy, { entries, reserveUnits: units });
  if (chain.exists && (chain.usdcBalanceUnits > 0n || chain.usdcBuyingLiabilitiesUnits > 0n)) {
    return result("protected_holds_usdc", { entries, reserveUnits: units });
  }

  // Rule 6: the chain would refuse a revocation the owner cannot cover.
  if (chain.exists && chain.ownerSpendableStroops < BigInt(units) * base) {
    return result("owner_cannot_cover_reserve", { entries, reserveUnits: units });
  }

  // Rule 7: eligible.
  if (!execute) return result("eligible", { entries, reserveUnits: units });
  return revoke(row, entries, units, ctx, result);
}

/**
 * Rule 1. The chain is read before the transaction lookup is trusted: an entry
 * this sponsor sponsors proves the envelope landed even if Horizon no longer
 * returns the transaction.
 */
async function reconcilePending(
  row: Row,
  kind: SponsorshipKind,
  ctx: Context,
  result: ResultFn,
): Promise<SponsorshipDisposition> {
  const { deps, mode, base } = ctx;
  const execute = mode === "execute";
  const status = await deps.txStatus(row.txHash);
  const expired = !row.expiresAt || row.expiresAt.getTime() < deps.now().getTime();

  if (status === "confirmed") {
    if (execute) await confirmSponsorship(row.id, row.txHash);
    return result("sponsorship_landed", { txHash: row.txHash });
  }
  if (status === "not_found" && !expired) return result("sponsorship_pending", { txHash: row.txHash });

  const chain = await deps.readChain(row.address, base);
  const entries = chain.exists ? chain.sponsoredEntries.filter((e) => ENTRIES_BY_KIND[kind].includes(e)) : [];
  if (entries.length > 0) {
    if (execute) await confirmSponsorship(row.id, row.txHash);
    return result("sponsorship_landed", { txHash: row.txHash, entries, detail: `transaction ${status}; chain shows it sponsored` });
  }
  if (execute) await failSponsorship(row.id, row.txHash);
  return result("sponsorship_never_landed", { txHash: row.txHash, reserveUnits: 0, detail: `transaction ${status}` });
}

/** Rule 5, from the ledger. The first matching reason wins, in a fixed order. */
async function protection(row: Row): Promise<Disposition | null> {
  const address = row.address;
  const linked = await prisma.user.findFirst({ where: { walletAddress: address }, select: { id: true } });
  if (linked) return "protected_linked_wallet";

  const job = await prisma.payoutJob.findFirst({
    where: { destinationAddress: address, status: { in: ["queued", "processing"] } },
    select: { id: true },
  });
  const flagged = job
    ? null
    : await prisma.flaggedWithdrawal.findFirst({
        where: { walletAddress: address, status: "PENDING" },
        select: { id: true },
      });
  if (job || flagged) return "protected_payout_in_flight";

  const submission = await prisma.submission.findFirst({
    where: { walletAddress: address, payoutStatus: { notIn: [...SETTLED_SUBMISSION_STATUSES] } },
    select: { id: true },
  });
  if (submission) return "protected_unsettled_submission";

  const owner = await prisma.user.findUnique({ where: { id: row.userId }, select: { pendingBalanceUnits: true } });
  if (owner && owner.pendingBalanceUnits > 0n) return "protected_owed_balance";
  return null;
}

/** Rule 7, execute mode: record the intent, broadcast, and settle from Horizon's answer. */
async function revoke(
  row: Row,
  entries: SponsoredEntry[],
  units: number,
  ctx: Context,
  result: ResultFn,
): Promise<SponsorshipDisposition> {
  const { deps, base } = ctx;
  const prepared = await deps.prepareRevocation(row.address, entries);

  // Written BEFORE the irreversible step, and only onto a row with no live intent.
  const claimed = await prisma.sponsoredTrustline.updateMany({
    where: { id: row.id, revokedAt: null, status: "confirmed", reclaimTxHash: null },
    data: { reclaimTxHash: prepared.hash, reclaimExpiresAt: prepared.expiresAt },
  });
  if (claimed.count === 0) {
    return result("reclaim_pending", { entries, reserveUnits: units, detail: "another run holds this row's revocation" });
  }

  const done = { entries: prepared.entries, reserveUnits: units, txHash: prepared.hash };
  const outcome = await prepared.submit();
  switch (outcome.outcome) {
    case "revoked":
      await markReleased(row.id, "sponsor_revoke", prepared.hash);
      return result("revoked", { ...done, reclaimedStroops: stroopsFor(units, base) });

    case "not_sponsored": {
      // Something released an entry between our read and our submit. Nothing of
      // ours applied; the chain says what is left.
      await clearIntent(row.id, prepared.hash);
      const chain = await deps.readChain(row.address, base);
      const left = chain.exists ? chain.sponsoredEntries.filter((e) => ENTRIES_BY_KIND[row.kind as SponsorshipKind].includes(e)) : [];
      if (left.length === 0) {
        await markReleased(row.id, "owner", null);
        return result("released_by_owner", { detail: outcome.codes.join(", ") });
      }
      return result("failed", { ...done, txHash: undefined, entries: left, errorCode: "not_sponsored", detail: outcome.codes.join(", ") });
    }

    case "owner_low_reserve":
      await clearIntent(row.id, prepared.hash);
      return result("owner_cannot_cover_reserve", { ...done, txHash: undefined, detail: "op_low_reserve at submit" });

    case "stale_sequence": {
      // A stale sequence can only belong to an envelope that already landed.
      let status: Awaited<ReturnType<TxStatusLookup>>;
      try {
        status = await deps.txStatus(prepared.hash);
      } catch (err) {
        return result("reclaim_pending", { ...done, errorCode: "tx_bad_seq", detail: `status lookup failed: ${messageOf(err)}` });
      }
      if (status === "confirmed") {
        await markReleased(row.id, "sponsor_revoke", prepared.hash);
        return result("revoked", { ...done, reclaimedStroops: stroopsFor(units, base) });
      }
      await clearIntent(row.id, prepared.hash);
      return result("failed", { ...done, txHash: undefined, errorCode: "tx_bad_seq" });
    }

    case "rejected":
      await clearIntent(row.id, prepared.hash);
      return result("failed", { ...done, txHash: undefined, errorCode: "reclaim_tx_rejected", detail: outcome.detail });

    case "unknown":
      // It may still land: keep the intent, and let the next run resolve it by hash.
      return result("reclaim_pending", { ...done, errorCode: "submission_unknown", detail: outcome.detail });
  }
}

/** Record the reserve released — only while the row is still outstanding. */
async function markReleased(id: string, releasedBy: "sponsor_revoke" | "owner", reclaimTxHash: string | null): Promise<void> {
  await prisma.sponsoredTrustline.updateMany({
    where: { id, revokedAt: null },
    data: {
      revokedAt: new Date(),
      releasedBy,
      reclaimTxHash,
      ...(releasedBy === "owner" ? { reclaimExpiresAt: null } : {}),
    },
  });
}

/** Drop a revocation intent that cannot land — only while it is still this hash. */
async function clearIntent(id: string, hash: string): Promise<void> {
  await prisma.sponsoredTrustline.updateMany({
    where: { id, reclaimTxHash: hash, revokedAt: null },
    data: { reclaimTxHash: null, reclaimExpiresAt: null },
  });
}

/** Base reserve units `entries` hold: an account two, a trustline one. */
function unitsOf(entries: readonly SponsoredEntry[]): number {
  return entries.reduce((sum, entry) => sum + (entry === "account" ? 2 : 1), 0);
}

function stroopsFor(units: number, base: bigint): string {
  return (BigInt(units) * base).toString();
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildReport(input: {
  mode: ReclaimMode;
  deps: ReclaimDeps;
  runId: string | null;
  startedAt: Date;
  base: bigint;
  sponsorships: SponsorshipDisposition[];
}): ReclaimReport {
  const byDisposition: Partial<Record<Disposition, number>> = {};
  let reclaimed = 0n;
  let ownerReleased = 0n;
  let locked = 0;
  for (const entry of input.sponsorships) {
    byDisposition[entry.disposition] = (byDisposition[entry.disposition] ?? 0) + 1;
    reclaimed += BigInt(entry.reclaimedStroops);
    if (entry.disposition === "released_by_owner") ownerReleased += BigInt(entry.reserveUnits) * input.base;
    else if (entry.disposition !== "revoked" && entry.disposition !== "sponsorship_never_landed") {
      locked += entry.reserveUnits;
    }
  }
  return {
    mode: input.mode,
    network: input.deps.network,
    sponsor: input.deps.sponsor,
    runId: input.runId,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.deps.now().toISOString(),
    baseReserveStroops: input.base.toString(),
    totals: {
      sponsorships: input.sponsorships.length,
      byDisposition,
      reclaimedStroops: reclaimed.toString(),
      ownerReleasedStroops: ownerReleased.toString(),
      lockedReserveUnits: locked,
    },
    sponsorships: input.sponsorships,
  };
}
