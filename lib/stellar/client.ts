// Platform-side Stellar client (ST-1b #292): transaction status lookups and the
// sponsored USDC trustline path for new recipients.
//
// The single-key `payUsdc` broadcast that used to live here was retired by the
// multisig payout service (issue #7, closed out in #73). Every contributor
// payout now goes through `payout-submitter.ts`, which builds the payment from
// the 2-of-3 payout account, collects two independent signatures, fee-bumps, and
// submits under its own sequence lock. Nothing in this module can move funds
// with one signature: `sponsorKeypair()` signs only the sponsorship sandwich
// for a recipient's trustline, and is required to be a key that is not a signer
// on the payout account at all (F-01).
//
// USDC is an issued asset, so each recipient must hold a USDC trustline before
// they can be paid — see `op_no_trust` below and `buildSponsoredTrustlineTx`.
import {
  Account,
  BASE_FEE,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { server, networkPassphrase, usdcAsset } from "./config";
import { assertSponsorNotPayoutSigner } from "./key-custody";

/** How long a built transaction stays valid before Horizon rejects it. */
const TX_TIMEOUT_SECONDS = 180;

/**
 * A payment failure surfaced to the caller. `retryable: false` means the caller
 * must NOT retry — e.g. `op_no_destination` (the destination account doesn't
 * exist / is unfunded) or `op_no_trust` (the destination holds no USDC
 * trustline), both of which would loop forever. The payout should be marked
 * failed instead. Error shapes confirmed in ST-0 (#290).
 */
export class StellarPaymentError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "StellarPaymentError";
  }
}

let _sponsorKeypair: Keypair | null = null;

/**
 * The sponsorship signing key, memoized after first use.
 *
 * Reads `STELLAR_SPONSOR_SECRET` and falls back to `STELLAR_PLATFORM_SECRET`.
 * The fallback exists so the two halves of the F-01 migration can land in either
 * order without an onboarding outage: this deployment keeps sponsoring
 * trustlines while the new key is provisioned, and keeps sponsoring them after
 * the payout master is removed. It is not a permanent affordance — while
 * `STELLAR_PLATFORM_SECRET` is what answers here, the deployment still holds a
 * payout signer and `assertCustodyBelowThreshold` still refuses to pay out.
 *
 * This key signs only the sponsorship sandwich — a shape asserted to contain no
 * payment operation — so it needs XLM for reserves and no payout authority at
 * all. `assertSponsorNotPayoutSigner` enforces that separation.
 */
function sponsorKeypair(): Keypair {
  if (_sponsorKeypair) return _sponsorKeypair;

  const sponsorSecret = process.env.STELLAR_SPONSOR_SECRET?.trim();
  if (sponsorSecret) {
    assertSponsorNotPayoutSigner();
    _sponsorKeypair = Keypair.fromSecret(sponsorSecret);
    return _sponsorKeypair;
  }

  const platformSecret = process.env.STELLAR_PLATFORM_SECRET?.trim();
  if (!platformSecret) {
    throw new Error(
      "STELLAR_SPONSOR_SECRET is not configured (and no STELLAR_PLATFORM_SECRET to fall back to) — new recipients cannot be given a sponsored USDC trustline",
    );
  }
  console.warn(
    "[stellar/client] sponsoring trustlines with STELLAR_PLATFORM_SECRET; set STELLAR_SPONSOR_SECRET to a non-payout-signer key so the payout master can be removed from this deployment (F-01)",
  );
  _sponsorKeypair = Keypair.fromSecret(platformSecret);
  return _sponsorKeypair;
}

/** Horizon error → `{ transaction, operations }` result codes (ST-0 #290 shapes). */
export function resultCodes(err: unknown): { transaction?: string; operations?: string[] } {
  const extras = (err as { response?: { data?: { extras?: { result_codes?: unknown } } } })
    ?.response?.data?.extras?.result_codes;
  return (extras as { transaction?: string; operations?: string[] }) ?? {};
}

/**
 * A human-readable failure description that preserves Horizon's verdict.
 *
 * Horizon rejects with an axios error whose `message` is only
 * `Request failed with status code 400`; the reason — `tx_insufficient_balance`,
 * `op_underfunded`, `op_no_trust` — lives in `extras.result_codes`, and
 * `console.log`ging the error renders that object as `[Object]`. So a payout
 * that failed for a precise, actionable reason was indistinguishable from one
 * that failed for an unknown one (F-04b). Anything that records a payout failure
 * for an operator should describe it through here.
 */
export function describeStellarError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const codes = resultCodes(err);
  const parts: string[] = [];
  if (codes.transaction) parts.push(codes.transaction);
  if (codes.operations?.length) {
    // Horizon pads the array with "op_success" for operations that did apply;
    // keeping those buries the one code that explains the failure.
    const failed = codes.operations.filter((code) => code && code !== "op_success");
    if (failed.length) parts.push(...failed);
  }
  if (!parts.length) return message;
  return `${message} (${parts.join(", ")})`;
}

/**
 * Look up a transaction by hash and map it to a coarse status for the reconciler
 * (ST-3b): `confirmed` (Horizon `successful: true`), `failed` (explicit
 * failure), or `not_found` (404 — not yet visible or never submitted).
 */
export async function getTxStatus(
  hash: string,
): Promise<"confirmed" | "failed" | "not_found"> {
  try {
    const tx = await server().transactions().transaction(hash).call();
    return tx.successful ? "confirmed" : "failed";
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) return "not_found";
    throw err;
  }
}

/** A Horizon `account.balances[]` line — the subset we read for trustline checks. */
interface HorizonBalanceLine {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}

/**
 * True iff `address` (a `G…`) holds a USDC trustline for the configured issuer.
 * Holding the trustline is a precondition for receiving USDC — without it a
 * payment fails non-retryably with `op_no_trust`. Used to precheck a withdrawal
 * destination so an untrusted address is rejected with clear guidance up front
 * instead of failing silently at payout time (ST-4b #300).
 *
 * A non-existent / unfunded account (Horizon 404) holds no trustline → `false`.
 * ST-4e (#314) turns this gate from a hard reject into a sponsored-trustline flow.
 */
export async function accountHasUsdcTrustline(address: string): Promise<boolean> {
  const asset = usdcAsset();
  try {
    const account = await server().loadAccount(address);
    return (account.balances as HorizonBalanceLine[]).some(
      (b) =>
        b.asset_type !== "native" &&
        b.asset_code === asset.getCode() &&
        b.asset_issuer === asset.getIssuer(),
    );
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) return false;
    throw err;
  }
}

/**
 * Does `address` exist on-chain? A Horizon 404 means the account is unfunded /
 * never created (so it needs sponsored creation before it can hold a trustline).
 */
async function accountExists(address: string): Promise<boolean> {
  try {
    await server().loadAccount(address);
    return true;
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) return false;
    throw err;
  }
}

/**
 * Build a CAP-33 platform-sponsored USDC-trustline transaction for `recipientG`
 * and platform-sign it. The platform is the transaction source (sequence + fee)
 * and the sponsor; the recipient owns (and must also sign) the `changeTrust` and
 * `endSponsoring` ops, but pays no reserve. If the recipient account does not yet
 * exist, a sponsored `createAccount(recipient, "0")` is prepended.
 *
 * Sequence: built from the platform's *current* sequence but submitted later
 * (after the recipient signs in-browser), so a concurrent multisig payout may consume it
 * first → tx_bad_seq at submit; the caller re-runs the flow (simple strategy,
 * ST-4e #314). Returns the base64 XDR for the browser to co-sign.
 */
export async function buildSponsoredTrustlineTx(
  recipientG: string,
): Promise<{ xdr: string; kind: "trustline" | "account+trustline" }> {
  const kp = sponsorKeypair();
  const srv = server();
  const account = await srv.loadAccount(kp.publicKey());
  const fee = await srv.fetchBaseFee().catch(() => Number(BASE_FEE));
  const exists = await accountExists(recipientG);

  const builder = new TransactionBuilder(account, {
    fee: String(fee),
    networkPassphrase: networkPassphrase(),
  }).addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: recipientG }));

  if (!exists) {
    builder.addOperation(
      Operation.createAccount({ destination: recipientG, startingBalance: "0" }),
    );
  }

  const tx = builder
    .addOperation(Operation.changeTrust({ asset: usdcAsset(), source: recipientG }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: recipientG }))
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();
  tx.sign(kp);

  return { xdr: tx.toXDR(), kind: exists ? "trustline" : "account+trustline" };
}

/**
 * Assert `xdr` is exactly a platform-sponsored USDC-trustline sandwich for a
 * single recipient — begin / [createAccount] / changeTrust(USDC) / end, no other
 * op types (esp. no payment). Defense in depth: the platform already signed a
 * fixed envelope (tampering invalidates that signature), but we re-check the
 * sponsored target + asset before submitting. Throws `invalid_sponsor_tx`.
 *
 * Fix 2: also asserts `beginSponsoringFutureReserves.sponsoredId === expectedRecipient`.
 * Fix 4: also asserts `endSponsoringFutureReserves.source === sponsored`.
 */
function assertSponsoredTrustlineShape(tx: Transaction, expectedRecipient: string): void {
  const types = tx.operations.map((o) => o.type);
  const withAccount = ["beginSponsoringFutureReserves", "createAccount", "changeTrust", "endSponsoringFutureReserves"];
  const withoutAccount = ["beginSponsoringFutureReserves", "changeTrust", "endSponsoringFutureReserves"];
  const ok =
    JSON.stringify(types) === JSON.stringify(withAccount) ||
    JSON.stringify(types) === JSON.stringify(withoutAccount);
  if (!ok) {
    throw new StellarPaymentError(
      `submitSponsoredTrustline: unexpected op shape [${types.join(", ")}]`,
      "invalid_sponsor_tx",
      false,
    );
  }
  const begin = tx.operations[0] as { sponsoredId?: string };
  const changeTrust = tx.operations.find((o) => o.type === "changeTrust") as
    | { source?: string; line?: { code?: string; issuer?: string } }
    | undefined;
  const asset = usdcAsset();
  const sponsored = begin.sponsoredId;
  if (
    !sponsored ||
    !changeTrust ||
    changeTrust.source !== sponsored ||
    changeTrust.line?.code !== asset.getCode() ||
    changeTrust.line?.issuer !== asset.getIssuer()
  ) {
    throw new StellarPaymentError(
      "submitSponsoredTrustline: sponsored target / asset mismatch",
      "invalid_sponsor_tx",
      false,
    );
  }
  // Fix 2: the envelope's sponsoredId must match the address the route validated.
  // Guards against an injected envelope targeting a different account while reusing
  // a valid shape (the platform signature check is defense-in-depth; this is an
  // additional semantic guard).
  if (sponsored !== expectedRecipient) {
    throw new StellarPaymentError(
      "submitSponsoredTrustline: sponsored target does not match expected recipient",
      "invalid_sponsor_tx",
      false,
    );
  }
  const createAccount = tx.operations.find((o) => o.type === "createAccount") as
    | { destination?: string }
    | undefined;
  if (createAccount && createAccount.destination !== sponsored) {
    throw new StellarPaymentError(
      "submitSponsoredTrustline: createAccount destination does not match sponsoredId",
      "invalid_sponsor_tx",
      false,
    );
  }
  // Fix 4: the endSponsoringFutureReserves op must be sourced by the recipient
  // (sponsored), not some other party.
  const endSponsoring = tx.operations.find((o) => o.type === "endSponsoringFutureReserves") as
    | { source?: string }
    | undefined;
  if (!endSponsoring || endSponsoring.source !== sponsored) {
    throw new StellarPaymentError(
      "submitSponsoredTrustline: endSponsoringFutureReserves.source does not match sponsored",
      "invalid_sponsor_tx",
      false,
    );
  }
}

/**
 * Submit a recipient-co-signed sponsored-trustline XDR (from
 * {@link buildSponsoredTrustlineTx}). Validates the op shape and asserts the
 * envelope targets `expectedRecipient`, then submits.
 * Maps: `op_low_reserve` → non-retryable (platform lacks XLM for the sponsored
 * reserves); `tx_bad_seq` → retryable (caller re-runs the flow); shape mismatch
 * or garbage input → non-retryable `invalid_sponsor_tx` (→ 400 at the route).
 * A `changeTrust` on an already-trusting line is idempotent.
 *
 * NOTE: the sponsor path is intentionally NOT serialized with the payout
 * submitter's sequence lock (simple strategy; the multisig payout path rebuilds
 * once on `tx_bad_seq`).
 */
export async function submitSponsoredTrustline(
  signedXdr: string,
  expectedRecipient: string,
): Promise<{ hash: string; kind: "trustline" | "account+trustline" }> {
  // Fix 3: wrap XDR parse so garbage input / fee-bump envelopes become
  // `invalid_sponsor_tx` (→ 400) instead of a raw JS error (→ 502).
  let tx: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(signedXdr, networkPassphrase());
    if (!(parsed instanceof Transaction)) {
      throw new StellarPaymentError(
        "submitSponsoredTrustline: fee-bump or non-standard envelope not accepted",
        "invalid_sponsor_tx",
        false,
      );
    }
    tx = parsed;
  } catch (err) {
    if (err instanceof StellarPaymentError) throw err;
    throw new StellarPaymentError(
      "submitSponsoredTrustline: could not parse XDR (malformed or garbage input)",
      "invalid_sponsor_tx",
      false,
    );
  }
  // Fix 2 + Fix 4: validate shape, recipient match, and end-sponsoring source.
  assertSponsoredTrustlineShape(tx, expectedRecipient);
  // Derived from the validated shape so the caller can record which reserve kind
  // was locked (#330): account-creation + trustline (~1.5 XLM) vs trustline only.
  const kind: "trustline" | "account+trustline" = tx.operations.some(
    (o) => o.type === "createAccount",
  )
    ? "account+trustline"
    : "trustline";
  try {
    const res = await server().submitTransaction(tx);
    return { hash: res.hash, kind };
  } catch (err) {
    if (err instanceof StellarPaymentError) throw err;
    const codes = resultCodes(err);
    if (codes.operations?.includes("op_low_reserve")) {
      throw new StellarPaymentError(
        "submitSponsoredTrustline: platform account cannot fund sponsored reserves (op_low_reserve)",
        "op_low_reserve",
        false,
      );
    }
    if (codes.transaction === "tx_bad_seq") {
      throw new StellarPaymentError(
        "submitSponsoredTrustline: stale sequence (tx_bad_seq) — rebuild and retry",
        "tx_bad_seq",
        true,
      );
    }
    throw err;
  }
}
