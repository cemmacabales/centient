// Freighter proof harness — the server half of the #24 wallet-signing spike.
//
// Proves on testnet, with the real Freighter extension, the two signing paths
// Deliverable 2 builds on (ADR-0003: Freighter only):
//
//   1. Ownership proof. A one-time challenge bound to the address, network,
//      action, nonce and expiry, signed with Freighter's SEP-53 `signMessage`
//      and checked by the same `verify()` the wallet-link route uses.
//   2. Sponsored onboarding. A CAP-33 sandwich (begin / [createAccount] /
//      changeTrust USDC / end) that the sponsor builds and signs, Freighter
//      co-signs, and the server inspects before submitting — optionally wrapped
//      in a fee bump with the sponsor as fee source.
//
// This is spike tooling, not product code. It is off unless
// WALLET_PROOF_HARNESS=1 on testnet, keeps its state in process memory, and
// sponsors from a throwaway friendbot-funded key. It never reads a platform
// secret, so running it cannot touch the payout rail's key custody.
import { randomBytes } from "crypto";
import {
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  type Asset,
} from "@stellar/stellar-sdk";
import { networkPassphrase, server, usdcAsset } from "./config";
import { isValidStellarAddress, verify } from "./signature";
import { CHALLENGE_TTL_MS, buildChallengeMessage, type ChallengeFields } from "./challenge-message";
import { friendbotFund } from "../qa-fixtures/friendbot";

/** True only when the harness is explicitly switched on and pointed at testnet. */
export function harnessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WALLET_PROOF_HARNESS?.trim() !== "1") return false;
  return (env.STELLAR_NETWORK ?? "testnet").trim().toLowerCase() === "testnet";
}

/** A spike failure with a stable code the route can map to a status. */
export class HarnessError extends Error {
  constructor(
    readonly code: "already_trusted" | "submit_failed",
    message: string,
  ) {
    super(message);
    this.name = "HarnessError";
  }
}

// ---------------------------------------------------------------------------
// Ownership proof
// ---------------------------------------------------------------------------

// The signed format is shared with production sign-in (#25); see
// challenge-message.ts. Re-exported so harness callers keep one import.
export {
  CHALLENGE_TTL_MS,
  PROOF_ACTION,
  buildChallengeMessage,
  type ChallengeFields,
} from "./challenge-message";

export interface IssuedChallenge extends ChallengeFields {
  message: string;
}

export type ProofRejection =
  | "invalid_address"
  | "unknown_nonce"
  | "replayed"
  | "expired"
  | "wrong_address"
  | "wrong_signer"
  | "bad_signature";

export type ProofResult =
  | { ok: true; challenge: IssuedChallenge }
  | { ok: false; reason: ProofRejection };

/**
 * Upper bound on outstanding challenges. The challenge endpoint is
 * unauthenticated, so without a bound a caller in a loop grows this process's
 * memory — and on a shared deployment that process also runs the payout worker.
 */
export const MAX_OUTSTANDING_CHALLENGES = 1000;

/**
 * One-time challenges, held in memory for the life of the process.
 *
 * Nothing is kept past the point it could matter: an issued challenge is dropped
 * once it expires, and a consumed nonce is remembered only until its challenge
 * would have expired. A replay after that still fails, as `unknown_nonce`.
 */
export class ChallengeStore {
  private readonly issued = new Map<string, IssuedChallenge>();
  /** Consumed nonce → the expiry (ms) of the challenge it belonged to. */
  private readonly consumed = new Map<string, number>();

  /** Outstanding and remembered-consumed counts. */
  get size(): { issued: number; consumed: number } {
    return { issued: this.issued.size, consumed: this.consumed.size };
  }

  private prune(now: Date): void {
    const t = now.getTime();
    for (const [nonce, challenge] of this.issued) {
      if (challenge.expiresAt.getTime() < t) this.issued.delete(nonce);
    }
    for (const [nonce, expiresAt] of this.consumed) {
      if (expiresAt < t) this.consumed.delete(nonce);
    }
  }

  issue(
    address: string,
    now: Date = new Date(),
    passphrase: string = networkPassphrase(),
  ): IssuedChallenge {
    this.prune(now);
    // At the cap, evict the oldest outstanding challenge (Map keys iterate in
    // insertion order). A flood can therefore invalidate someone's pending
    // challenge — acceptable for spike tooling, where the fix is to re-issue.
    while (this.issued.size >= MAX_OUTSTANDING_CHALLENGES) {
      const oldest = this.issued.keys().next().value;
      if (oldest === undefined) break;
      this.issued.delete(oldest);
    }

    const fields: ChallengeFields = {
      address,
      networkPassphrase: passphrase,
      nonce: randomBytes(16).toString("hex"),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
    };
    const challenge = { ...fields, message: buildChallengeMessage(fields) };
    this.issued.set(challenge.nonce, challenge);
    return challenge;
  }

  /**
   * Verify an ownership proof. The first attempt consumes the nonce whatever
   * its outcome, so a failed attempt cannot be retried against the same
   * challenge — the caller must request a new one.
   */
  verify({
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
  }): ProofResult {
    if (!isValidStellarAddress(address)) return { ok: false, reason: "invalid_address" };
    if (this.consumed.has(nonce)) return { ok: false, reason: "replayed" };

    const challenge = this.issued.get(nonce);
    if (!challenge) return { ok: false, reason: "unknown_nonce" };
    this.issued.delete(nonce);
    this.consumed.set(nonce, challenge.expiresAt.getTime());

    if (now.getTime() > challenge.expiresAt.getTime()) return { ok: false, reason: "expired" };
    if (challenge.address !== address) return { ok: false, reason: "wrong_address" };
    if (signerAddress !== undefined && signerAddress !== address) {
      return { ok: false, reason: "wrong_signer" };
    }
    if (!verify(address, challenge.message, signature)) {
      return { ok: false, reason: "bad_signature" };
    }
    return { ok: true, challenge };
  }
}

/** One assertion recorded as evidence: what was expected, and whether it held. */
export interface ProofCheck {
  name: string;
  expect: "accept" | "reject";
  passed: boolean;
  detail?: string;
}

function check(
  name: string,
  expect: ProofCheck["expect"],
  accepted: boolean,
  detail?: string,
): ProofCheck {
  const passed = expect === "accept" ? accepted : !accepted;
  return detail === undefined ? { name, expect, passed } : { name, expect, passed, detail };
}

/**
 * Negative verification rules, exercised against a real Freighter signature:
 * the same signature must fail the moment any bound field changes.
 */
export function signatureChecks(challenge: IssuedChallenge, signature: string): ProofCheck[] {
  const { address, message } = challenge;
  const sigBytes = Buffer.from(signature, "base64");
  const flipped = Buffer.from(sigBytes);
  if (flipped.length > 0) flipped[0] ^= 0x01;

  const otherNetwork = buildChallengeMessage({
    ...challenge,
    networkPassphrase:
      challenge.networkPassphrase === Networks.PUBLIC ? Networks.TESTNET : Networks.PUBLIC,
  });
  const otherNonce = buildChallengeMessage({
    ...challenge,
    nonce: "0".repeat(challenge.nonce.length),
  });

  let rawMessageVerifies = false;
  try {
    rawMessageVerifies =
      sigBytes.length === 64 &&
      Keypair.fromPublicKey(address).verify(Buffer.from(message, "utf8"), sigBytes);
  } catch {
    rawMessageVerifies = false;
  }

  return [
    check("Signature verifies over the issued challenge (SEP-53)", "accept", verify(address, message, signature)),
    check("Signature is over the SEP-53 digest, not the raw message", "reject", rawMessageVerifies),
    check("Same signature rejected for a different nonce", "reject", verify(address, otherNonce, signature)),
    check("Same signature rejected for the other network", "reject", verify(address, otherNetwork, signature)),
    check(
      "Same signature rejected for a different address",
      "reject",
      verify(Keypair.random().publicKey(), message, signature),
    ),
    check("Bit-flipped signature rejected", "reject", verify(address, message, flipped.toString("base64"))),
    check(
      "Truncated signature rejected",
      "reject",
      verify(address, message, sigBytes.subarray(0, 63).toString("base64")),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Sponsored onboarding
// ---------------------------------------------------------------------------

export type OnboardingKind = "trustline" | "account+trustline";

export const ONBOARDING_OPS: Record<OnboardingKind, string[]> = {
  trustline: ["beginSponsoringFutureReserves", "changeTrust", "endSponsoringFutureReserves"],
  "account+trustline": [
    "beginSponsoringFutureReserves",
    "createAccount",
    "changeTrust",
    "endSponsoringFutureReserves",
  ],
};

/** A built sponsorship awaiting the recipient's Freighter signature. */
export interface PendingSponsorship {
  recipient: string;
  kind: OnboardingKind;
  hash: string;
  sponsor: string;
  before: RecipientStatus;
}

export interface RecipientStatus {
  address: string;
  exists: boolean;
  xlmBalance: string | null;
  usdcTrustline: boolean;
  usdcTrustlineSponsor: string | null;
  accountSponsor: string | null;
}

interface HarnessState {
  challenges: ChallengeStore;
  pending: Map<string, PendingSponsorship>;
  sponsor: Promise<Keypair> | null;
}

const globalForHarness = globalThis as unknown as { __freighterProofHarness?: HarnessState };

/**
 * Process-wide harness state. Held on `globalThis` because dev-mode bundling
 * and hot reload can evaluate this module more than once, and a challenge
 * issued by one request must still be verifiable by the next.
 */
export function harnessState(): HarnessState {
  globalForHarness.__freighterProofHarness ??= {
    challenges: new ChallengeStore(),
    pending: new Map(),
    sponsor: null,
  };
  return globalForHarness.__freighterProofHarness;
}

/** A throwaway friendbot-funded sponsor, created once per process. */
export function harnessSponsor(state: HarnessState = harnessState()): Promise<Keypair> {
  if (!state.sponsor) {
    const keypair = Keypair.random();
    state.sponsor = friendbotFund(keypair.publicKey()).then(
      () => keypair,
      (err: unknown) => {
        state.sponsor = null;
        throw err;
      },
    );
  }
  return state.sponsor;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; response?: { status?: number } } | null;
  return e?.response?.status === 404 || e?.name === "NotFoundError";
}

/** What Horizon says about the recipient: existence, XLM, and who sponsors what. */
export async function loadRecipientStatus(
  address: string,
  asset: Asset = usdcAsset(),
): Promise<RecipientStatus> {
  try {
    const account = await server().loadAccount(address);
    const record = account as unknown as {
      sponsor?: string;
      balances: Array<{
        asset_type: string;
        balance: string;
        asset_code?: string;
        asset_issuer?: string;
        sponsor?: string;
      }>;
    };
    const native = record.balances.find((b) => b.asset_type === "native");
    const usdc = record.balances.find(
      (b) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
    );
    return {
      address,
      exists: true,
      xlmBalance: native?.balance ?? null,
      usdcTrustline: Boolean(usdc),
      usdcTrustlineSponsor: usdc?.sponsor ?? null,
      accountSponsor: record.sponsor ?? null,
    };
  } catch (err) {
    if (!isNotFound(err)) throw err;
    return {
      address,
      exists: false,
      xlmBalance: null,
      usdcTrustline: false,
      usdcTrustlineSponsor: null,
      accountSponsor: null,
    };
  }
}

/**
 * The sponsored onboarding sandwich, in the same operation order the product
 * path (`buildSponsoredTrustlineTx`) uses. The sponsor is the transaction
 * source and pays the fee; the recipient sources `changeTrust` and
 * `endSponsoringFutureReserves`, so both must sign.
 */
export function buildSponsoredOnboardingTx({
  sponsorAccount,
  recipient,
  asset,
  kind,
  fee = BASE_FEE,
  passphrase = networkPassphrase(),
  timeoutSeconds = 300,
}: {
  sponsorAccount: ConstructorParameters<typeof TransactionBuilder>[0];
  recipient: string;
  asset: Asset;
  kind: OnboardingKind;
  fee?: string;
  passphrase?: string;
  timeoutSeconds?: number;
}): Transaction {
  if (!StrKey.isValidEd25519PublicKey(recipient)) {
    throw new Error(`recipient must be a valid Stellar public key (G…), got "${recipient}"`);
  }
  const builder = new TransactionBuilder(sponsorAccount, {
    fee,
    networkPassphrase: passphrase,
  }).addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: recipient }));
  if (kind === "account+trustline") {
    builder.addOperation(Operation.createAccount({ destination: recipient, startingBalance: "0" }));
  }
  return builder
    .addOperation(Operation.changeTrust({ asset, source: recipient }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: recipient }))
    .setTimeout(timeoutSeconds)
    .build();
}

/** Build and sponsor-sign the onboarding transaction for `recipient`. */
export async function prepareSponsoredOnboarding(
  recipient: string,
  state: HarnessState = harnessState(),
): Promise<PendingSponsorship & { xdr: string; operations: string[] }> {
  const sponsor = await harnessSponsor(state);
  const before = await loadRecipientStatus(recipient);
  if (before.usdcTrustline) {
    throw new HarnessError(
      "already_trusted",
      "This address already has a USDC trustline. Use a brand-new Freighter account to prove the sponsored path.",
    );
  }

  const kind: OnboardingKind = before.exists ? "trustline" : "account+trustline";
  const horizon = server();
  const [sponsorAccount, fee] = await Promise.all([
    horizon.loadAccount(sponsor.publicKey()),
    horizon.fetchBaseFee().catch(() => Number(BASE_FEE)),
  ]);
  const tx = buildSponsoredOnboardingTx({
    sponsorAccount,
    recipient,
    asset: usdcAsset(),
    kind,
    fee: String(fee),
  });
  tx.sign(sponsor);

  const pending: PendingSponsorship = {
    recipient,
    kind,
    hash: tx.hash().toString("hex"),
    sponsor: sponsor.publicKey(),
    before,
  };
  state.pending.set(recipient, pending);
  return { ...pending, xdr: tx.toXDR(), operations: tx.operations.map((op) => op.type) };
}

function signedBy(tx: Transaction, publicKey: string): boolean {
  const keypair = Keypair.fromPublicKey(publicKey);
  const hint = keypair.signatureHint();
  const txHash = tx.hash();
  return tx.signatures.some(
    (sig) => sig.hint().equals(hint) && keypair.verify(txHash, sig.signature()),
  );
}

/**
 * Everything the server must establish about a Freighter-co-signed envelope
 * before it may submit it. Each rule is recorded as a check so the evidence
 * shows what held, not just that submission succeeded.
 */
export function inspectCoSignedEnvelope({
  signedXdr,
  pending,
  passphrase = networkPassphrase(),
}: {
  signedXdr: string;
  pending: Pick<PendingSponsorship, "recipient" | "kind" | "hash" | "sponsor">;
  passphrase?: string;
}): { ok: boolean; checks: ProofCheck[]; tx: Transaction | null } {
  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(signedXdr, passphrase);
  } catch (err) {
    return {
      ok: false,
      checks: [check("Envelope parses", "accept", false, (err as Error).message)],
      tx: null,
    };
  }
  if (parsed instanceof FeeBumpTransaction) {
    return {
      ok: false,
      checks: [check("Envelope is a plain transaction, not a fee bump", "accept", false)],
      tx: null,
    };
  }

  const tx = parsed;
  const types = tx.operations.map((op) => op.type);
  const begin = tx.operations[0] as { sponsoredId?: string };
  const changeTrust = tx.operations.find((op) => op.type === "changeTrust") as
    | { source?: string }
    | undefined;
  const end = tx.operations.find((op) => op.type === "endSponsoringFutureReserves") as
    | { source?: string }
    | undefined;
  const shapeHolds =
    JSON.stringify(types) === JSON.stringify(ONBOARDING_OPS[pending.kind]) &&
    begin.sponsoredId === pending.recipient &&
    changeTrust?.source === pending.recipient &&
    end?.source === pending.recipient;

  // The same bytes read under the other network's passphrase hash differently,
  // so a signature made for this network must not verify there.
  const otherNetwork = passphrase === Networks.PUBLIC ? Networks.TESTNET : Networks.PUBLIC;
  const onOtherNetwork = TransactionBuilder.fromXDR(signedXdr, otherNetwork) as Transaction;
  const hash = tx.hash().toString("hex");

  const checks = [
    check("Envelope is a plain transaction, not a fee bump", "accept", true),
    check("Transaction bytes unchanged since the sponsor signed (hash matches)", "accept", hash === pending.hash, hash),
    check("Operations are exactly the sponsored onboarding sandwich", "accept", shapeHolds, types.join(", ")),
    check("Sponsor signature still valid", "accept", signedBy(tx, pending.sponsor)),
    check("Recipient (Freighter) signature valid for this network", "accept", signedBy(tx, pending.recipient)),
    check(
      "Recipient signature does not verify under the other network's passphrase",
      "reject",
      signedBy(onOtherNetwork, pending.recipient),
    ),
    check(
      "No signatures beyond sponsor and recipient",
      "accept",
      tx.signatures.length === 2,
      `${tx.signatures.length} signature(s)`,
    ),
  ];
  return { ok: checks.every((c) => c.passed), checks, tx };
}

function describeHorizonError(err: unknown): string {
  const codes = (err as { response?: { data?: { extras?: { result_codes?: unknown } } } })
    ?.response?.data?.extras?.result_codes;
  if (codes) return JSON.stringify(codes);
  return err instanceof Error ? err.message : String(err);
}

/**
 * Submit the co-signed onboarding transaction. With `feeBump`, the envelope is
 * wrapped in a fee bump the sponsor signs as fee source — the wrapper the SOW
 * names — so the recipient's signature is proven to survive it.
 */
export async function submitSponsoredOnboarding({
  tx,
  feeBump,
  state = harnessState(),
  passphrase = networkPassphrase(),
}: {
  tx: Transaction;
  feeBump: boolean;
  state?: HarnessState;
  passphrase?: string;
}): Promise<{ hash: string; innerHash: string; feeBump: boolean; feeBumpFee?: string }> {
  const sponsor = await harnessSponsor(state);
  const innerHash = tx.hash().toString("hex");
  const horizon = server();
  try {
    if (!feeBump) {
      const res = await horizon.submitTransaction(tx);
      return { hash: res.hash, innerHash, feeBump: false };
    }
    // A fee bump's per-operation rate must be at least the inner rate.
    const innerRate = BigInt(tx.fee) / BigInt(tx.operations.length);
    const baseFee = (innerRate * 2n > 200n ? innerRate * 2n : 200n).toString();
    const bump = TransactionBuilder.buildFeeBumpTransaction(sponsor, baseFee, tx, passphrase);
    bump.sign(sponsor);
    const res = await horizon.submitTransaction(bump);
    return { hash: res.hash, innerHash, feeBump: true, feeBumpFee: bump.fee };
  } catch (err) {
    throw new HarnessError("submit_failed", describeHorizonError(err));
  }
}
