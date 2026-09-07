// Native Stellar multisig for the payout (hot) account — issue #2.
//
// The payout account must be a 2-of-3 native multisig so no single key can move
// contributor funds: master + two independent co-signers (ops, policy), each
// weight 1, with low/med/high thresholds all 2. Any 2 of the 3 keys sign a
// payment; the master alone (weight 1 < threshold 2) cannot.
//
// This module is the network-free core shared by the setup script (which builds
// and submits the setOptions transaction) and the verifier (which asserts the
// on-chain config). Keeping the rules here — not duplicated in each script —
// means "≥ 2 signatures" and "master alone cannot pay" have one definition, and
// that definition is unit-tested without touching Horizon.
import {
  Operation,
  TransactionBuilder,
  BASE_FEE,
  StrKey,
  type Keypair,
  type Transaction,
} from "@stellar/stellar-sdk";
import { networkPassphrase } from "./config";

/** The exact multisig shape the setup script writes and the verifier expects. */
export const TARGET_MULTISIG = {
  masterWeight: 1,
  low: 2,
  med: 2,
  high: 2,
  cosignerWeight: 1,
} as const;

/**
 * The account's own (master) key plus the two independent co-signer public keys
 * (all G…). `masterPublic` is passed explicitly rather than read off the Horizon
 * record so master identification never depends on the record's `.id` field.
 */
export interface SignerSet {
  masterPublic: string;
  opsPublic: string;
  policyPublic: string;
}

/** Minimal shape of a Horizon account record that {@link evaluateMultisig} reads. */
export interface AccountLike {
  signers: ReadonlyArray<{ key: string; weight: number; type?: string }>;
  thresholds: {
    low_threshold: number;
    med_threshold: number;
    high_threshold: number;
  };
}

export interface MultisigEvaluation {
  /**
   * The account meets the issue #2 Definition of Done: payments need ≥ 2
   * signatures and the master key alone cannot reach the payment threshold.
   */
  satisfiesDod: boolean;
  /** The config equals {@link TARGET_MULTISIG} exactly — drives setup idempotency. */
  matchesTarget: boolean;
  /** Human-readable reasons the DoD is not met (empty when satisfiesDod is true). */
  reasons: string[];
}

/**
 * Evaluate a Horizon account record against the payout multisig requirements.
 *
 * `satisfiesDod` is the security gate: low/med/high all ≥ 2 AND ≥ 2 independent
 * Ed25519 co-signers with weight > 0 AND the configured ops & policy keys are
 * actually active signers AND master weight < med threshold. `matchesTarget` is
 * the stricter check the setup script uses to decide whether it can no-op.
 */
export function evaluateMultisig(
  account: AccountLike,
  { masterPublic, opsPublic, policyPublic }: SignerSet,
): MultisigEvaluation {
  const { med_threshold: med, high_threshold: high, low_threshold: low } =
    account.thresholds;

  // Only Ed25519 public-key signers (G…) are independent co-signers a party can
  // sign arbitrary payments with. `preauth_tx` / `sha256_hash` "signers" are not
  // keys, so they must not count toward the ≥ 2 independent-signer requirement.
  const keySigners = account.signers.filter(
    (s) => s.weight > 0 && StrKey.isValidEd25519PublicKey(s.key),
  );
  const weightOf = (key: string) =>
    keySigners.find((s) => s.key === key)?.weight ?? 0;

  const masterWeight = weightOf(masterPublic);
  const opsWeight = weightOf(opsPublic);
  const policyWeight = weightOf(policyPublic);
  const nonMasterSigners = keySigners.filter((s) => s.key !== masterPublic);

  const reasons: string[] = [];
  if (low < 2) reasons.push(`low threshold ${low} < 2`);
  if (med < 2) reasons.push(`med threshold ${med} < 2 (payment needs ≥ 2 signatures)`);
  if (high < 2) reasons.push(`high threshold ${high} < 2`);
  if (nonMasterSigners.length < 2) {
    reasons.push(
      `only ${nonMasterSigners.length} independent Ed25519 signer(s); need ≥ 2`,
    );
  }
  if (masterWeight >= med) {
    reasons.push(
      `master weight ${masterWeight} ≥ med threshold ${med} — master alone can pay`,
    );
  }
  // Assert the *intended* topology, not just "any two signers": a missing or
  // typoed STELLAR_OPS/POLICY_SIGNER_PUBLIC must fail rather than silently pass.
  if (opsWeight <= 0) {
    reasons.push(`configured ops signer ${opsPublic || "(unset)"} is not an active signer`);
  }
  if (policyWeight <= 0) {
    reasons.push(`configured policy signer ${policyPublic || "(unset)"} is not an active signer`);
  }

  const satisfiesDod = reasons.length === 0;

  const matchesTarget =
    masterWeight === TARGET_MULTISIG.masterWeight &&
    low === TARGET_MULTISIG.low &&
    med === TARGET_MULTISIG.med &&
    high === TARGET_MULTISIG.high &&
    opsWeight === TARGET_MULTISIG.cosignerWeight &&
    policyWeight === TARGET_MULTISIG.cosignerWeight &&
    nonMasterSigners.length === 2;

  return { satisfiesDod, matchesTarget, reasons };
}

/**
 * Build the unsigned setOptions transaction that turns a single-key account into
 * the target 2-of-3 multisig: add the ops and policy signers (weight 1 each),
 * lower the master weight to 1, and set low/med/high thresholds to 2.
 *
 * The caller signs with the master key and submits. Validates both signer keys
 * are well-formed G… public keys, and that ops, policy, and master are three
 * distinct keys — so a typo or copy-paste can't silently collapse the intended
 * 2-of-3 into a weaker 2-of-2 (or hand two of the three signatures to one party).
 */
export function buildSetOptionsTx({
  account,
  masterKey,
  opsPublic,
  policyPublic,
}: {
  account: ConstructorParameters<typeof TransactionBuilder>[0];
  masterKey: Keypair;
  opsPublic: string;
  policyPublic: string;
}): Transaction {
  for (const [label, key] of [
    ["ops", opsPublic],
    ["policy", policyPublic],
  ] as const) {
    if (!StrKey.isValidEd25519PublicKey(key)) {
      throw new Error(`${label} signer must be a valid Stellar public key (G…), got "${key}"`);
    }
  }
  const masterPublic = masterKey.publicKey();
  if (opsPublic === policyPublic) {
    throw new Error("ops and policy signers must be different keys — the same key twice is a 2-of-2, not a 2-of-3");
  }
  if (opsPublic === masterPublic || policyPublic === masterPublic) {
    throw new Error("ops and policy co-signers must each differ from the master key");
  }

  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: opsPublic, weight: TARGET_MULTISIG.cosignerWeight },
      }),
    )
    .addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: policyPublic, weight: TARGET_MULTISIG.cosignerWeight },
      }),
    )
    .addOperation(
      Operation.setOptions({
        masterWeight: TARGET_MULTISIG.masterWeight,
        lowThreshold: TARGET_MULTISIG.low,
        medThreshold: TARGET_MULTISIG.med,
        highThreshold: TARGET_MULTISIG.high,
      }),
    )
    .setTimeout(180)
    .build();
}
