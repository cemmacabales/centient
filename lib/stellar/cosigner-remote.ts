// The payout service's client for the deployed co-signer (issue #8).
//
// This is the seam `PayoutCoSigner` was cut for: the payout service builds and
// platform-signs an envelope, asks an independent service for the second
// signature, and merges only a detached signature it verifies against its own
// transaction hash. The co-signer never returns a transaction, so a compromised
// or buggy one cannot substitute a different payout — the worst it can do is
// refuse. `applyCoSignature` is where that guarantee is enforced.
import {
  COSIGNER_CAP_REFUSAL_CODE,
  CoSignerCapError,
  CoSignerUnavailableError,
} from "./cosigner-errors";
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

/** The refusal's machine-readable `code`, when the service sent one. */
function refusalCode(payload: unknown): string | undefined {
  const code =
    payload && typeof payload === "object" && "code" in payload
      ? (payload as { code?: unknown }).code
      : undefined;
  return typeof code === "string" ? code : undefined;
}

/** The body as JSON, or null when a complete body is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Why a request never got an answer. The error's class and a fixed phrase only:
 * a fetch failure's message and cause can carry the co-signer's URL.
 */
function transportFailure(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return `timed out after ${timeoutMs}ms`;
  }
  return `request failed (${err instanceof Error ? err.name : typeof err})`;
}

/**
 * The independent co-signer, reached over authenticated HTTP.
 *
 * Its answers fall into three kinds (#47). A signature. A refusal on the merits,
 * thrown as a plain error, which ends the attempt. And "not now": the service
 * unreachable, timing out or answering 5xx (`CoSignerUnavailableError`), or its
 * own daily cap spent (`CoSignerCapError`). Payers defer on "not now" rather
 * than spending a retry. A signature is still the only thing that lets a payout
 * proceed, whatever the kind.
 */
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
      let response: Response;
      let text: string;
      try {
        response = await doFetch(options.url, {
          method: "POST",
          headers,
          body,
          signal: abort,
        });
        // Inside the transport boundary: fetch resolves on the headers, so a body
        // that stalls or drops is still a failure to reach, not a bad answer.
        text = await response.text();
      } catch (err) {
        throw new CoSignerUnavailableError(
          `payout co-signer unreachable: ${transportFailure(err, timeoutMs)}`,
        );
      }

      const payload = parseJson(text);
      if (response.status >= 500) {
        throw new CoSignerUnavailableError(
          `payout co-signer unavailable: ${refusalReason(payload, response.status)}`,
        );
      }
      if (!response.ok) {
        const reason = `payout co-signer refused: ${refusalReason(payload, response.status)}`;
        if (refusalCode(payload) === COSIGNER_CAP_REFUSAL_CODE) throw new CoSignerCapError(reason);
        throw new Error(reason);
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
