import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import FreighterProofHarness from "@/components/dev/FreighterProofHarness";
import { explorerUrl, networkPassphrase } from "@/lib/stellar/config";
import { harnessEnabled } from "@/lib/stellar/freighter-proof";

export const metadata: Metadata = {
  title: "Freighter proof harness",
  robots: { index: false, follow: false },
};

/**
 * #24 spike: drive the real Freighter extension through the ownership proof and
 * the sponsored onboarding co-sign on testnet, and collect the evidence.
 * 404 unless WALLET_PROOF_HARNESS=1 on testnet.
 */
export default async function FreighterProofPage() {
  // The gate is an environment read, so it must run per request, not at build.
  await connection();
  if (!harnessEnabled()) notFound();

  return (
    <FreighterProofHarness networkPassphrase={networkPassphrase()} explorerBase={explorerUrl()} />
  );
}
