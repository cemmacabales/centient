import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

// Issue #2: native 2-of-3 multisig for the payout account. evaluateMultisig is
// the pure, network-free predicate that both the on-chain verifier and the
// idempotent setup script build on, so it carries the security-critical rules:
// "≥ 2 signatures required" and "master key alone cannot pay".

import { evaluateMultisig, TARGET_MULTISIG } from "../multisig";

const MASTER = Keypair.random().publicKey();
const OPS = Keypair.random().publicKey();
const POLICY = Keypair.random().publicKey();

type Signer = { key: string; weight: number; type?: string };
type Thresholds = { low_threshold: number; med_threshold: number; high_threshold: number };

/** A minimal Horizon account record with the fields evaluateMultisig reads. */
function account(signers: Signer[], thresholds: Thresholds) {
  return { id: MASTER, signers, thresholds };
}

/** The correctly configured 2-of-3: master w=1, ops w=1, policy w=1, thresholds 2. */
function configuredAccount() {
  return account(
    [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      { key: OPS, weight: 1, type: "ed25519_public_key" },
      { key: POLICY, weight: 1, type: "ed25519_public_key" },
    ],
    { low_threshold: 2, med_threshold: 2, high_threshold: 2 },
  );
}

const signerSet = { opsPublic: OPS, policyPublic: POLICY };

describe("evaluateMultisig", () => {
  it("fails DoD for a fresh single-key account (master weight 1, thresholds 0)", () => {
    const acct = account(
      [{ key: MASTER, weight: 1, type: "ed25519_public_key" }],
      { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    );

    const result = evaluateMultisig(acct, signerSet);

    expect(result.satisfiesDod).toBe(false);
    expect(result.matchesTarget).toBe(false);
  });

  it("passes DoD and matches target for the correctly configured 2-of-3", () => {
    const result = evaluateMultisig(configuredAccount(), signerSet);

    expect(result.satisfiesDod).toBe(true);
    expect(result.matchesTarget).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("fails DoD when the master alone can reach the payment threshold", () => {
    // Master weight equals the med threshold → master alone can pay: forbidden.
    const acct = account(
      [
        { key: MASTER, weight: 2, type: "ed25519_public_key" },
        { key: OPS, weight: 1, type: "ed25519_public_key" },
        { key: POLICY, weight: 1, type: "ed25519_public_key" },
      ],
      { low_threshold: 2, med_threshold: 2, high_threshold: 2 },
    );

    const result = evaluateMultisig(acct, signerSet);

    expect(result.satisfiesDod).toBe(false);
    expect(result.reasons.some((r) => /master/i.test(r))).toBe(true);
  });

  it("fails DoD with only one co-signer (fewer than 2 independent signers)", () => {
    const acct = account(
      [
        { key: MASTER, weight: 1, type: "ed25519_public_key" },
        { key: OPS, weight: 1, type: "ed25519_public_key" },
      ],
      { low_threshold: 2, med_threshold: 2, high_threshold: 2 },
    );

    const result = evaluateMultisig(acct, signerSet);

    expect(result.satisfiesDod).toBe(false);
  });

  it("satisfies DoD but does not match target when med/high exceed the target 2", () => {
    // med/high = 3 with three w=1 signers is stricter than target: still no single
    // key can pay (DoD holds), but it is not the exact target the setup writes.
    const acct = account(
      [
        { key: MASTER, weight: 1, type: "ed25519_public_key" },
        { key: OPS, weight: 1, type: "ed25519_public_key" },
        { key: POLICY, weight: 1, type: "ed25519_public_key" },
      ],
      { low_threshold: 2, med_threshold: 3, high_threshold: 3 },
    );

    const result = evaluateMultisig(acct, signerSet);

    expect(result.satisfiesDod).toBe(true);
    expect(result.matchesTarget).toBe(false);
  });

  it("exposes the target shape it configures", () => {
    expect(TARGET_MULTISIG).toEqual({
      masterWeight: 1,
      low: 2,
      med: 2,
      high: 2,
      cosignerWeight: 1,
    });
  });
});
