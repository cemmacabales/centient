import { NextRequest, NextResponse } from "next/server";
import { notFound } from "next/navigation";
import { explorerUrl } from "@/lib/stellar/config";
import { isValidStellarAddress } from "@/lib/stellar/signature";
import {
  HarnessError,
  harnessEnabled,
  harnessState,
  inspectCoSignedEnvelope,
  loadRecipientStatus,
  prepareSponsoredOnboarding,
  signatureChecks,
  submitSponsoredOnboarding,
} from "@/lib/stellar/freighter-proof";

/**
 * #24 Freighter proof harness API. Spike tooling: 404 unless
 * WALLET_PROOF_HARNESS=1 on testnet (see lib/stellar/freighter-proof.ts).
 *
 * One POST endpoint dispatching on `action`, so every step shares the same
 * in-memory challenge store and pending sponsorship:
 *
 *   status    → Horizon view of the address
 *   challenge → issue a one-time ownership challenge
 *   verify    → check a Freighter SEP-53 proof, then run the negative rules on it
 *   sponsor   → build + sponsor-sign the onboarding transaction
 *   submit    → inspect the Freighter-co-signed envelope, then submit it
 */
export async function POST(req: NextRequest) {
  if (!harnessEnabled()) notFound();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const text = (value: unknown) => (typeof value === "string" ? value : "");
  // No normalization: a lowercased G… is a different, invalid key.
  const address = text(body.address);
  if (!isValidStellarAddress(address)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  }

  const state = harnessState();
  try {
    switch (body.action) {
      case "status":
        return NextResponse.json({ status: await loadRecipientStatus(address) });

      case "challenge": {
        const challenge = state.challenges.issue(address);
        return NextResponse.json({
          nonce: challenge.nonce,
          message: challenge.message,
          expiresAt: challenge.expiresAt.toISOString(),
          networkPassphrase: challenge.networkPassphrase,
        });
      }

      case "verify": {
        const signature = text(body.signature);
        const result = state.challenges.verify({
          address,
          nonce: text(body.nonce),
          signature,
          signerAddress: typeof body.signerAddress === "string" ? body.signerAddress : undefined,
        });
        if (!result.ok) {
          return NextResponse.json({ ok: false, reason: result.reason }, { status: 401 });
        }
        return NextResponse.json({ ok: true, checks: signatureChecks(result.challenge, signature) });
      }

      case "sponsor":
        return NextResponse.json(await prepareSponsoredOnboarding(address, state));

      case "submit": {
        const pending = state.pending.get(address);
        if (!pending) {
          return NextResponse.json({ error: "no_pending_sponsorship" }, { status: 409 });
        }
        const inspection = inspectCoSignedEnvelope({ signedXdr: text(body.signedXdr), pending });
        if (!inspection.ok || !inspection.tx) {
          return NextResponse.json({ ok: false, checks: inspection.checks }, { status: 400 });
        }
        // One submission per build: a failed submit must be rebuilt and re-signed.
        state.pending.delete(address);
        const submitted = await submitSponsoredOnboarding({
          tx: inspection.tx,
          feeBump: body.feeBump !== false,
          state,
        });
        return NextResponse.json({
          ok: true,
          kind: pending.kind,
          checks: inspection.checks,
          ...submitted,
          explorerTx: `${explorerUrl()}/tx/${submitted.hash}`,
          before: pending.before,
          after: await loadRecipientStatus(address),
        });
      }

      default:
        return NextResponse.json({ error: "unknown_action" }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof HarnessError) {
      return NextResponse.json(
        { error: err.code, detail: err.message },
        { status: err.code === "already_trusted" ? 409 : 502 },
      );
    }
    return NextResponse.json(
      { error: "harness_failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
