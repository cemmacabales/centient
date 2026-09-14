import { describe, expect, it } from "vitest";
import {
  COSIGNER_SIGNATURE_HEADER,
  signCoSignRequest,
  verifyCoSignRequest,
  type NonceStore,
} from "../cosigner-transport";

const secret = "a".repeat(32);
const body = JSON.stringify({ stage: "payment", destination: "GABC", amountUnits: "25000000" });
const now = new Date("2026-09-08T12:00:00.000Z").getTime();

/** A fresh single-use nonce store, matching the service's own replay guard. */
function store(): NonceStore {
  const seen = new Set<string>();
  return {
    take(nonce) {
      if (seen.has(nonce)) return false;
      seen.add(nonce);
      return true;
    },
  };
}

function headers(overrides: Record<string, string> = {}, at = now) {
  return { ...signCoSignRequest(body, secret, { now: at, nonce: "nonce-1" }), ...overrides };
}

describe("verifyCoSignRequest", () => {
  it("accepts a request signed with the shared secret", () => {
    expect(() =>
      verifyCoSignRequest(body, headers(), secret, { now, nonces: store() }),
    ).not.toThrow();
  });

  it("refuses a body that changed after it was signed", () => {
    // The signature covers the raw body, so tampering with the amount or the
    // destination in transit invalidates it before the payload is ever parsed.
    const tampered = JSON.stringify({ stage: "payment", destination: "GEVIL", amountUnits: "1" });
    expect(() =>
      verifyCoSignRequest(tampered, headers(), secret, { now, nonces: store() }),
    ).toThrow(/signature/i);
  });

  it("refuses a signature produced with a different secret", () => {
    const forged = signCoSignRequest(body, "b".repeat(32), { now, nonce: "nonce-1" });
    expect(() =>
      verifyCoSignRequest(body, forged, secret, { now, nonces: store() }),
    ).toThrow(/signature/i);
  });

  it("refuses a request whose timestamp is outside the replay window", () => {
    const stale = now - 10 * 60_000;
    expect(() =>
      verifyCoSignRequest(body, headers({}, stale), secret, { now, nonces: store() }),
    ).toThrow(/timestamp/i);
  });

  it("refuses a request timestamped in the future beyond the window", () => {
    const ahead = now + 10 * 60_000;
    expect(() =>
      verifyCoSignRequest(body, headers({}, ahead), secret, { now, nonces: store() }),
    ).toThrow(/timestamp/i);
  });

  it("refuses the same signed request twice", () => {
    // Inside the freshness window a captured request is otherwise perfectly
    // valid, so the nonce is what stops it being replayed into a second payment.
    const nonces = store();
    const signed = headers();
    verifyCoSignRequest(body, signed, secret, { now, nonces });
    expect(() => verifyCoSignRequest(body, signed, secret, { now, nonces })).toThrow(/replay/i);
  });

  it("refuses a request carrying no signature header at all", () => {
    expect(() => verifyCoSignRequest(body, {}, secret, { now, nonces: store() })).toThrow(
      new RegExp(COSIGNER_SIGNATURE_HEADER, "i"),
    );
  });

  it("refuses a shared secret too short to be worth verifying", () => {
    expect(() => signCoSignRequest(body, "short", { now, nonce: "nonce-1" })).toThrow(
      /COSIGNER_SHARED_SECRET/,
    );
  });
});
