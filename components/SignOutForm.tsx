"use client";

import { type FormEvent, useRef } from "react";
import { disconnect as disconnectWallet, SIGN_OUT_WAIT_MS } from "@/lib/stellar/wallet";

/**
 * A sign-out button that drops the WalletConnect session before the logout
 * posts, as AccountSheet's does. The pairing is stored by the relay SDK and
 * outlives the session cookie, so without this the next sign-in on this phone
 * starts from a session Freighter may no longer hold. Best-effort and bounded:
 * signing out never waits long, or fails, because a relay did.
 */
export default function SignOutForm({ className }: { className: string }) {
  const submitting = useRef(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    const form = event.currentTarget;
    await Promise.race([
      disconnectWallet().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, SIGN_OUT_WAIT_MS)),
    ]);
    form.submit();
  };

  return (
    <form action="/api/auth/logout" method="post" onSubmit={onSubmit}>
      <button type="submit" className={className}>
        Sign out
      </button>
    </form>
  );
}
