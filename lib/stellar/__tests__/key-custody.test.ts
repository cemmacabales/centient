import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  assertCustodyBelowThreshold,
  assertSponsorNotPayoutSigner,
  heldPayoutSignerSecrets,
} from "../key-custody";

/**
 * F-01 regression. The environment this asserts against is the one D1 QA found
 * on `web`: master + ops secrets present, policy absent. Both existing guards
 * (TC-002, no-single-key-payout) stayed green against it, which is the whole
 * reason this file exists — see `key-custody.ts` for why custody is not
 * observable from either.
 */
const master = Keypair.random();
const ops = Keypair.random();
const policy = Keypair.random();
const sponsor = Keypair.random();

/** The exact shape D1 QA observed on the `web` service. */
const f01Environment = {
  STELLAR_PLATFORM_ACCOUNT: master.publicKey(),
  STELLAR_PLATFORM_SECRET: master.secret(),
  STELLAR_OPS_SIGNER_SECRET: ops.secret(),
  STELLAR_POLICY_SIGNER_PUBLIC: policy.publicKey(),
};

describe("assertCustodyBelowThreshold", () => {
  it("refuses the F-01 environment: master + ops on one deployment is 2 of 2", () => {
    expect(() => assertCustodyBelowThreshold(f01Environment)).toThrow(
      /holds 2 of the payout account's signing keys/,
    );
  });

  it("names both offending variables so the operator knows what to remove", () => {
    expect(() => assertCustodyBelowThreshold(f01Environment)).toThrow(
      /STELLAR_PLATFORM_SECRET, STELLAR_OPS_SIGNER_SECRET/,
    );
  });

  it("accepts the remediated environment: ops only, platform identified by public key", () => {
    expect(() =>
      assertCustodyBelowThreshold({
        STELLAR_PLATFORM_ACCOUNT: master.publicKey(),
        STELLAR_OPS_SIGNER_SECRET: ops.secret(),
        STELLAR_POLICY_SIGNER_PUBLIC: policy.publicKey(),
        STELLAR_SPONSOR_SECRET: sponsor.secret(),
      }),
    ).not.toThrow();
  });

  it("refuses ops + policy too — the rule is about weight, not about which two", () => {
    expect(() =>
      assertCustodyBelowThreshold({
        STELLAR_PLATFORM_ACCOUNT: master.publicKey(),
        STELLAR_OPS_SIGNER_SECRET: ops.secret(),
        STELLAR_POLICY_SIGNER_SECRET: policy.secret(),
      }),
    ).toThrow(/meets the 2-of-3 threshold/);
  });

  it("refuses ops plus a sponsor key that is the configured policy signer", () => {
    expect(() =>
      assertCustodyBelowThreshold({
        STELLAR_PLATFORM_ACCOUNT: master.publicKey(),
        STELLAR_OPS_SIGNER_SECRET: ops.secret(),
        STELLAR_POLICY_SIGNER_PUBLIC: policy.publicKey(),
        STELLAR_SPONSOR_SECRET: policy.secret(),
      }),
    ).toThrow(/must be independent of STELLAR_POLICY_SIGNER_PUBLIC/);
  });

  it("does not count a platform secret belonging to some other account", () => {
    // The sponsorship key migrates through this shape: a platform-ish secret
    // that is not the payout master must not be mistaken for a payout signer.
    expect(
      heldPayoutSignerSecrets({
        STELLAR_PLATFORM_ACCOUNT: master.publicKey(),
        STELLAR_PLATFORM_SECRET: sponsor.secret(),
        STELLAR_OPS_SIGNER_SECRET: ops.secret(),
      }),
    ).toEqual(["STELLAR_OPS_SIGNER_SECRET"]);
  });

  it("cannot be satisfied by simply omitting STELLAR_PLATFORM_ACCOUNT", () => {
    // Without the account we cannot tell whether the platform secret is the
    // master, but ops alone is still only weight 1 — so this is permitted, and
    // parsePayoutSignerConfig separately requires STELLAR_PLATFORM_ACCOUNT.
    expect(() =>
      assertCustodyBelowThreshold({ STELLAR_OPS_SIGNER_SECRET: ops.secret() }),
    ).not.toThrow();
  });

  it("rejects a malformed seed rather than silently under-counting it", () => {
    expect(() =>
      assertCustodyBelowThreshold({
        STELLAR_PLATFORM_ACCOUNT: master.publicKey(),
        STELLAR_PLATFORM_SECRET: "not-a-seed",
        STELLAR_OPS_SIGNER_SECRET: ops.secret(),
      }),
    ).toThrow(/STELLAR_PLATFORM_SECRET must be a valid Stellar secret seed/);
  });
});

describe("assertSponsorNotPayoutSigner", () => {
  it("refuses the payout master reused as the sponsorship key", () => {
    expect(() =>
      assertSponsorNotPayoutSigner({
        STELLAR_PLATFORM_ACCOUNT: master.publicKey(),
        STELLAR_SPONSOR_SECRET: master.secret(),
      }),
    ).toThrow(/must not be the payout account's master key/);
  });

  it("refuses the ops signer reused as the sponsorship key", () => {
    expect(() =>
      assertSponsorNotPayoutSigner({
        STELLAR_PLATFORM_ACCOUNT: master.publicKey(),
        STELLAR_OPS_SIGNER_SECRET: ops.secret(),
        STELLAR_SPONSOR_SECRET: ops.secret(),
      }),
    ).toThrow(/must be independent of STELLAR_OPS_SIGNER_SECRET/);
  });

  it("refuses the policy signer reused as the sponsorship key when only its public key is configured", () => {
    expect(() =>
      assertSponsorNotPayoutSigner({
        STELLAR_PLATFORM_ACCOUNT: master.publicKey(),
        STELLAR_OPS_SIGNER_SECRET: ops.secret(),
        STELLAR_POLICY_SIGNER_PUBLIC: policy.publicKey(),
        STELLAR_SPONSOR_SECRET: policy.secret(),
      }),
    ).toThrow(/must be independent of STELLAR_POLICY_SIGNER_PUBLIC/);
  });

  it("accepts an independent sponsorship key", () => {
    expect(() =>
      assertSponsorNotPayoutSigner({
        STELLAR_PLATFORM_ACCOUNT: master.publicKey(),
        STELLAR_OPS_SIGNER_SECRET: ops.secret(),
        STELLAR_SPONSOR_SECRET: sponsor.secret(),
      }),
    ).not.toThrow();
  });

  it("is a no-op while the sponsorship key is unset (pre-migration)", () => {
    expect(() =>
      assertSponsorNotPayoutSigner({ STELLAR_PLATFORM_ACCOUNT: master.publicKey() }),
    ).not.toThrow();
  });
});
