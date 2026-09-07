import { describe, it, expect } from "vitest";
import { Account, Keypair } from "@stellar/stellar-sdk";

// Issue #2: native 2-of-3 multisig for the payout account. evaluateMultisig is
// the pure, network-free predicate that both the on-chain verifier and the
// idempotent setup script build on, so it carries the security-critical rules:
// "≥ 2 signatures required" and "master key alone cannot pay".

import { buildSetOptionsTx, evaluateMultisig, TARGET_MULTISIG } from "../multisig";

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

const signerSet = { masterPublic: MASTER, opsPublic: OPS, policyPublic: POLICY };

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

  it("fails DoD when the low threshold is below 2 even if med/high are 2", () => {
    // Low-threshold ops (e.g. bump_sequence, allow_trust) would be single-key
    // signable if low < 2, contradicting "no single key can act" — so it must fail.
    const acct = account(
      [
        { key: MASTER, weight: 1, type: "ed25519_public_key" },
        { key: OPS, weight: 1, type: "ed25519_public_key" },
        { key: POLICY, weight: 1, type: "ed25519_public_key" },
      ],
      { low_threshold: 1, med_threshold: 2, high_threshold: 2 },
    );

    const result = evaluateMultisig(acct, signerSet);

    expect(result.satisfiesDod).toBe(false);
    expect(result.reasons.some((r) => /low threshold/i.test(r))).toBe(true);
  });

  it("does not count non-key (preauth_tx / sha256_hash) signers as independent signers", () => {
    // A preauth_tx and a hash(x) signer are not keys a party can sign arbitrary
    // payments with, so the master plus these two is NOT a valid 2-of-3.
    const acct = account(
      [
        { key: MASTER, weight: 1, type: "ed25519_public_key" },
        { key: "TXXX000000000000000000000000000000000000000000000000000000", weight: 1, type: "preauth_tx" },
        { key: "XHASH00000000000000000000000000000000000000000000000000000", weight: 1, type: "sha256_hash" },
      ],
      { low_threshold: 2, med_threshold: 2, high_threshold: 2 },
    );

    const result = evaluateMultisig(acct, signerSet);

    expect(result.satisfiesDod).toBe(false);
    expect(result.reasons.some((r) => /independent Ed25519 signer/i.test(r))).toBe(true);
  });

  it("fails DoD when a configured co-signer key is absent from the account (missing/typoed env)", () => {
    // Two independent signers are present, but neither is the configured POLICY
    // key — a typoed STELLAR_POLICY_SIGNER_PUBLIC must fail, not pass on "any 2".
    const OTHER = Keypair.random().publicKey();
    const acct = account(
      [
        { key: MASTER, weight: 1, type: "ed25519_public_key" },
        { key: OPS, weight: 1, type: "ed25519_public_key" },
        { key: OTHER, weight: 1, type: "ed25519_public_key" },
      ],
      { low_threshold: 2, med_threshold: 2, high_threshold: 2 },
    );

    const result = evaluateMultisig(acct, signerSet);

    expect(result.satisfiesDod).toBe(false);
    expect(result.reasons.some((r) => /policy signer/i.test(r))).toBe(true);
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

describe("buildSetOptionsTx", () => {
  const masterKp = Keypair.random();
  const source = () => new Account(masterKp.publicKey(), "0");

  it("rejects a malformed co-signer public key", () => {
    expect(() =>
      buildSetOptionsTx({ account: source(), masterKey: masterKp, opsPublic: "not-a-key", policyPublic: POLICY }),
    ).toThrow(/valid Stellar public key/i);
  });

  it("rejects ops and policy being the same key (collapses 2-of-3 into 2-of-2)", () => {
    expect(() =>
      buildSetOptionsTx({ account: source(), masterKey: masterKp, opsPublic: OPS, policyPublic: OPS }),
    ).toThrow(/different keys/i);
  });

  it("rejects a co-signer equal to the master key", () => {
    expect(() =>
      buildSetOptionsTx({ account: source(), masterKey: masterKp, opsPublic: masterKp.publicKey(), policyPublic: POLICY }),
    ).toThrow(/differ from the master/i);
  });
});
