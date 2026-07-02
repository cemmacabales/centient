// Stellar chain configuration — the single source of truth for which network we
// talk to (Horizon URL + passphrase + explorer), the USDC asset we pay in, and
// the stroop<->USDC conversion boundary. Introduced in ST-1a (#291) as the
// foundation Wave 1+ builds on, replacing the Celo/EVM chain-parameter layer.
//
// Payouts settle in **USDC**, a Stellar *issued* asset (code + issuer account),
// not the native XLM. Every Stellar asset — USDC included — uses integer
// **units** at exactly 7 decimal places (1 USDC = 10^7 units). The SDK's
// `Operation.payment` `amount`, however, takes a *decimal string*. The helpers
// below own that boundary and use only string/BigInt arithmetic — never floating
// point — so large values and dust never lose precision (ST-0 #290 finding;
// reviewer note on #309).
//
// Unlike native XLM, a recipient must hold a **trustline** to the USDC issuer
// before they can be paid; a payment to an account without that trustline fails
// with `op_no_trust` (handled non-retryably in client.ts).
import { Asset, Horizon, Networks, StrKey } from "@stellar/stellar-sdk";

export type StellarNetwork = "testnet" | "public";

const HORIZON_TESTNET = "https://horizon-testnet.stellar.org";
const HORIZON_PUBLIC = "https://horizon.stellar.org";
const EXPLORER_TESTNET = "https://stellar.expert/explorer/testnet";
const EXPLORER_PUBLIC = "https://stellar.expert/explorer/public";

/** 1 USDC = 10^7 units (7 decimal places — true for every Stellar asset). */
export const UNITS_PER_USDC = 10_000_000n;
const USDC_DECIMALS = 7;

/** Default asset code when `STELLAR_USDC_CODE` is unset. */
const DEFAULT_USDC_CODE = "USDC";

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
 * The USDC asset payouts settle in, built from `STELLAR_USDC_ISSUER` (the
 * issuer's Stellar public key, `G…`) and an optional `STELLAR_USDC_CODE`
 * (defaults to `USDC`). Fails fast if the issuer is missing or malformed so a
 * misconfiguration can't silently point payouts at the wrong / a non-existent
 * asset.
 *
 * Known Circle USDC issuers (set via `STELLAR_USDC_ISSUER`):
 *   - mainnet (`STELLAR_NETWORK=public`):
 *       GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
 *   - testnet (Circle test USDC):
 *       GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
 * The issuer is intentionally NOT hardcoded per network — it stays in env so the
 * active network and its issuer are configured together and can't drift.
 */
export function usdcAsset(): Asset {
  const issuer = process.env.STELLAR_USDC_ISSUER?.trim();
  if (!issuer) {
    throw new Error(
      "STELLAR_USDC_ISSUER is not configured — set it to the USDC issuer's Stellar public key (G…)",
    );
  }
  if (!StrKey.isValidEd25519PublicKey(issuer)) {
    throw new Error(
      `STELLAR_USDC_ISSUER must be a valid Stellar public key (G…), got "${issuer}"`,
    );
  }
  const code = process.env.STELLAR_USDC_CODE?.trim() || DEFAULT_USDC_CODE;
  return new Asset(code, issuer);
}

/**
 * Parse a decimal USDC string into integer units. Accepts a non-negative
 * decimal with at most 7 fractional digits; rejects anything else (negatives,
 * non-numeric, or >7 decimal places — which would silently truncate on-chain).
 */
export function usdcToUnits(usdc: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(usdc.trim());
  if (!match) {
    throw new Error(
      `usdcToUnits: invalid USDC amount "${usdc}" — expected a non-negative decimal with at most ${USDC_DECIMALS} decimal places`,
    );
  }
  const whole = BigInt(match[1]);
  const frac = BigInt((match[2] ?? "").padEnd(USDC_DECIMALS, "0"));
  return whole * UNITS_PER_USDC + frac;
}

/**
 * Render integer units as a fixed 7-decimal USDC string suitable for the SDK's
 * `Operation.payment` `amount`. Round-trips with {@link usdcToUnits}.
 */
export function unitsToUsdcString(units: bigint): string {
  if (units < 0n) {
    throw new Error(`unitsToUsdcString: units must be non-negative, got ${units}`);
  }
  const whole = units / UNITS_PER_USDC;
  const frac = (units % UNITS_PER_USDC).toString().padStart(USDC_DECIMALS, "0");
  return `${whole}.${frac}`;
}

/**
 * Human-facing USDC amount: like {@link unitsToUsdcString} but trims trailing
 * fractional zeros (and a bare trailing dot) for display — `"0.1230000" → "0.123"`,
 * `"5.0000000" → "5"`. Use for UI/labels; use {@link unitsToUsdcString} for the
 * SDK payment `amount`, which needs the fixed 7-decimal form. This is the
 * viem-free replacement for `formatUnits(units, REWARD_TOKEN_DECIMALS)` display.
 */
export function unitsToUsdcDisplay(units: bigint): string {
  return unitsToUsdcString(units).replace(/\.?0+$/, "");
}
