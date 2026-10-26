import { describe, it, expect } from "vitest";
import { Keypair, hash } from "@stellar/stellar-sdk";
import {
  verify,
  isValidStellarAddress,
  lanternMessageBytes,
  parseSignatureScheme,
  sep53Digest,
} from "@/lib/stellar/signature";

// A deterministic, throwaway keypair so the "known signature verifies" case is
// reproducible. Never funded.
const SEED = "SDBTJCPJ27TY3BNTANZ3G52FBGCQE76QRP7E2WZQRZLG7GJJBULSQ75E";
const kp = Keypair.fromSecret(SEED);
const PUBLIC_KEY = kp.publicKey(); // G… (uppercase base32)

const MESSAGE = "Link withdrawal address — nonce 12345";

// SEP-53: signature = ed25519_sign( SHA256("Stellar Signed Message:\n" + msg) ).
// We sign exactly what Freighter signs so the test exercises the real interop
// path, not a private detail of verify().
function sep53Sign(message: string): Buffer {
  const prefix = Buffer.from("Stellar Signed Message:\n", "utf8");
  const digest = hash(Buffer.concat([prefix, Buffer.from(message, "utf8")]));
  return kp.sign(digest);
}

describe("isValidStellarAddress", () => {
  it("accepts a valid ed25519 public key (G…)", () => {
    expect(isValidStellarAddress(PUBLIC_KEY)).toBe(true);
  });

  it("rejects a non-StrKey string", () => {
    expect(isValidStellarAddress("not-an-address")).toBe(false);
    expect(isValidStellarAddress("")).toBe(false);
    // An EVM 0x address must not be mistaken for a Stellar address.
    expect(
      isValidStellarAddress("0x52908400098527886E0F7030069857D2E4169EE7"),
    ).toBe(false);
  });

  it("rejects a lowercased StrKey — addresses are case-sensitive base32", () => {
    // Proves we never normalize: lowercasing a valid G… key must NOT pass.
    expect(isValidStellarAddress(PUBLIC_KEY.toLowerCase())).toBe(false);
  });
});

describe("sep53Digest", () => {
  it("is the SHA-256 of the SEP-53-prefixed message", () => {
    const expected = hash(
      Buffer.concat([
        Buffer.from("Stellar Signed Message:\n", "utf8"),
        Buffer.from(MESSAGE, "utf8"),
      ]),
    );
    expect(Buffer.compare(sep53Digest(MESSAGE), expected)).toBe(0);
  });
});

describe("verify", () => {
  it("returns true for a valid SEP-53 signature from a known keypair", () => {
    const sig = sep53Sign(MESSAGE);
    expect(verify(PUBLIC_KEY, MESSAGE, sig.toString("base64"))).toBe(true);
  });

  it("accepts the signature as raw bytes as well as base64", () => {
    const sig = sep53Sign(MESSAGE);
    expect(verify(PUBLIC_KEY, MESSAGE, sig)).toBe(true);
  });

  it("returns false when the message is tampered", () => {
    const sig = sep53Sign(MESSAGE);
    expect(verify(PUBLIC_KEY, MESSAGE + " ", sig.toString("base64"))).toBe(
      false,
    );
  });

  it("returns false when the signature is tampered", () => {
    const sig = sep53Sign(MESSAGE);
    sig[0] ^= 0xff; // flip a byte
    expect(verify(PUBLIC_KEY, MESSAGE, sig.toString("base64"))).toBe(false);
  });

  it("returns false when signed by a different key", () => {
    const other = Keypair.random();
    const prefix = Buffer.from("Stellar Signed Message:\n", "utf8");
    const digest = hash(Buffer.concat([prefix, Buffer.from(MESSAGE, "utf8")]));
    const sig = other.sign(digest);
    expect(verify(PUBLIC_KEY, MESSAGE, sig.toString("base64"))).toBe(false);
  });

  it("returns false (never throws) for a non-StrKey public key", () => {
    const sig = sep53Sign(MESSAGE);
    expect(verify("not-an-address", MESSAGE, sig.toString("base64"))).toBe(
      false,
    );
  });

  it("returns false (never throws) for a lowercased public key", () => {
    const sig = sep53Sign(MESSAGE);
    expect(
      verify(PUBLIC_KEY.toLowerCase(), MESSAGE, sig.toString("base64")),
    ).toBe(false);
  });

  it("returns false (never throws) for a garbage signature", () => {
    expect(verify(PUBLIC_KEY, MESSAGE, "!!!not-base64!!!")).toBe(false);
    expect(verify(PUBLIC_KEY, MESSAGE, "")).toBe(false);
  });
});

// Lantern signs `"Lantern signed message:\n" + message`, raw — no digest.
describe("verify — lantern scheme", () => {
  const lanternSign = (message: string) =>
    kp.sign(Buffer.concat([Buffer.from("Lantern signed message:\n", "utf8"), Buffer.from(message, "utf8")]));

  it("accepts Lantern's signature over its prefixed message", () => {
    expect(verify(PUBLIC_KEY, MESSAGE, lanternSign(MESSAGE), "lantern")).toBe(true);
    expect(lanternMessageBytes(MESSAGE).toString("utf8")).toBe(`Lantern signed message:\n${MESSAGE}`);
  });

  it("keeps the schemes apart: neither signature passes as the other", () => {
    expect(verify(PUBLIC_KEY, MESSAGE, lanternSign(MESSAGE))).toBe(false);
    expect(verify(PUBLIC_KEY, MESSAGE, sep53Sign(MESSAGE), "lantern")).toBe(false);
  });

  it("refuses a Lantern signature over a different message", () => {
    expect(verify(PUBLIC_KEY, `${MESSAGE}!`, lanternSign(MESSAGE), "lantern")).toBe(false);
  });
});

describe("parseSignatureScheme", () => {
  it("defaults an absent scheme to SEP-53", () => {
    expect(parseSignatureScheme(undefined)).toBe("sep53");
  });

  it("accepts the known schemes and nothing else", () => {
    expect(parseSignatureScheme("sep53")).toBe("sep53");
    expect(parseSignatureScheme("lantern")).toBe("lantern");
    expect(parseSignatureScheme("raw")).toBeNull();
    expect(parseSignatureScheme(null)).toBeNull();
  });
});
