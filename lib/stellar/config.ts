// Stellar chain configuration — the single source of truth for which network we
// talk to (Horizon URL + passphrase + explorer) and the stroop<->XLM conversion
// boundary. Introduced in ST-1a (#291) as the foundation Wave 1+ builds on,
// replacing the Celo/EVM chain-parameter layer.
//
// Stellar ledger amounts are integer **stroops** (1 XLM = 10^7 stroops, exactly
// 7 decimal places). The SDK's `Operation.payment` `amount`, however, takes a
// *decimal XLM string*. The helpers below own that boundary and use only
// string/BigInt arithmetic — never floating point — so large values and dust
// never lose precision (ST-0 #290 finding; reviewer note on #309).
import { Horizon, Networks } from "@stellar/stellar-sdk";

export type StellarNetwork = "testnet" | "public";

const HORIZON_TESTNET = "https://horizon-testnet.stellar.org";
const HORIZON_PUBLIC = "https://horizon.stellar.org";
const EXPLORER_TESTNET = "https://stellar.expert/explorer/testnet";
const EXPLORER_PUBLIC = "https://stellar.expert/explorer/public";

/** 1 XLM = 10^7 stroops (7 decimal places). */
export const STROOPS_PER_XLM = 10_000_000n;
const XLM_DECIMALS = 7;

/**
 * Active network from `STELLAR_NETWORK` (`testnet` | `public`), defaulting to
 * testnet. Fails fast on any other value so a typo can't silently point payouts
 * at the wrong ledger.
 */
export function stellarNetwork(): StellarNetwork {
  const raw = (process.env.STELLAR_NETWORK ?? "testnet").trim().toLowerCase();
  if (raw !== "testnet" && raw !== "public") {
    throw new Error(
      `STELLAR_NETWORK must be "testnet" or "public", got "${process.env.STELLAR_NETWORK}"`,
    );
  }
  return raw;
}

/** Horizon base URL. `STELLAR_HORIZON_URL` overrides the network default. */
export function horizonUrl(): string {
  const override = process.env.STELLAR_HORIZON_URL?.trim();
  if (override) return override;
  return stellarNetwork() === "public" ? HORIZON_PUBLIC : HORIZON_TESTNET;
}

/** Network passphrase that scopes a signed transaction to one network. */
export function networkPassphrase(): string {
  return stellarNetwork() === "public" ? Networks.PUBLIC : Networks.TESTNET;
}

/** stellar.expert explorer base. `NEXT_PUBLIC_EXPLORER_URL` overrides the default. */
export function explorerUrl(): string {
  const override = process.env.NEXT_PUBLIC_EXPLORER_URL?.trim();
  if (override) return override;
  return stellarNetwork() === "public" ? EXPLORER_PUBLIC : EXPLORER_TESTNET;
}

/** A configured Horizon server instance for the active network. */
export function server(): Horizon.Server {
  return new Horizon.Server(horizonUrl());
}

/**
 * Parse a decimal XLM string into integer stroops. Accepts a non-negative
 * decimal with at most 7 fractional digits; rejects anything else (negatives,
 * non-numeric, or >7 decimal places — which would silently truncate on-chain).
 */
export function xlmToStroops(xlm: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(xlm.trim());
  if (!match) {
    throw new Error(
      `xlmToStroops: invalid XLM amount "${xlm}" — expected a non-negative decimal with at most ${XLM_DECIMALS} decimal places`,
    );
  }
  const whole = BigInt(match[1]);
  const frac = BigInt((match[2] ?? "").padEnd(XLM_DECIMALS, "0"));
  return whole * STROOPS_PER_XLM + frac;
}

/**
 * Render integer stroops as a fixed 7-decimal XLM string suitable for the SDK's
 * `Operation.payment` `amount`. Round-trips with {@link xlmToStroops}.
 */
export function stroopsToXlmString(stroops: bigint): string {
  if (stroops < 0n) {
    throw new Error(`stroopsToXlmString: stroops must be non-negative, got ${stroops}`);
  }
  const whole = stroops / STROOPS_PER_XLM;
  const frac = (stroops % STROOPS_PER_XLM).toString().padStart(XLM_DECIMALS, "0");
  return `${whole}.${frac}`;
}
