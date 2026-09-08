// The payments lane, defined once.
//
// Two things need to agree on what "the payments lane" means and must not drift
// apart: the named CI job that runs it (`vitest.payments.config.ts`, surfaced as
// the `payments-lane` workflow job) and the regression guard that asserts no
// module in it can broadcast a payout on one signature
// (`lib/stellar/__tests__/no-single-key-payout.test.ts`). Both import from here.
import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * Test files the payments lane runs in CI. Globs rather than a file list, so a
 * new payment test joins the lane by being written in the right place — nobody
 * has to remember to register it.
 */
export const PAYMENTS_LANE_TEST_GLOBS = [
  // The Stellar rail: envelope construction, signing, co-signing, submission,
  // reserve movement, and the co-signer service.
  "lib/stellar/__tests__/**/*.test.ts",
  // The payout engine: cap, broadcast bookkeeping, worker, service, alerting.
  "lib/__tests__/payout-*.test.ts",
  "lib/__tests__/health-alert.test.ts",
  "lib/__tests__/health-monitor.test.ts",
  "lib/__tests__/reconciler.test.ts",
  "lib/__tests__/sponsored-trustline.test.ts",
  // The money ledger the rail settles against.
  "lib/__tests__/campaign-balance.test.ts",
  "lib/__tests__/user-balance.test.ts",
  "lib/__tests__/withdrawal-eligibility.test.ts",
  "lib/__tests__/flagged-withdrawal.test.ts",
  "lib/__tests__/admin-data-cap-db.test.ts",
  "lib/__tests__/admin-data-hotwallet.test.ts",
  // The HTTP and cron edges that start a payout or read its health.
  "app/api/me/withdraw/__tests__/*.test.ts",
  "app/api/me/wallet/sponsor/__tests__/*.test.ts",
  "app/api/me/balance/__tests__/*.test.ts",
  "app/api/cron/payout-retry/__tests__/*.test.ts",
  "app/api/cron/payout-reconcile/__tests__/*.test.ts",
  "app/api/cron/reserve-refill/__tests__/*.test.ts",
  "app/api/cron/wallet-health/__tests__/*.test.ts",
  "app/api/health/wallet/__tests__/*.test.ts",
  "app/api/admin/flagged-withdrawals/**/__tests__/*.test.ts",
  "app/api/admin/submissions/**/__tests__/*.test.ts",
] as const;

/**
 * Directories the no-single-key guard reads. Everything that ships or is run by
 * hand against a live network — deliberately including `scripts/`, because "no
 * single-key payout path exists anywhere in the codebase" is not satisfied by a
 * library that behaves while a script next to it does not.
 */
export const PAYMENTS_LANE_SOURCE_ROOTS = ["lib", "app", "services", "scripts"] as const;

/** Never scanned: generated output, other branches' worktrees, and test code. */
const SKIP_DIRECTORIES = new Set([
  "__tests__",
  "node_modules",
  ".next",
  ".worktrees",
  ".claude",
  "generated",
]);

/**
 * Every Horizon submit call site the lane is allowed to contain, and why each
 * one cannot broadcast a payout on a single signature.
 *
 * An entry is a promise about a specific file. The guard verifies both
 * directions — an unlisted submit fails, and a listed path that no longer exists
 * or no longer submits fails too — so this list cannot quietly become a blanket
 * exemption for whatever later occupies the path.
 */
export const HORIZON_SUBMIT_ALLOWLIST: Readonly<Record<string, string>> = {
  "lib/stellar/payout-submitter.ts":
    "the sanctioned payout submit; assertPayoutFullySigned runs against both the inner payment and the fee bump before this line is reached",
  "lib/stellar/client.ts":
    "submitSponsoredTrustline — a recipient-signed sponsorship sandwich whose shape is asserted to carry no payment operation, so it moves XLM reserves and never contributor USDC",
  "scripts/stellar-multisig-setup.ts":
    "one-off operator ceremony that installs the 2-of-3 thresholds on the payout account; run by hand and unreachable from any request or worker path",
  "scripts/stellar-cold-reserve-setup.ts":
    "the same ceremony for the cold reserve account; sets options, moves no contributor funds",
  "scripts/stellar-reserve-refill.ts":
    "submits the cold-to-hot refill built by reserve-refill.ts, which requires all three approved signers and is signed offline",
  "scripts/stellar-multisig-payout-spike.ts":
    "issue #6's testnet spike; buildMultisigFeeBump asserts both required signers before it submits",
};

/**
 * Every module allowed to build a USDC `Operation.payment`, and why. This is the
 * half that catches a new payout constructed somewhere the submitter never sees:
 * a payment that is never built cannot be signed once and broadcast.
 */
export const USDC_PAYMENT_BUILDER_ALLOWLIST: Readonly<Record<string, string>> = {
  "lib/stellar/multisig-payout.ts":
    "buildUsdcPaymentTx, reached only through payout-envelope.buildPayoutPayment, whose result must pass assertPayoutFullySigned before submission",
  "lib/stellar/reserve-refill.ts":
    "the cold-to-hot treasury transfer; a 2-of-3 envelope signed in an offline ceremony and never submitted by the application",
};

/**
 * Modules allowed to read the platform payout signer's secret, and why.
 *
 * Signature #1 of the required two. Confined to the submitter at runtime, so no
 * other shipped module is even positioned to sign a payout envelope. The
 * co-signer's key half is public here by design (issue #8).
 */
export const PAYOUT_SIGNER_SECRET_ALLOWLIST: Readonly<Record<string, string>> = {
  "lib/stellar/payout-submitter.ts":
    "parsePayoutSignerConfig — the one place the platform signing key enters the payout path, and it rejects a co-signer configured to the same key",
  "scripts/stellar-multisig-payout-spike.ts":
    "issue #6's hand-run testnet ceremony, which necessarily holds both signer secrets locally and asserts the ops key matches STELLAR_OPS_SIGNER_PUBLIC before signing",
};

/** Repo-relative paths of every `.ts` source file in the lane's scan roots. */
export function paymentsLaneSourceFiles(repoRoot: string): string[] {
  const files: string[] = [];
  for (const root of PAYMENTS_LANE_SOURCE_ROOTS) {
    const absolute = path.join(repoRoot, root);
    let entries;
    try {
      entries = readdirSync(absolute, { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const full = path.join(entry.parentPath ?? entry.path, entry.name);
      const relative = path.relative(repoRoot, full);
      if (relative.split(path.sep).some((segment) => SKIP_DIRECTORIES.has(segment))) continue;
      files.push(relative.split(path.sep).join("/"));
    }
  }
  return files.sort();
}
