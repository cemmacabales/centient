import { isValidStellarAddress } from "@/lib/stellar/signature";

/** The `/api/auth/me` fields that decide where a session goes. */
export interface SessionMe {
  authenticated?: boolean;
  userId?: string;
  wallet?: string | null;
  email?: string | null;
}

export type SessionStep =
  | { step: "login" }
  | { step: "claim_wallet" }
  | { step: "payout_setup"; wallet: string };

/**
 * #30/#35: the proven wallet is the account. A session with a bound Stellar
 * wallet goes on toward the ranking surface whether or not it has an email; one
 * without a wallet — or with a legacy EVM `0x…` value that can never receive
 * USDC — claims one first and is served no work until it does.
 */
export function sessionStep(me: SessionMe): SessionStep {
  if (!me.authenticated) return { step: "login" };
  if (!me.wallet || !isValidStellarAddress(me.wallet)) return { step: "claim_wallet" };
  return { step: "payout_setup", wallet: me.wallet };
}
