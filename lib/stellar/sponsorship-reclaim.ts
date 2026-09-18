// The chain side of sponsored-reserve reclaim (#29, E2-6).
//
// A sponsorship (#27, #28) locks base reserves on the sponsor for entries the
// contributor owns: one for the USDC trustline, two more for the account when
// the sponsor created it. Those reserves come back in exactly two ways, both
// confirmed on testnet on 2026-09-14:
//
//   1. The owner removes the entry — drops the trustline or merges the account.
//      The reserve returns to the sponsor on its own, and the entry is gone
//      (`op_does_not_exist` if anyone later tries to revoke it).
//   2. The sponsor submits `revokeSponsorship` alone. The entry stays exactly as
//      it is, trustline and USDC included, and its reserve moves onto the owner's
//      own XLM. If the owner cannot cover it the operation fails with
//      `op_low_reserve` and nothing changes. A second revocation of the same
//      entry answers `op_not_sponsor`.
//
// So the chain itself refuses to strand a zero-XLM contributor, and a revocation
// never touches the trustline a payout needs. What the chain does not refuse is
// taking reserve from an owner who happens to hold XLM; that is a policy
// decision, and it lives in `lib/sponsorship-reclaim.ts`.
//
// This module reads what the chain says about one address, and builds, checks
// and broadcasts the one transaction reclaim may send: the sponsor's revocation
// of this address's entries, and nothing else.
import { Horizon, Keypair, Operation, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { calculateSpendableXlm, xlmToStroops } from "./balance";
import { networkPassphrase, server, usdcAsset, usdcToUnits } from "./config";
import {
  describeStellarError,
  resultCodes,
  sponsorKeypair,
  SPONSOR_MAX_FEE_PER_OP_STROOPS,
  StellarPaymentError,
} from "./client";

/** A ledger entry a sponsorship pays the reserve for. */
export type SponsoredEntry = "trustline" | "account";

/** Base reserves each entry holds: an account two, a trustline one. */
export const ENTRY_RESERVE_UNITS: Readonly<Record<SponsoredEntry, number>> = {
  trustline: 1,
  account: 2,
};

/** The operation that revokes each entry's sponsorship, in the order they are sent. */
const REVOKE_OPERATION: Readonly<Record<SponsoredEntry, string>> = {
  trustline: "revokeTrustlineSponsorship",
  account: "revokeAccountSponsorship",
};

/** Trustline before account: the order the testnet probe ran and every envelope uses. */
const ENTRY_ORDER: readonly SponsoredEntry[] = ["trustline", "account"];

/** How long a revocation envelope stays valid. */
const REVOKE_TIMEOUT_SECONDS = 180;

/** Clock skew tolerated between the builder that set `maxTime` and the guard. */
const TIME_BOUND_SKEW_SECONDS = 60;

/** Reserve units the given entries hold. */
export function reserveUnitsOf(entries: readonly SponsoredEntry[]): number {
  return entries.reduce((sum, entry) => sum + ENTRY_RESERVE_UNITS[entry], 0);
}

/** What the chain says about one sponsored address, as far as reclaim reads it. */
export type ChainSponsorship =
  | { exists: false }
  | {
      exists: true;
      /** Entries of this address the sponsor sponsors right now, trustline first. */
      sponsoredEntries: SponsoredEntry[];
      /**
       * Other balance lines on this address the sponsor sponsors — a trustline to
       * an asset that is not the configured USDC. Reclaim never records such an
       * address as released, because a changed issuer would otherwise look like
       * a removed trustline.
       */
      straySponsoredLines: number;
      /** USDC the trustline holds, in units; 0 without a trustline. */
      usdcBalanceUnits: bigint;
      /** USDC committed to open buy offers, in units. */
      usdcBuyingLiabilitiesUnits: bigint;
      /** XLM the owner could spend now, in stroops, from the live base reserve. */
      ownerSpendableStroops: bigint;
    };

/** A Horizon balance line, as far as reclaim reads it. */
interface HorizonBalanceLine {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  buying_liabilities?: string;
  selling_liabilities?: string;
  sponsor?: string;
}

/** True for Horizon's 404, which means the account does not exist. */
function isNotFound(err: unknown): boolean {
  return (err as { response?: { status?: unknown } })?.response?.status === 404;
}

/** The live base reserve, in stroops, from the latest ledger. */
export async function loadBaseReserveStroops(srv: Horizon.Server = server()): Promise<bigint> {
  const ledgers = await srv.ledgers().order("desc").limit(1).call();
  const value = ledgers.records[0]?.base_reserve_in_stroops as unknown;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return BigInt(value);
  throw new Error("loadBaseReserveStroops: Horizon returned no usable base_reserve_in_stroops");
}

/** A test for the balance line of the configured USDC. */
function usdcLineMatcher(): (line: HorizonBalanceLine) => boolean {
  const asset = usdcAsset();
  return (line) =>
    line.asset_type !== "native" && line.asset_code === asset.getCode() && line.asset_issuer === asset.getIssuer();
}

/** The entries of `account` whose reserve `sponsor` pays, trustline first. */
function sponsoredEntriesOf(
  account: Horizon.AccountResponse,
  usdc: HorizonBalanceLine | undefined,
  sponsor: string,
): SponsoredEntry[] {
  const entries: SponsoredEntry[] = [];
  if (usdc?.sponsor === sponsor) entries.push("trustline");
  if ((account as { sponsor?: string }).sponsor === sponsor) entries.push("account");
  return entries;
}

/** What the chain shows for an address about to be sponsored again. */
export interface AddressSponsorship {
  /** The address holds a trustline to the configured USDC, whoever pays its reserve. */
  usdcTrustline: boolean;
  /** Entries of the address the sponsor sponsors right now, trustline first. */
  sponsoredEntries: SponsoredEntry[];
}

/**
 * Read whether `address` still holds its USDC trustline, and what of it the
 * configured sponsor still sponsors. The sponsor route asks before trusting a
 * `confirmed` sponsorship row. A missing account holds neither; any other
 * failure propagates, so an unreachable Horizon never reads as "gone".
 */
export async function readSponsorshipOnChain(
  address: string,
  srv: Horizon.Server = server(),
): Promise<AddressSponsorship> {
  let account: Horizon.AccountResponse;
  try {
    account = await srv.loadAccount(address);
  } catch (err) {
    if (isNotFound(err)) return { usdcTrustline: false, sponsoredEntries: [] };
    throw err;
  }
  const usdc = (account.balances as unknown as HorizonBalanceLine[]).find(usdcLineMatcher());
  return {
    usdcTrustline: usdc !== undefined,
    sponsoredEntries: sponsoredEntriesOf(account, usdc, sponsorKeypair().publicKey()),
  };
}

/**
 * Read `address` from Horizon and say which of its entries `sponsor` sponsors.
 * A missing account is `{ exists: false }`; any other failure propagates, so an
 * unreachable Horizon is never read as "nothing is sponsored".
 */
export async function readChainSponsorship(
  address: string,
  sponsor: string,
  baseReserveStroops: bigint,
  srv: Horizon.Server = server(),
): Promise<ChainSponsorship> {
  let account: Horizon.AccountResponse;
  try {
    account = await srv.loadAccount(address);
  } catch (err) {
    if (isNotFound(err)) return { exists: false };
    throw err;
  }

  const lines = account.balances as unknown as HorizonBalanceLine[];
  const isUsdc = usdcLineMatcher();
  const usdc = lines.find(isUsdc);
  const native = lines.find((line) => line.asset_type === "native");
  if (!native) throw new Error(`readChainSponsorship: Horizon account ${address} has no native balance line`);

  const sponsoredEntries = sponsoredEntriesOf(account, usdc, sponsor);

  const { spendableStroops } = calculateSpendableXlm({
    totalStroops: xlmToStroops(native.balance),
    sellingLiabilitiesStroops: xlmToStroops(native.selling_liabilities ?? "0"),
    baseReserveStroops,
    subentryCount: account.subentry_count,
    numSponsoring: account.num_sponsoring ?? 0,
    numSponsored: account.num_sponsored ?? 0,
  });

  return {
    exists: true,
    sponsoredEntries,
    straySponsoredLines: lines.filter(
      (line) => line.asset_type !== "native" && !isUsdc(line) && line.sponsor === sponsor,
    ).length,
    usdcBalanceUnits: usdc ? usdcToUnits(usdc.balance) : 0n,
    usdcBuyingLiabilitiesUnits: usdc ? usdcToUnits(usdc.buying_liabilities ?? "0") : 0n,
    ownerSpendableStroops: spendableStroops,
  };
}

/** A Horizon operation record, as far as {@link readRevokedEntries} reads it. */
interface HorizonRevokeOperation {
  type: string;
  account_id?: string;
  trustline_account_id?: string;
  trustline_asset?: string;
}

/**
 * The entries of `address` whose sponsorship the landed transaction `hash`
 * revoked, read from its operations. A run that finds an earlier run's
 * revocation landed credits only these: the owner may have removed an entry
 * before that revocation was built, so the row's kind can overstate it.
 */
export async function readRevokedEntries(
  hash: string,
  address: string,
  srv: Horizon.Server = server(),
): Promise<SponsoredEntry[]> {
  const page = await srv.operations().forTransaction(hash).limit(10).call();
  const asset = usdcAsset();
  const usdc = `${asset.getCode()}:${asset.getIssuer()}`;
  const revoked = new Set<SponsoredEntry>();
  for (const op of page.records as unknown as HorizonRevokeOperation[]) {
    if (op.type !== "revoke_sponsorship") continue;
    if (op.account_id === address) revoked.add("account");
    if (op.trustline_account_id === address && op.trustline_asset === usdc) revoked.add("trustline");
  }
  return ENTRY_ORDER.filter((entry) => revoked.has(entry));
}

/** Throw the non-retryable `invalid_reclaim_tx`; nothing that fails a check is sent. */
function rejectReclaimTx(why: string): never {
  throw new StellarPaymentError(`sponsorship reclaim: ${why}`, "invalid_reclaim_tx", false);
}

/** Put entries in the one order an envelope may carry them, refusing duplicates or none. */
export function canonicalEntries(entries: readonly SponsoredEntry[]): SponsoredEntry[] {
  const unique = new Set(entries);
  if (unique.size !== entries.length || unique.size === 0) {
    rejectReclaimTx(`entries [${entries.join(", ")}] must be one or both of trustline and account, once each`);
  }
  return ENTRY_ORDER.filter((entry) => unique.has(entry));
}

export interface RevocationShape {
  sponsor: Keypair;
  address: string;
  entries: readonly SponsoredEntry[];
  nowMs: number;
}

/**
 * Assert `tx` is exactly the sponsor's revocation of `address`'s `entries`: one
 * operation per entry, in canonical order, each naming this address (and the
 * configured USDC for the trustline) with no operation-level source; the sponsor
 * as transaction source; no memo; a bounded fee and time bound; and exactly one
 * signature, the sponsor's, valid for this network. Throws `invalid_reclaim_tx`.
 */
export function assertRevocationShape(tx: Transaction, shape: RevocationShape): void {
  const entries = canonicalEntries(shape.entries);
  const expected = entries.map((entry) => REVOKE_OPERATION[entry]);
  const types = tx.operations.map((op) => op.type);
  if (JSON.stringify(types) !== JSON.stringify(expected)) {
    rejectReclaimTx(`unexpected op shape [${types.join(", ")}], expected [${expected.join(", ")}]`);
  }

  const asset = usdcAsset();
  for (const op of tx.operations as unknown as Array<{
    type: string;
    source?: string;
    account?: string;
    asset?: { getCode(): string; getIssuer(): string };
  }>) {
    if (op.source !== undefined) rejectReclaimTx(`${op.type} carries its own source account`);
    if (op.account !== shape.address) rejectReclaimTx(`${op.type} targets ${op.account}, not ${shape.address}`);
    if (
      op.type === "revokeTrustlineSponsorship" &&
      (op.asset?.getCode() !== asset.getCode() || op.asset?.getIssuer() !== asset.getIssuer())
    ) {
      rejectReclaimTx("revokeTrustlineSponsorship names an asset other than the configured USDC");
    }
  }

  if (tx.source !== shape.sponsor.publicKey()) rejectReclaimTx("transaction source is not the sponsor account");
  if (tx.memo.type !== "none") rejectReclaimTx("revocation carries a memo");
  if (BigInt(tx.fee) > BigInt(SPONSOR_MAX_FEE_PER_OP_STROOPS * tx.operations.length)) {
    rejectReclaimTx(`fee ${tx.fee} exceeds the sponsor's bound`);
  }
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  if (maxTime === 0) rejectReclaimTx("envelope has no upper time bound");
  if (maxTime > Math.floor(shape.nowMs / 1000) + REVOKE_TIMEOUT_SECONDS + TIME_BOUND_SKEW_SECONDS) {
    rejectReclaimTx("envelope is valid for longer than reclaim issues");
  }

  // The hash commits to the network passphrase, so a valid signature over it also
  // proves the network — provided the hash is taken under the configured passphrase,
  // not whichever one this Transaction object happened to be constructed with.
  const hash = new Transaction(tx.toEnvelope(), networkPassphrase()).hash();
  const sponsor = shape.sponsor;
  const sponsorSigned = tx.signatures.some(
    (sig) => sig.hint().equals(sponsor.signatureHint()) && sponsor.verify(hash, sig.signature()),
  );
  if (!sponsorSigned) rejectReclaimTx("envelope does not carry a valid sponsor signature for this network");
  if (tx.signatures.length !== 1) {
    rejectReclaimTx(`envelope carries ${tx.signatures.length} signatures, not only the sponsor's`);
  }
}

/** How Horizon answered a revocation. */
export type RevocationOutcome =
  /** Every entry's reserve moved back to the sponsor. */
  | { outcome: "revoked" }
  /** An entry is no longer sponsored by us, or no longer exists. Re-read the chain. */
  | { outcome: "not_sponsored"; codes: string[] }
  /** The owner cannot cover the reserve itself. Nothing changed. */
  | { outcome: "owner_low_reserve" }
  /** The sponsor's sequence moved on. This envelope cannot apply unless it is what moved it. */
  | { outcome: "stale_sequence" }
  /** Horizon refused it for another definite reason. It did not apply. */
  | { outcome: "rejected"; detail: string }
  /** No answer. It may still apply; resolve by hash before building another. */
  | { outcome: "unknown"; detail: string };

/** Classify a revocation broadcast failure as definite, or as unknown. */
export function classifyRevocationError(err: unknown): RevocationOutcome {
  const codes = resultCodes(err);
  const failed = (codes.operations ?? []).filter((code) => code && code !== "op_success");
  if (failed.includes("op_low_reserve")) return { outcome: "owner_low_reserve" };
  if (failed.length > 0 && failed.every((code) => code === "op_not_sponsor" || code === "op_does_not_exist")) {
    return { outcome: "not_sponsored", codes: failed };
  }
  if (codes.transaction === "tx_bad_seq") return { outcome: "stale_sequence" };
  const status = (err as { response?: { status?: unknown } })?.response?.status;
  const answered = codes.transaction !== undefined || failed.length > 0;
  if (answered || (typeof status === "number" && status >= 400 && status < 500)) {
    return { outcome: "rejected", detail: describeStellarError(err) };
  }
  return { outcome: "unknown", detail: describeStellarError(err) };
}

/** A checked revocation, ready to broadcast. */
export interface PreparedRevocation {
  /** Hex hash of the envelope, known before broadcast so it can be recorded first. */
  hash: string;
  /** The envelope's `maxTime`: after it, the envelope can no longer apply. */
  expiresAt: Date;
  entries: SponsoredEntry[];
  /** Broadcast the envelope and say how Horizon answered. Never throws for a Horizon verdict. */
  submit(): Promise<RevocationOutcome>;
}

/**
 * Build the sponsor's revocation of `address`'s `entries` from the sponsor's
 * current sequence, sign it, and check it against {@link assertRevocationShape}
 * before handing it back. The only way to broadcast it is the returned `submit`,
 * so nothing unchecked reaches Horizon, while the caller still learns the hash
 * in time to record its intent first.
 */
export async function prepareRevocation(
  address: string,
  entries: readonly SponsoredEntry[],
  opts: { srv?: Horizon.Server; nowMs?: number } = {},
): Promise<PreparedRevocation> {
  const srv = opts.srv ?? server();
  const sponsor = sponsorKeypair();
  const ordered = canonicalEntries(entries);
  const account = await srv.loadAccount(sponsor.publicKey());
  const networkFee = await srv.fetchBaseFee().catch(() => 100);
  const feePerOp = Math.max(Math.min(networkFee, SPONSOR_MAX_FEE_PER_OP_STROOPS), 100);
  const asset = usdcAsset();

  const builder = new TransactionBuilder(account, {
    fee: String(feePerOp),
    networkPassphrase: networkPassphrase(),
  });
  for (const entry of ordered) {
    builder.addOperation(
      entry === "trustline"
        ? Operation.revokeTrustlineSponsorship({ account: address, asset })
        : Operation.revokeAccountSponsorship({ account: address }),
    );
  }
  const tx = builder.setTimeout(REVOKE_TIMEOUT_SECONDS).build();
  tx.sign(sponsor);
  assertRevocationShape(tx, { sponsor, address, entries: ordered, nowMs: opts.nowMs ?? Date.now() });

  return {
    hash: tx.hash().toString("hex"),
    expiresAt: new Date(Number(tx.timeBounds!.maxTime) * 1000),
    entries: ordered,
    submit: async () => {
      try {
        await srv.submitTransaction(tx);
        return { outcome: "revoked" };
      } catch (err) {
        return classifyRevocationError(err);
      }
    },
  };
}
