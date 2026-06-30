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

      // Stale sequence — reload + resubmit exactly once.
      if (codes.transaction === "tx_bad_seq") {
        return await buildSignSubmit(kp, to, amountUsdc);
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
