// The payout service's client for the deployed co-signer (issue #8).
//
// This is the seam `PayoutCoSigner` was cut for: the payout service builds and
// platform-signs an envelope, asks an independent service for the second
// signature, and merges only a detached signature it verifies against its own
// transaction hash. The co-signer never returns a transaction, so a compromised
// or buggy one cannot substitute a different payout — the worst it can do is
// refuse. `applyCoSignature` is where that guarantee is enforced.
import {
  COSIGNER_SIGNATURE_HEADER,
  signCoSignRequest,
} from "./cosigner-transport";
import type {
  PayoutCoSignRequest,
  PayoutCoSignature,
  PayoutCoSigner,
} from "./payout-envelope";

/** A payout must not hang on an unresponsive co-signer while holding a sequence number. */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface RemoteCoSignerOptions {
  url: string;
  secret: string;
  timeoutMs?: number;
  /** Injected in tests; production uses the runtime's own fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * The wire form of a signing request.
 *
 * `amountUnits` crosses as a decimal *string*. Stellar amounts are 7-decimal
 * integers that exceed the exactly-representable range of a JSON number, and the
 * payout path is bigint end to end precisely so no amount is ever rounded — this
 * is the one place that discipline could quietly be lost.
 */
function wireBody(request: PayoutCoSignRequest): string {
  return JSON.stringify({
    stage: request.stage,
    xdr: request.xdr,
    destination: request.destination,
    amountUnits: request.amountUnits.toString(),
    reference: request.reference,
  });
}

/** The service's own reason for refusing, if it sent one worth surfacing. */
function refusalReason(payload: unknown, status: number): string {
  const error =
    payload && typeof payload === "object" && "error" in payload
      ? (payload as { error?: unknown }).error
      : undefined;
  return typeof error === "string" && error.trim()
    ? error
    : `co-signer responded ${status}`;
}

/** The independent co-signer, reached over authenticated HTTP. */
export function remotePolicyCoSigner(options: RemoteCoSignerOptions): PayoutCoSigner {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async signPayout(request: PayoutCoSignRequest): Promise<PayoutCoSignature> {
      const body = wireBody(request);
      const headers = {
        "content-type": "application/json",
        ...signCoSignRequest(body, options.secret),
      };

      // Bounded explicitly: an unbounded wait would strand the payout holding the
      // payout account's sequence number, which blocks every other payout behind it.
      const abort = AbortSignal.timeout(timeoutMs);
      const response = await doFetch(options.url, {
        method: "POST",
        headers,
        body,
        signal: abort,
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(`payout co-signer refused: ${refusalReason(payload, response.status)}`);
      }

      const publicKey =
        payload && typeof payload === "object" ? (payload as Record<string, unknown>).publicKey : undefined;
      const signature =
        payload && typeof payload === "object" ? (payload as Record<string, unknown>).signature : undefined;
      if (typeof publicKey !== "string" || typeof signature !== "string") {
        throw new Error(
          "payout co-signer returned no detached signature — expected { publicKey, signature }",
        );
      }
      return { publicKey, signature };
    },
  };
}

export { COSIGNER_SIGNATURE_HEADER };
