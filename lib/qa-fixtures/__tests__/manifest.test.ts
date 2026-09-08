import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { loadRecipientManifest, parseRecipientManifest } from "../manifest";

// A malformed manifest surfaces much later as a payout failure that looks like a
// rail defect rather than a fixture defect. That confusion is exactly what QA
// cannot afford mid-evidence-run, so the parser is strict and loud.

function validManifest() {
  return {
    network: "testnet",
    usdcIssuer: Keypair.random().publicKey(),
    generatedAt: new Date().toISOString(),
    recipients: {
      withTrustline: { address: Keypair.random().publicKey(), note: "funded + trustline" },
      withoutTrustline: { address: Keypair.random().publicKey() },
      neverCreated: { address: Keypair.random().publicKey() },
    },
  };
}

describe("parseRecipientManifest", () => {
  it("accepts a well-formed manifest", () => {
    const raw = validManifest();
    const parsed = parseRecipientManifest(raw);
    expect(parsed.network).toBe("testnet");
    expect(parsed.recipients.withTrustline.address).toBe(raw.recipients.withTrustline.address);
    expect(parsed.recipients.withTrustline.note).toBe("funded + trustline");
  });

  it("rejects a non-object", () => {
    expect(() => parseRecipientManifest(null)).toThrow(/not an object/);
    expect(() => parseRecipientManifest("{}")).toThrow(/not an object/);
  });

  it("requires a declared network", () => {
    const raw = { ...validManifest(), network: "" };
    expect(() => parseRecipientManifest(raw)).toThrow(/declares no network/);
  });

  it("requires a valid issuer key", () => {
    const raw = { ...validManifest(), usdcIssuer: "not-a-key" };
    expect(() => parseRecipientManifest(raw)).toThrow(/usdcIssuer is not a valid/);
  });

  it("requires every shape to be present", () => {
    const raw = validManifest();
    delete (raw.recipients as Record<string, unknown>).neverCreated;
    expect(() => parseRecipientManifest(raw)).toThrow(/missing the "neverCreated" recipient/);
  });

  it("rejects an address that is not a Stellar public key", () => {
    const raw = validManifest();
    raw.recipients.withoutTrustline.address = "0xdeadbeef";
    expect(() => parseRecipientManifest(raw)).toThrow(
      /"withoutTrustline" address is not a valid Stellar public key/,
    );
  });

  it("rejects two shapes sharing one address", () => {
    // The property that makes the shapes mean anything. Two shapes on one address
    // would make a fixture prove the opposite of what it claims, silently: a
    // "without trustline" case paying an account that holds one.
    const raw = validManifest();
    raw.recipients.neverCreated.address = raw.recipients.withTrustline.address;
    expect(() => parseRecipientManifest(raw)).toThrow(/share the address/);
  });
});

describe("loadRecipientManifest", () => {
  it("points at the provisioning command when the file is missing", () => {
    expect(() => loadRecipientManifest("/nonexistent/recipients.json")).toThrow(
      /qa:recipients:provision/,
    );
  });

  it("loads the committed testnet manifest", () => {
    // The manifest that ships with the repository must always parse, or the seed
    // command is broken for everyone on a fresh checkout.
    const manifest = loadRecipientManifest();
    expect(manifest.network).toBe("testnet");
    expect(Object.keys(manifest.recipients).sort()).toEqual([
      "neverCreated",
      "withTrustline",
      "withoutTrustline",
    ]);
  });
});
