import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { CoSignerCapError, CoSignerUnavailableError } from "../cosigner-errors";
import { remotePolicyCoSigner } from "../cosigner-remote";
import {
  COSIGNER_SIGNATURE_HEADER,
  verifyCoSignRequest,
  type NonceStore,
} from "../cosigner-transport";
import type { PayoutCoSignRequest } from "../payout-envelope";

const policy = Keypair.random();
const secret = "a".repeat(32);
const url = "https://cosigner.example/cosign";

const request: PayoutCoSignRequest = {
  stage: "payment",
  xdr: "AAAA-envelope",
  destination: Keypair.random().publicKey(),
  amountUnits: 25_000_000n,
  reference: { kind: "submission", id: "sub-1" },
};

function nonces(): NonceStore {
  const seen = new Set<string>();
  return {
    take(nonce) {
      if (seen.has(nonce)) return false;
      seen.add(nonce);
      return true;
    },
  };
}

/** Capture what the client actually put on the wire. */
function recordingFetch(response: { status: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("remotePolicyCoSigner", () => {
  it("returns the detached signature the service produced", async () => {
    const { fetchImpl } = recordingFetch({
      status: 200,
      body: { publicKey: policy.publicKey(), signature: "c2ln" },
    });

    const result = await remotePolicyCoSigner({ url, secret, fetchImpl }).signPayout(request);

    expect(result).toEqual({ publicKey: policy.publicKey(), signature: "c2ln" });
  });

  it("sends a body the co-signer can verify with the shared secret", async () => {
    const { calls, fetchImpl } = recordingFetch({
      status: 200,
      body: { publicKey: policy.publicKey(), signature: "c2ln" },
    });

    await remotePolicyCoSigner({ url, secret, fetchImpl }).signPayout(request);

    const [call] = calls;
    const headers = call.init.headers as Record<string, string>;
    expect(headers[COSIGNER_SIGNATURE_HEADER]).toBeTruthy();
    expect(() =>
      verifyCoSignRequest(call.init.body as string, headers, secret, { nonces: nonces() }),
    ).not.toThrow();
  });

  it("serialises the amount as an exact integer string, never a JSON number", async () => {
    // amountUnits is a bigint because 7-decimal USDC amounts overflow the exact
    // range of a JSON number. Letting it round-trip as a number would reintroduce
    // the precision loss the whole payout path is built to avoid.
    const { calls, fetchImpl } = recordingFetch({
      status: 200,
      body: { publicKey: policy.publicKey(), signature: "c2ln" },
    });

    await remotePolicyCoSigner({ url, secret, fetchImpl }).signPayout({
      ...request,
      amountUnits: 90_071_992_547_409_931n,
    });

    expect(JSON.parse(calls[0].init.body as string).amountUnits).toBe("90071992547409931");
  });

  it("surfaces the service's refusal rather than treating it as a failure to reach", async () => {
    const { fetchImpl } = recordingFetch({
      status: 409,
      body: { error: "submission sub-1 owes a ledger amount of 1 units" },
    });

    await expect(
      remotePolicyCoSigner({ url, secret, fetchImpl }).signPayout(request),
    ).rejects.toThrow(/ledger amount/);
  });

  describe("answers that mean \"not now\" (#47)", () => {
    const failing = (err: unknown) => (async () => Promise.reject(err)) as unknown as typeof fetch;

    it("reports a request that never reached the co-signer as unavailable, without its URL", async () => {
      const err = await remotePolicyCoSigner({
        url,
        secret,
        fetchImpl: failing(Object.assign(new TypeError("fetch failed"), { cause: new Error(`connect ECONNREFUSED ${url}`) })),
      })
        .signPayout(request)
        .catch((e) => e);

      expect(err).toBeInstanceOf(CoSignerUnavailableError);
      expect(err.code).toBe("cosigner_unavailable");
      expect(err.message).toBe("payout co-signer unreachable: request failed (TypeError)");
      expect(err.message).not.toContain("cosigner.example");
    });

    it("reports a timeout as unavailable", async () => {
      const err = await remotePolicyCoSigner({
        url,
        secret,
        timeoutMs: 1234,
        fetchImpl: failing(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
      })
        .signPayout(request)
        .catch((e) => e);

      expect(err).toBeInstanceOf(CoSignerUnavailableError);
      expect(err.message).toBe("payout co-signer unreachable: timed out after 1234ms");
    });

    it("reports a body that stalls after the headers as unavailable, not as a bad signature", async () => {
      // The headers arrived, so fetch resolved; the timeout then fires while the
      // body is still being read.
      const stalled = new ReadableStream({
        start(controller) {
          controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        },
      });
      const fetchImpl = (async () => new Response(stalled, { status: 200 })) as unknown as typeof fetch;

      const err = await remotePolicyCoSigner({ url, secret, timeoutMs: 1234, fetchImpl })
        .signPayout(request)
        .catch((e) => e);

      expect(err).toBeInstanceOf(CoSignerUnavailableError);
      expect(err.message).toBe("payout co-signer unreachable: timed out after 1234ms");
    });

    it("keeps a complete body that is not JSON a plain failure", async () => {
      const fetchImpl = (async () => new Response("<html>ok</html>", { status: 200 })) as unknown as typeof fetch;

      const err = await remotePolicyCoSigner({ url, secret, fetchImpl }).signPayout(request).catch((e) => e);

      expect(err).not.toBeInstanceOf(CoSignerUnavailableError);
      expect(err.message).toMatch(/signature/i);
    });

    it("reports a 5xx as unavailable", async () => {
      const { fetchImpl } = recordingFetch({ status: 502, body: { error: "Bad Gateway" } });

      const err = await remotePolicyCoSigner({ url, secret, fetchImpl }).signPayout(request).catch((e) => e);

      expect(err).toBeInstanceOf(CoSignerUnavailableError);
      expect(err.message).toContain("Bad Gateway");
    });

    it("reports a refusal carrying the cap code as a cap refusal", async () => {
      const { fetchImpl } = recordingFetch({
        status: 409,
        body: { error: "payout co-signer: daily cap reached — …", code: "daily_cap_reached" },
      });

      const err = await remotePolicyCoSigner({ url, secret, fetchImpl }).signPayout(request).catch((e) => e);

      expect(err).toBeInstanceOf(CoSignerCapError);
      expect(err.message).toContain("daily cap reached");
    });

    it("keeps every other refusal a plain refusal, including a cap message with no code", async () => {
      for (const body of [
        { error: "submission sub-1 has an unsettled envelope" },
        { error: "payout co-signer: daily cap reached — from a co-signer older than #47" },
      ]) {
        const { fetchImpl } = recordingFetch({ status: 409, body });

        const err = await remotePolicyCoSigner({ url, secret, fetchImpl }).signPayout(request).catch((e) => e);

        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(CoSignerUnavailableError);
        expect(err).not.toBeInstanceOf(CoSignerCapError);
        expect(err.message).toMatch(/^payout co-signer refused: /);
      }
    });
  });

  it("refuses a response that is not a detached signature", async () => {
    const { fetchImpl } = recordingFetch({ status: 200, body: { xdr: "a whole transaction" } });

    await expect(
      remotePolicyCoSigner({ url, secret, fetchImpl }).signPayout(request),
    ).rejects.toThrow(/signature/i);
  });
});
