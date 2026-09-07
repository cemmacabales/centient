// Sequence-safe submission of multisig payouts (issue #7).
//
// This is the network-facing half of the payout service. It replaces the
// single-key broadcast in `client.payUsdc` for contributor payouts: every payout
// leaves here as a fee-bumped envelope carrying two independent signatures, ours
// and the co-signing policy service's (issue #8).
//
// Sequence safety. The multisig payout account has exactly one sequence number,
// so account-load and submit must not interleave across concurrent payouts. The
// whole build → sign → co-sign → submit cycle runs inside one mutex, which is
// this module's single owner of that critical section — the same ownership rule
// `payUsdc` documents for its own `seqMutex`, moved up to the layer that now
// spans two co-signer round trips. Holding the lock across those round trips is
// deliberate: a slow co-signer serializes payouts, which is correct, where a
// released lock would hand two payouts the same sequence number.
import {
  BASE_FEE,
  Keypair,
  type Asset,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";
import { Mutex } from "async-mutex";
import { StellarPaymentError, getTxStatus, resultCodes } from "./client";
import { server, usdcAsset } from "./config";
import { buildMultisigFeeBump } from "./multisig-payout";
import { assertPayoutAmountUnits, assertPayoutDestination } from "./payout-amount";
import type { PayoutReference } from "./payout-envelope";
import {
  applyCoSignature,
  assertPayoutFullySigned,
  buildPayoutPayment,
  signAsPlatform,
  type PayoutCoSigner,
} from "./payout-envelope";

export type PayoutEnvironment = Readonly<Record<string, string | undefined>>;

/** The payout account and the two independent identities that must both sign. */
export interface PayoutSignerConfig {
  payoutAccount: string;
  /** Our own signing key — signature #1, held in this process. */
  platformSigner: Keypair;
  /** The co-signing service's key — signature #2. We hold only the public half. */
  coSignerPublicKey: string;
}

/** How long to wait between Horizon lookups while an outcome is unknown. */
const DEFAULT_AMBIGUOUS_POLL_INTERVAL_MS = 2_000;

/** Resolve after `ms`, used to space out Horizon lookups while an outcome is unknown. */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One payout to settle, in exact integer units. */
export interface PayoutRequest {
  reference: PayoutReference;
  destination: string;
  amountUnits: bigint;
}

/**
 * Did Horizon give a definite verdict? A rejection carrying result codes means the
 * transaction was evaluated and never applied, so rebuilding is safe. Anything
 * without them — a timeout, a dropped socket, a 5xx after acceptance — leaves the
 * outcome genuinely unknown.
 */
function isDefiniteRejection(err: unknown): boolean {
  const codes = resultCodes(err);
  return Boolean(codes.transaction || codes.operations?.length);
}

/**
 * Unix milliseconds after which `feeBump` can never be included in a ledger. A
 * fee bump inherits the inner transaction's time bounds, and this deadline is
 * what makes a retry provably safe rather than merely probably safe.
 */
function envelopeExpiryMs(feeBump: FeeBumpTransaction): number | null {
  const maxTime = feeBump.innerTransaction.timeBounds?.maxTime;
  if (!maxTime || maxTime === "0") return null;
  return Number(maxTime) * 1000;
}

/**
 * Settle an unknown submit outcome by identity rather than by guessing.
 *
 * The envelope hash is known before submission, so an ambiguous failure never has
 * to be resolved by rebuilding — we ask Horizon what happened to that exact
 * transaction. Polling continues until the transaction is found, or until its
 * time bounds expire and it can no longer be included by anyone. Only then is a
 * rebuild safe, and only then is the failure reported as retryable.
 *
 * An envelope with no time bounds cannot be proven dead, so it is reported as
 * non-retryable and left for manual reconciliation rather than risking a second
 * settlement.
 */
async function resolveAmbiguousSubmit(
  envelopeHash: string,
  feeBump: FeeBumpTransaction,
  request: PayoutRequest,
  pollIntervalMs: number,
): Promise<{ hash: string }> {
  const expiresAt = envelopeExpiryMs(feeBump);

  for (;;) {
    const status = await getTxStatus(envelopeHash);
    if (status === "confirmed") return { hash: envelopeHash };
    if (status === "failed") {
      throw new StellarPaymentError(
        `submitMultisigPayout: ${request.reference.kind} ${request.reference.id} — transaction ${envelopeHash} was included and failed`,
        "tx_failed",
        false,
      );
    }
    if (expiresAt === null) {
      throw new StellarPaymentError(
        `submitMultisigPayout: ${request.reference.kind} ${request.reference.id} — submit outcome unknown for ${envelopeHash} and the envelope has no time bounds; reconcile manually before reissuing`,
        "ambiguous_submit",
        false,
      );
    }
    if (Date.now() > expiresAt) {
      throw new StellarPaymentError(
        `submitMultisigPayout: ${request.reference.kind} ${request.reference.id} — ${envelopeHash} never appeared and its time bounds have expired; safe to rebuild`,
        "ambiguous_submit",
        true,
      );
    }
    await delay(pollIntervalMs);
  }
}

/** Read one required environment value without applying an unsafe default. */
function requireEnv(env: PayoutEnvironment, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * Read the payout signing identities. The co-signer's key must differ from our
 * own: two signatures from one party is not a 2-of-3, and a misconfiguration
 * that pointed both at the same key would silently restore single-key control.
 */
export function parsePayoutSignerConfig(
  env: PayoutEnvironment = process.env,
): PayoutSignerConfig {
  const payoutAccount = requireEnv(env, "STELLAR_PLATFORM_ACCOUNT").trim();
  assertPayoutDestination(payoutAccount, "STELLAR_PLATFORM_ACCOUNT");
  const platformSigner = Keypair.fromSecret(
    requireEnv(env, "STELLAR_OPS_SIGNER_SECRET").trim(),
  );
  const coSignerPublicKey = requireEnv(env, "STELLAR_POLICY_SIGNER_PUBLIC").trim();
  assertPayoutDestination(coSignerPublicKey, "STELLAR_POLICY_SIGNER_PUBLIC");

  if (coSignerPublicKey === platformSigner.publicKey()) {
    throw new Error(
      "STELLAR_POLICY_SIGNER_PUBLIC must be independent of STELLAR_OPS_SIGNER_SECRET — two signatures from one key is not a 2-of-3",
    );
  }
  return { payoutAccount, platformSigner, coSignerPublicKey };
}

/**
 * Build, dual-sign, and submit one payout against the account's current
 * sequence. Called only from inside the mutex, and re-entered whole on a stale
 * sequence: a rebuilt envelope has a new hash, so both stages are co-signed
 * again rather than carrying signatures over.
 */
async function buildCoSignSubmit(
  request: PayoutRequest,
  config: PayoutSignerConfig,
  asset: Asset,
  coSigner: PayoutCoSigner,
  timeoutSeconds: number | undefined,
  pollIntervalMs: number,
): Promise<{ hash: string }> {
  const srv = server();
  const account = await srv.loadAccount(config.payoutAccount);
  const fee = await srv.fetchBaseFee().catch(() => Number(BASE_FEE));
  const requiredSigners = [
    config.platformSigner.publicKey(),
    config.coSignerPublicKey,
  ] as const;

  const payment: Transaction = buildPayoutPayment({
    sourceAccount: account,
    destination: request.destination,
    asset,
    amountUnits: request.amountUnits,
    fee: String(fee),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  });
  signAsPlatform(payment, config.platformSigner);
  applyCoSignature(
    payment,
    await coSigner.signPayout({
      stage: "payment",
      xdr: payment.toXDR(),
      destination: request.destination,
      amountUnits: request.amountUnits,
      reference: request.reference,
    }),
    config.coSignerPublicKey,
  );
  assertPayoutFullySigned(payment, requiredSigners);

  // Centient pays the XLM fee from the payout account, so the recipient can hold
  // and spend zero XLM — the property issue #6 proved on testnet.
  const feeBump = buildMultisigFeeBump({
    feeSource: config.payoutAccount,
    baseFee: String(fee),
    innerTransaction: payment,
    requiredSignerPublicKeys: requiredSigners,
  });
  signAsPlatform(feeBump, config.platformSigner);
  applyCoSignature(
    feeBump,
    await coSigner.signPayout({
      stage: "fee_bump",
      xdr: feeBump.toXDR(),
      destination: request.destination,
      amountUnits: request.amountUnits,
      reference: request.reference,
    }),
    config.coSignerPublicKey,
  );
  assertPayoutFullySigned(feeBump, requiredSigners);

  // Known before submission, which is what makes an unknown outcome recoverable:
  // the transaction can be identified afterwards without rebuilding it.
  const envelopeHash = feeBump.hash().toString("hex");
  try {
    const res = await srv.submitTransaction(feeBump);
    return { hash: res.hash };
  } catch (err) {
    if (isDefiniteRejection(err)) throw err;
    return resolveAmbiguousSubmit(envelopeHash, feeBump, request, pollIntervalMs);
  }
}

/**
 * The single owner of account-load + submit for the payout account.
 *
 * Process-local. It serializes concurrent payouts inside one Node process and
 * nothing beyond it, so the deployment must run exactly one payout submitter — a
 * second web instance, a standalone worker alongside the in-process one, or the
 * retry cron running concurrently with the worker can all draw the same sequence.
 * That collision costs throughput rather than correctness (the loser gets
 * tx_bad_seq, rebuilds once, then fails retryably and requeues), but scaling this
 * path horizontally needs a distributed lock spanning the whole cycle below, not
 * just the submit. Inherited from payUsdc's seqMutex; see the payout service
 * runbook.
 */
const payoutSeqMutex = new Mutex();

/**
 * Settle one payout as a two-signature, fee-bumped USDC payment. Returns the
 * submitted transaction hash.
 *
 * Failure modes match the rail's existing contract so callers need no new
 * branches: `op_no_trust` (recipient holds no USDC trustline) and
 * `op_no_destination` (recipient unfunded) are permanent and must be marked
 * failed, never retried. A stale sequence is rebuilt and resubmitted once here;
 * sustained contention surfaces as a *retryable* error so the worker requeues
 * with its own backoff rather than spinning inside the lock.
 *
 * A co-signer that refuses, or answers with the wrong key or a signature that
 * does not verify, aborts before submission — there is no path from here to a
 * single-signature payout.
 */
export async function submitMultisigPayout(
  request: PayoutRequest,
  {
    coSigner,
    config,
    asset,
    timeoutSeconds,
    ambiguousPollIntervalMs = DEFAULT_AMBIGUOUS_POLL_INTERVAL_MS,
  }: {
    coSigner: PayoutCoSigner;
    config?: PayoutSignerConfig;
    asset?: Asset;
    timeoutSeconds?: number;
    ambiguousPollIntervalMs?: number;
  },
): Promise<{ hash: string }> {
  // Validate before taking the lock or touching Horizon: an unpayable request
  // should never occupy the payout account's critical section.
  assertPayoutDestination(request.destination);
  assertPayoutAmountUnits(request.amountUnits);
  const resolved = config ?? parsePayoutSignerConfig();
  const payAsset = asset ?? usdcAsset();

  return payoutSeqMutex.runExclusive(async () => {
    try {
      return await buildCoSignSubmit(
        request,
        resolved,
        payAsset,
        coSigner,
        timeoutSeconds,
        ambiguousPollIntervalMs,
      );
    } catch (err) {
      const codes = resultCodes(err);

      if (codes.operations?.includes("op_no_destination")) {
        throw new StellarPaymentError(
          `submitMultisigPayout: destination ${request.destination} does not exist or is unfunded (op_no_destination)`,
          "op_no_destination",
          false,
        );
      }
      if (codes.operations?.includes("op_no_trust")) {
        throw new StellarPaymentError(
          `submitMultisigPayout: destination ${request.destination} has no USDC trustline (op_no_trust)`,
          "op_no_trust",
          false,
        );
      }

      if (codes.transaction === "tx_bad_seq") {
        try {
          return await buildCoSignSubmit(
        request,
        resolved,
        payAsset,
        coSigner,
        timeoutSeconds,
        ambiguousPollIntervalMs,
      );
        } catch (retryErr) {
          if (resultCodes(retryErr).transaction === "tx_bad_seq") {
            throw new StellarPaymentError(
              `submitMultisigPayout: ${request.reference.kind} ${request.reference.id} — sustained sequence contention (tx_bad_seq after one rebuild); requeue`,
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
