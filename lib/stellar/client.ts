// Platform-side Stellar payment client (ST-1b #292). The single primitive the
// payout rail (Wave 3) builds on: send USDC from the pooled platform hot wallet
// and report transaction status. Replaces the EVM `payReward` mechanics in
// lib/payout.ts.
//
// Custodial model (unchanged from Celo): every payout originates from one pooled
// platform account. We load that account (for its sequence number), build a
// USDC `payment`, sign with the platform Keypair, and submit to Horizon. USDC is
// an issued asset, so the platform account must itself hold a USDC trustline and
// balance (and XLM to cover fees), and each recipient must hold a USDC trustline
// before they can be paid — see `op_no_trust` below.
//
// Sequence-number safety reuses the existing payout pattern: an `async-mutex`
// serializes account-load + submit so concurrent payouts can't reuse a sequence
// (mirrors `nonceMutex` in lib/payout.ts).
import {
  Account,
  BASE_FEE,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { Mutex } from "async-mutex";
import { server, networkPassphrase, unitsToUsdcString, usdcAsset } from "./config";

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

const seqMutex = new Mutex();

let _platformKeypair: Keypair | null = null;

function platformKeypair(): Keypair {
  if (_platformKeypair) return _platformKeypair;
  const secret = process.env.STELLAR_PLATFORM_SECRET;
  if (!secret) {
    throw new Error("STELLAR_PLATFORM_SECRET is not configured");
  }
  _platformKeypair = Keypair.fromSecret(secret);
  return _platformKeypair;
}

/** Horizon error → `{ transaction, operations }` result codes (ST-0 #290 shapes). */
function resultCodes(err: unknown): { transaction?: string; operations?: string[] } {
  const extras = (err as { response?: { data?: { extras?: { result_codes?: unknown } } } })
    ?.response?.data?.extras?.result_codes;
  return (extras as { transaction?: string; operations?: string[] }) ?? {};
}

async function buildSignSubmit(
  kp: Keypair,
  to: string,
  amountUsdc: string,
): Promise<{ hash: string }> {
  const srv = server();
  // Load the platform account fresh each attempt — this is the source of the
  // sequence number, and a tx_bad_seq retry needs the *current* one.
  const account = await srv.loadAccount(kp.publicKey());
  const fee = await srv.fetchBaseFee().catch(() => Number(BASE_FEE));

  const tx = new TransactionBuilder(account, {
    fee: String(fee),
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(
      Operation.payment({ destination: to, asset: usdcAsset(), amount: amountUsdc }),
    )
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();
  tx.sign(kp);

  const res = await srv.submitTransaction(tx);
  return { hash: res.hash };
}

/**
 * Send `amountUnits` of USDC from the platform account to `to` (a `G…`
 * address). Returns the confirmed transaction hash.
 *
 * Behavior:
 * - Serialized under a mutex so concurrent calls don't reuse a sequence number.
 * - Retries exactly once on `tx_bad_seq` (reloads the account, resubmits).
 * - Throws a non-retryable {@link StellarPaymentError} on `op_no_destination`
 *   (destination unfunded / doesn't exist) or `op_no_trust` (destination holds
 *   no USDC trustline) — never retried.
 */
export async function payUsdc(to: string, amountUnits: bigint): Promise<{ hash: string }> {
  if (amountUnits <= 0n) {
    throw new StellarPaymentError(
      `payUsdc: amount must be positive, got ${amountUnits} units`,
      "invalid_amount",
      false,
    );
  }
  const kp = platformKeypair();
  const amountUsdc = unitsToUsdcString(amountUnits);

  return seqMutex.runExclusive(async () => {
    try {
      return await buildSignSubmit(kp, to, amountUsdc);
    } catch (err) {
      const codes = resultCodes(err);

      // Destination doesn't exist / unfunded — non-retryable, must bubble up.
      if (codes.operations?.includes("op_no_destination")) {
        throw new StellarPaymentError(
          `payUsdc: destination ${to} does not exist or is unfunded (op_no_destination)`,
          "op_no_destination",
          false,
        );
      }

      // Destination holds no USDC trustline — non-retryable, must bubble up.
      // (USDC is an issued asset; the recipient must add the trustline first.)
      if (codes.operations?.includes("op_no_trust")) {
        throw new StellarPaymentError(
          `payUsdc: destination ${to} has no USDC trustline (op_no_trust)`,
          "op_no_trust",
          false,
        );
      }

      // Stale sequence — reload + resubmit exactly once. If the resubmit *also*
      // hits tx_bad_seq (sustained sequence contention on the pooled account),
      // give up in-call but classify it as a retryable StellarPaymentError so the
      // worker requeues the job — backoff via the job queue's own retry loop —
      // rather than seeing an opaque raw Horizon error. Any other failure on the
      // resubmit bubbles up unchanged.
      if (codes.transaction === "tx_bad_seq") {
        try {
          return await buildSignSubmit(kp, to, amountUsdc);
        } catch (retryErr) {
          if (resultCodes(retryErr).transaction === "tx_bad_seq") {
            throw new StellarPaymentError(
              `payUsdc: destination ${to} — sustained sequence contention (tx_bad_seq after one reload+resubmit); requeue`,
              "tx_bad_seq",
              true,
            );
          }
          throw retryErr;
        }
      }

      throw err;
    }
  });
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
 * (after the recipient signs in-browser), so a concurrent payUsdc may consume it
 * first → tx_bad_seq at submit; the caller re-runs the flow (simple strategy,
 * ST-4e #314). Returns the base64 XDR for the browser to co-sign.
 */
export async function buildSponsoredTrustlineTx(
  recipientG: string,
): Promise<{ xdr: string; kind: "trustline" | "account+trustline" }> {
  const kp = platformKeypair();
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
 * NOTE: the sponsor path is intentionally NOT serialized by `seqMutex` (simple
 * strategy; payUsdc self-heals via its tx_bad_seq retry).
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
