import { describe, it, expect } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  TransactionBuilder,
  hash,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  CHALLENGE_TTL_MS,
  ChallengeStore,
  MAX_OUTSTANDING_CHALLENGES,
  ONBOARDING_OPS,
  buildChallengeMessage,
  buildSponsoredOnboardingTx,
  harnessEnabled,
  inspectCoSignedEnvelope,
  signatureChecks,
  type OnboardingKind,
} from "@/lib/stellar/freighter-proof";

// Sign exactly what Freighter's SEP-53 `signMessage` signs.
function sep53Sign(keypair: Keypair, message: string): string {
  const prefix = Buffer.from("Stellar Signed Message:\n", "utf8");
  return keypair
    .sign(hash(Buffer.concat([prefix, Buffer.from(message, "utf8")])))
    .toString("base64");
}

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

describe("harnessEnabled", () => {
  it("is off unless WALLET_PROOF_HARNESS=1", () => {
    expect(harnessEnabled(env({}))).toBe(false);
    expect(harnessEnabled(env({ WALLET_PROOF_HARNESS: "true" }))).toBe(false);
  });

  it("is on for testnet, including the default network", () => {
    expect(harnessEnabled(env({ WALLET_PROOF_HARNESS: "1" }))).toBe(true);
    expect(harnessEnabled(env({ WALLET_PROOF_HARNESS: "1", STELLAR_NETWORK: "testnet" }))).toBe(true);
  });

  it("stays off on the public network even when switched on", () => {
    expect(harnessEnabled(env({ WALLET_PROOF_HARNESS: "1", STELLAR_NETWORK: "public" }))).toBe(false);
  });
});

describe("buildChallengeMessage", () => {
  it("binds address, network, action, nonce and both timestamps", () => {
    const address = Keypair.random().publicKey();
    const message = buildChallengeMessage({
      address,
      networkPassphrase: Networks.TESTNET,
      nonce: "ab12",
      issuedAt: new Date("2026-09-14T00:00:00Z"),
      expiresAt: new Date("2026-09-14T00:05:00Z"),
    });
    expect(message).toContain(`Address: ${address}`);
    expect(message).toContain(`Network: ${Networks.TESTNET}`);
    expect(message).toContain("Action: prove-stellar-address");
    expect(message).toContain("Nonce: ab12");
    expect(message).toContain("Expires At: 2026-09-14T00:05:00.000Z");
  });
});

describe("ChallengeStore.verify", () => {
  const t0 = new Date("2026-09-14T00:00:00Z");

  function issued() {
    const keypair = Keypair.random();
    const store = new ChallengeStore();
    const challenge = store.issue(keypair.publicKey(), t0, Networks.TESTNET);
    return { keypair, store, challenge, signature: sep53Sign(keypair, challenge.message) };
  }

  it("accepts a valid Freighter-shaped proof", () => {
    const { keypair, store, challenge, signature } = issued();
    const result = store.verify({
      address: keypair.publicKey(),
      nonce: challenge.nonce,
      signature,
      signerAddress: keypair.publicKey(),
      now: t0,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a replay of an accepted proof", () => {
    const { keypair, store, challenge, signature } = issued();
    const proof = { address: keypair.publicKey(), nonce: challenge.nonce, signature, now: t0 };
    expect(store.verify(proof).ok).toBe(true);
    expect(store.verify(proof)).toEqual({ ok: false, reason: "replayed" });
  });

  it("rejects an expired challenge", () => {
    const { keypair, store, challenge, signature } = issued();
    const late = new Date(t0.getTime() + CHALLENGE_TTL_MS + 1);
    expect(
      store.verify({ address: keypair.publicKey(), nonce: challenge.nonce, signature, now: late }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a nonce presented for a different address", () => {
    const { store, challenge } = issued();
    const other = Keypair.random();
    expect(
      store.verify({
        address: other.publicKey(),
        nonce: challenge.nonce,
        signature: sep53Sign(other, challenge.message),
        now: t0,
      }),
    ).toEqual({ ok: false, reason: "wrong_address" });
  });

  it("rejects when the wallet reports a different signer", () => {
    const { keypair, store, challenge, signature } = issued();
    expect(
      store.verify({
        address: keypair.publicKey(),
        nonce: challenge.nonce,
        signature,
        signerAddress: Keypair.random().publicKey(),
        now: t0,
      }),
    ).toEqual({ ok: false, reason: "wrong_signer" });
  });

  it("rejects a signature made by another key", () => {
    const { keypair, store, challenge } = issued();
    expect(
      store.verify({
        address: keypair.publicKey(),
        nonce: challenge.nonce,
        signature: sep53Sign(Keypair.random(), challenge.message),
        now: t0,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("consumes the nonce on a failed attempt, so a corrected retry is a replay", () => {
    const { keypair, store, challenge, signature } = issued();
    const address = keypair.publicKey();
    const forged = sep53Sign(Keypair.random(), challenge.message);
    expect(store.verify({ address, nonce: challenge.nonce, signature: forged, now: t0 }).ok).toBe(false);
    expect(store.verify({ address, nonce: challenge.nonce, signature, now: t0 })).toEqual({
      ok: false,
      reason: "replayed",
    });
  });

  it("rejects an unknown nonce and a normalized (lowercased) address", () => {
    const { keypair, store, challenge, signature } = issued();
    expect(
      store.verify({ address: keypair.publicKey(), nonce: "feed", signature, now: t0 }),
    ).toEqual({ ok: false, reason: "unknown_nonce" });
    expect(
      store.verify({
        address: keypair.publicKey().toLowerCase(),
        nonce: challenge.nonce,
        signature,
        now: t0,
      }),
    ).toEqual({ ok: false, reason: "invalid_address" });
  });

  it("caps outstanding challenges by evicting the oldest", () => {
    const store = new ChallengeStore();
    const address = Keypair.random().publicKey();
    const first = store.issue(address, t0, Networks.TESTNET);
    for (let i = 1; i < MAX_OUTSTANDING_CHALLENGES + 5; i++) {
      store.issue(address, t0, Networks.TESTNET);
    }
    expect(store.size.issued).toBe(MAX_OUTSTANDING_CHALLENGES);
    expect(store.verify({ address, nonce: first.nonce, signature: "", now: t0 })).toEqual({
      ok: false,
      reason: "unknown_nonce",
    });
  });

  it("forgets expired challenges and consumed nonces, and still rejects the replay", () => {
    const { keypair, store, challenge, signature } = issued();
    const proof = { address: keypair.publicKey(), nonce: challenge.nonce, signature, now: t0 };
    expect(store.verify(proof).ok).toBe(true);

    const late = new Date(t0.getTime() + CHALLENGE_TTL_MS + 1);
    store.issue(keypair.publicKey(), late, Networks.TESTNET);
    expect(store.size).toEqual({ issued: 1, consumed: 0 });
    expect(store.verify({ ...proof, now: late })).toEqual({ ok: false, reason: "unknown_nonce" });
  });
});

describe("signatureChecks", () => {
  it("passes every negative rule for a genuine SEP-53 signature", () => {
    const keypair = Keypair.random();
    const challenge = new ChallengeStore().issue(keypair.publicKey(), new Date(), Networks.TESTNET);
    const checks = signatureChecks(challenge, sep53Sign(keypair, challenge.message));
    expect(checks.length).toBeGreaterThanOrEqual(7);
    expect(checks.filter((c) => !c.passed)).toEqual([]);
  });

  it("fails the control check when the signature belongs to someone else", () => {
    const keypair = Keypair.random();
    const challenge = new ChallengeStore().issue(keypair.publicKey(), new Date(), Networks.TESTNET);
    const [control] = signatureChecks(challenge, sep53Sign(Keypair.random(), challenge.message));
    expect(control.passed).toBe(false);
  });
});

describe("sponsored onboarding envelope", () => {
  const sponsor = Keypair.random();
  const recipient = Keypair.random();
  const asset = new Asset("USDC", Keypair.random().publicKey());

  function sponsored(kind: OnboardingKind = "account+trustline", sequence = "100") {
    const tx = buildSponsoredOnboardingTx({
      sponsorAccount: new Account(sponsor.publicKey(), sequence),
      recipient: recipient.publicKey(),
      asset,
      kind,
      passphrase: Networks.TESTNET,
    });
    tx.sign(sponsor);
    const pending = {
      recipient: recipient.publicKey(),
      kind,
      hash: tx.hash().toString("hex"),
      sponsor: sponsor.publicKey(),
    };
    return { xdr: tx.toXDR(), pending };
  }

  const reparse = (xdr: string, passphrase = Networks.TESTNET) =>
    TransactionBuilder.fromXDR(xdr, passphrase) as Transaction;

  const failed = (result: ReturnType<typeof inspectCoSignedEnvelope>) =>
    result.checks.filter((c) => !c.passed).map((c) => c.name);

  it.each<OnboardingKind>(["trustline", "account+trustline"])(
    "builds the %s sandwich with the recipient sourcing its own operations",
    (kind) => {
      const tx = reparse(sponsored(kind).xdr);
      expect(tx.operations.map((op) => op.type)).toEqual(ONBOARDING_OPS[kind]);
      expect(tx.source).toBe(sponsor.publicKey());
      const changeTrust = tx.operations.find((op) => op.type === "changeTrust");
      expect(changeTrust?.source).toBe(recipient.publicKey());
    },
  );

  it("accepts an envelope the recipient co-signed on this network", () => {
    const { xdr, pending } = sponsored();
    const tx = reparse(xdr);
    tx.sign(recipient);
    const result = inspectCoSignedEnvelope({ signedXdr: tx.toXDR(), pending, passphrase: Networks.TESTNET });
    expect(failed(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects a recipient signature made for the public network", () => {
    const { xdr, pending } = sponsored();
    const onPublic = reparse(xdr, Networks.PUBLIC);
    onPublic.sign(recipient);
    const result = inspectCoSignedEnvelope({
      signedXdr: onPublic.toXDR(),
      pending,
      passphrase: Networks.TESTNET,
    });
    expect(result.ok).toBe(false);
    expect(failed(result)).toContain("Recipient (Freighter) signature valid for this network");
  });

  it("rejects an envelope the recipient never signed", () => {
    const { xdr, pending } = sponsored();
    const result = inspectCoSignedEnvelope({ signedXdr: xdr, pending, passphrase: Networks.TESTNET });
    expect(result.ok).toBe(false);
    expect(failed(result)).toContain("Recipient (Freighter) signature valid for this network");
  });

  it("rejects a different transaction than the one the sponsor issued", () => {
    const { pending } = sponsored();
    const swapped = reparse(sponsored("account+trustline", "200").xdr);
    swapped.sign(recipient);
    const result = inspectCoSignedEnvelope({
      signedXdr: swapped.toXDR(),
      pending,
      passphrase: Networks.TESTNET,
    });
    expect(failed(result)).toContain("Transaction bytes unchanged since the sponsor signed (hash matches)");
  });

  it("rejects an envelope carrying an extra signature", () => {
    const { xdr, pending } = sponsored();
    const tx = reparse(xdr);
    tx.sign(recipient);
    tx.sign(Keypair.random());
    const result = inspectCoSignedEnvelope({ signedXdr: tx.toXDR(), pending, passphrase: Networks.TESTNET });
    expect(failed(result)).toEqual(["No signatures beyond sponsor and recipient"]);
  });

  it("rejects a fee-bump envelope and unparseable input", () => {
    const { xdr, pending } = sponsored();
    const inner = reparse(xdr);
    inner.sign(recipient);
    const bump = TransactionBuilder.buildFeeBumpTransaction(sponsor, "400", inner, Networks.TESTNET);
    bump.sign(sponsor);
    expect(
      inspectCoSignedEnvelope({ signedXdr: bump.toXDR(), pending, passphrase: Networks.TESTNET }).ok,
    ).toBe(false);
    expect(
      inspectCoSignedEnvelope({ signedXdr: "not-xdr", pending, passphrase: Networks.TESTNET }).ok,
    ).toBe(false);
  });
});
