"use client";

import { useState } from "react";
import { connect, signOwnership } from "@/lib/stellar/wallet";

interface StellarWalletLinkProps {
  /** The currently-linked `G…` payout address, if any. */
  walletAddress: string | null;
  /** Called after a successful link so the parent can refresh withdrawal state. */
  onLinked: () => void;
  showToast: (message: string, type: "success" | "error") => void;
}

/**
 * ST-4b (#300) — link + prove a Stellar payout address from the withdrawal screen.
 *
 * Login stays email/password; the wallet (Freighter) is used ONLY here: connect →
 * fetch a server challenge → sign it (SEP-53) → POST the proof. The server
 * verifies the signature, prechecks the USDC trustline, and binds the address.
 * An untrusted address surfaces clear guidance instead of a silent payout failure
 * (ST-4e #314 will turn that into an in-app sponsored-trustline flow).
 */
export default function StellarWalletLink({
  walletAddress,
  onLinked,
  showToast,
}: StellarWalletLinkProps) {
  const [linking, setLinking] = useState(false);

  const handleLink = async () => {
    if (linking) return;
    setLinking(true);
    try {
      // 1. Connect a wallet and read its `G…` address (never normalized).
      const { address } = await connect();

      // 2. Fetch a one-time, server-issued challenge bound to this address.
      const challengeRes = await fetch(
        `/api/me/wallet?address=${encodeURIComponent(address)}`,
      );
      const challenge = await challengeRes.json();
      if (!challengeRes.ok) {
        showToast(challenge.error ?? "Could not start wallet linking", "error");
        return;
      }

      // 3. Prove ownership by signing the challenge (Freighter SEP-53).
      const { signature } = await signOwnership(challenge.message, address);

      // 4. Submit the proof; server verifies + prechecks the USDC trustline.
      const linkRes = await fetch("/api/me/wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stellarAddress: address, signature }),
      });
      const result = await linkRes.json();

      if (linkRes.ok) {
        showToast("Payout wallet linked", "success");
        onLinked();
        return;
      }

      if (linkRes.status === 409 && result.error === "no_trustline") {
        showToast(
          result.message ??
            "This address has no USDC trustline yet. Add one in your wallet, then link again.",
          "error",
        );
        return;
      }

      showToast(result.error ?? "Wallet linking failed", "error");
    } catch (err) {
      // connect()/signOwnership() throw on rejection, no extension, or a non-SEP-53
      // wallet (Albedo) — surface the message so the labeler knows what to do.
      showToast(err instanceof Error ? err.message : "Wallet linking failed", "error");
    } finally {
      setLinking(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleLink}
      disabled={linking}
      className="mt-2 rounded-xl border border-outline px-5 py-2 font-label text-sm font-semibold text-on-surface transition-colors hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-50"
    >
      {linking
        ? "Linking..."
        : walletAddress
          ? "Change payout wallet"
          : "Link payout wallet"}
    </button>
  );
}
