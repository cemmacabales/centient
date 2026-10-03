// Recent USDC payouts for the landing page (#payouts). They are read from
// Horizon's public payments feed for the payout account, so the page shows the
// same ledger anyone can open on stellar.expert. The browser cannot call
// Horizon itself (the CSP keeps connect-src to this origin), so a route serves
// these through here.

import { explorerUrl, horizonUrl, stellarNetwork, type StellarNetwork } from "@/lib/stellar/config";

/** The fields this module reads from one Horizon `/payments` record. */
export interface HorizonPaymentRecord {
  id: string;
  type: string;
  created_at: string;
  transaction_hash: string;
  transaction_successful?: boolean;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  from?: string;
  to?: string;
  amount?: string;
}

export interface RecentPayout {
  id: string;
  /** Display amount: at least two decimals, finer digits kept when present. */
  amount: string;
  /** Recipient, shortened. The full address is one click away on the explorer. */
  to: string;
  /** Transaction hash, shortened. */
  tx: string;
  /** ISO timestamp of the ledger close. */
  at: string;
  txUrl: string;
}

export interface RecentPayoutsResult {
  network: StellarNetwork;
  /** The payout account on stellar.expert, or null when none is configured. */
  accountUrl: string | null;
  payouts: RecentPayout[];
}

interface ParseOptions {
  account: string;
  usdcCode: string;
  usdcIssuer: string;
  explorer: string;
  limit?: number;
}

const DEFAULT_LIMIT = 8;
/** How many records to scan: the feed also carries refills and account setup. */
const SCAN = 50;
/** One Horizon read serves every visitor for this long. */
const CACHE_MS = 20_000;
const FETCH_TIMEOUT_MS = 5_000;

const UNITS_PER_CENT = 100_000n;

/**
 * A Horizon amount (7 decimals) in cents, rounded half up: "0.1000000" → "0.10",
 * "6.0099999" → "6.01". An amount too small to show in cents keeps its digits
 * rather than reading as zero.
 */
export function formatPayoutAmount(raw: string): string {
  const [whole, frac = ""] = raw.split(".");
  const units = BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, "0").slice(0, 7));
  const cents = (units + UNITS_PER_CENT / 2n) / UNITS_PER_CENT;
  if (cents === 0n && units > 0n) return `${whole}.${frac.replace(/0+$/, "")}`;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** First and last four characters of an address or hash. */
function shorten(value: string): string {
  return value.length > 10 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

/**
 * Successful USDC payments sent from the payout account, newest first, as
 * Horizon ordered them. Payments into the account (refills, funding) and any
 * other asset or operation are dropped.
 */
export function toRecentPayouts(records: HorizonPaymentRecord[], options: ParseOptions): RecentPayout[] {
  const { account, usdcCode, usdcIssuer, explorer, limit = DEFAULT_LIMIT } = options;
  return records
    .filter(
      (r) =>
        r.type === "payment" &&
        r.transaction_successful !== false &&
        r.from === account &&
        typeof r.to === "string" &&
        r.asset_code === usdcCode &&
        r.asset_issuer === usdcIssuer &&
        typeof r.amount === "string",
    )
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      amount: formatPayoutAmount(r.amount!),
      to: shorten(r.to!),
      tx: shorten(r.transaction_hash),
      at: r.created_at,
      txUrl: `${explorer}/tx/${r.transaction_hash}`,
    }));
}

let cached: { at: number; result: RecentPayoutsResult } | null = null;

/** Test hook: forget the cached Horizon read. */
export function resetRecentPayoutsCache(): void {
  cached = null;
}

/**
 * The payout account's recent USDC payouts. Throws when Horizon cannot be
 * read; an unconfigured account is not an error, just an empty feed.
 */
export async function fetchRecentPayouts(now: number = Date.now()): Promise<RecentPayoutsResult> {
  if (cached && now - cached.at < CACHE_MS) return cached.result;

  const network = stellarNetwork();
  const explorer = explorerUrl();
  const account = process.env.STELLAR_PLATFORM_ACCOUNT?.trim();
  const usdcIssuer = process.env.STELLAR_USDC_ISSUER?.trim();
  const usdcCode = process.env.STELLAR_USDC_CODE?.trim() || "USDC";
  if (!account || !usdcIssuer) {
    return { network, accountUrl: null, payouts: [] };
  }

  const url = `${horizonUrl()}/accounts/${account}/payments?order=desc&limit=${SCAN}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`horizon_${res.status}`);
  const body = (await res.json()) as { _embedded?: { records?: HorizonPaymentRecord[] } };

  const result: RecentPayoutsResult = {
    network,
    accountUrl: `${explorer}/account/${account}`,
    payouts: toRecentPayouts(body._embedded?.records ?? [], { account, usdcCode, usdcIssuer, explorer }),
  };
  cached = { at: now, result };
  return result;
}
