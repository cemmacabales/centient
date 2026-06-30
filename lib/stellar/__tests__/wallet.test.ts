import { describe, it, expect } from "vitest";
import { Keypair, hash } from "@stellar/stellar-sdk";
import {
  freighterSignatureToBase64,
  albedoSignatureToBase64,
} from "@/lib/stellar/wallet";
import { verify } from "@/lib/stellar/signature";

const kp = Keypair.fromSecret(
  "SDBTJCPJ27TY3BNTANZ3G52FBGCQE76QRP7E2WZQRZLG7GJJBULSQ75E",
);
const MESSAGE = "Link withdrawal address — nonce 12345";

function sep53Sign(message: string): Buffer {
  const prefix = Buffer.from("Stellar Signed Message:\n", "utf8");
  return kp.sign(hash(Buffer.concat([prefix, Buffer.from(message, "utf8")])));
}

describe("freighterSignatureToBase64", () => {
  it("passes through a V4 base64 string unchanged (canonicalized)", () => {
    const sig = sep53Sign(MESSAGE);
    const b64 = sig.toString("base64");
    expect(freighterSignatureToBase64(b64)).toBe(b64);
  });

  it("encodes a V3 Buffer/Uint8Array to base64", () => {
    const sig = sep53Sign(MESSAGE);
    expect(freighterSignatureToBase64(sig)).toBe(sig.toString("base64"));
    expect(freighterSignatureToBase64(new Uint8Array(sig))).toBe(
      sig.toString("base64"),
    );
  });

  it("throws on a null signedMessage (signing was rejected)", () => {
    expect(() => freighterSignatureToBase64(null)).toThrow();
  });
});

describe("albedoSignatureToBase64", () => {
  it("converts a hex ed25519 signature to base64", () => {
    const sig = sep53Sign(MESSAGE);
    expect(albedoSignatureToBase64(sig.toString("hex"))).toBe(
      sig.toString("base64"),
    );
  });
});

describe("interop with server verify (SEP-53)", () => {
  it("a Freighter V4 base64 signature verifies after normalization", () => {
    const normalized = freighterSignatureToBase64(
      sep53Sign(MESSAGE).toString("base64"),
    );
    expect(verify(kp.publicKey(), MESSAGE, normalized)).toBe(true);
  });

  it("a Freighter V3 Buffer signature verifies after normalization", () => {
    const normalized = freighterSignatureToBase64(sep53Sign(MESSAGE));
    expect(verify(kp.publicKey(), MESSAGE, normalized)).toBe(true);
  });
});
