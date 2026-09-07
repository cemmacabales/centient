import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  assertColdReserveMultisig,
  resolveColdReserveSetupKeys,
} from "../cold-reserve-setup";

function setupFixture() {
  const master = Keypair.random();
  const hot = Keypair.random();
  const ops = Keypair.random();
  const policy = Keypair.random();
  const env: Record<string, string | undefined> = {
    STELLAR_COLD_RESERVE_SECRET: master.secret(),
    STELLAR_COLD_RESERVE_ACCOUNT: master.publicKey(),
    STELLAR_COLD_OPS_SIGNER_PUBLIC: ops.publicKey(),
    STELLAR_COLD_POLICY_SIGNER_PUBLIC: policy.publicKey(),
    STELLAR_PLATFORM_ACCOUNT: hot.publicKey(),
  };
  return {
    master,
    hot,
    ops,
    policy,
    env,
  };
}

describe("cold reserve setup key resolution", () => {
  it("accepts pre-provisioned, pairwise-distinct identities without logging seeds", () => {
    const fixture = setupFixture();
    const log = vi.fn();

    const result = resolveColdReserveSetupKeys({
      env: fixture.env,
      network: "public",
      log,
    });

    expect(result.master.publicKey()).toBe(fixture.master.publicKey());
    expect(result.opsPublic).toBe(fixture.ops.publicKey());
    expect(result.policyPublic).toBe(fixture.policy.publicKey());
    expect(log).not.toHaveBeenCalled();
  });

  it("fails closed when production cosigners are missing even if generation is enabled", () => {
    const fixture = setupFixture();
    delete fixture.env.STELLAR_COLD_OPS_SIGNER_PUBLIC;

    expect(() =>
      resolveColdReserveSetupKeys({
        env: {
          ...fixture.env,
          STELLAR_ALLOW_TESTNET_KEY_GENERATION: "true",
        },
        network: "public",
        log: vi.fn(),
      }),
    ).toThrow(/testnet/i);
  });

  it("requires explicit opt-in before generating disposable testnet keys", () => {
    const fixture = setupFixture();
    delete fixture.env.STELLAR_COLD_OPS_SIGNER_PUBLIC;

    expect(() =>
      resolveColdReserveSetupKeys({
        env: fixture.env,
        network: "testnet",
        log: vi.fn(),
      }),
    ).toThrow(/STELLAR_COLD_OPS_SIGNER_PUBLIC/);
  });

  it("permits key generation only with explicit disposable-testnet opt-in", () => {
    const fixture = setupFixture();
    delete fixture.env.STELLAR_COLD_OPS_SIGNER_PUBLIC;
    delete fixture.env.STELLAR_COLD_POLICY_SIGNER_PUBLIC;
    const log = vi.fn();

    const result = resolveColdReserveSetupKeys({
      env: {
        ...fixture.env,
        STELLAR_ALLOW_TESTNET_KEY_GENERATION: "true",
      },
      network: "testnet",
      log,
    });

    expect(result.opsPublic).not.toBe(result.policyPublic);
    expect(log).toHaveBeenCalled();
  });

  it("rejects a cold master that is also the configured hot account", () => {
    const fixture = setupFixture();

    expect(() =>
      resolveColdReserveSetupKeys({
        env: {
          ...fixture.env,
          STELLAR_PLATFORM_ACCOUNT: fixture.master.publicKey(),
        },
        network: "testnet",
        log: vi.fn(),
      }),
    ).toThrow(/cold.*hot.*distinct/i);
  });

  it("rejects a configured cold public key that disagrees with its seed", () => {
    const fixture = setupFixture();

    expect(() =>
      resolveColdReserveSetupKeys({
        env: {
          ...fixture.env,
          STELLAR_COLD_RESERVE_ACCOUNT: Keypair.random().publicKey(),
        },
        network: "testnet",
        log: vi.fn(),
      }),
    ).toThrow(/must match/i);
  });

  it("refuses to verify an otherwise exact account with a hash-signer bypass", () => {
    const fixture = setupFixture();

    expect(() =>
      assertColdReserveMultisig(
        {
          thresholds: {
            low_threshold: 2,
            med_threshold: 2,
            high_threshold: 2,
          },
          signers: [
            { key: fixture.master.publicKey(), weight: 1 },
            { key: fixture.ops.publicKey(), weight: 1 },
            { key: fixture.policy.publicKey(), weight: 1 },
            { key: `X${"0".repeat(55)}`, weight: 2, type: "sha256_hash" },
          ],
        },
        {
          masterPublic: fixture.master.publicKey(),
          opsPublic: fixture.ops.publicKey(),
          policyPublic: fixture.policy.publicKey(),
        },
      ),
    ).toThrow(/unexpected active signer/i);
  });
});
