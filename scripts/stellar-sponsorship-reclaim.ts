// Operator entry point for sponsored-reserve reclaim (#29).
//
//   npm run stellar:sponsorship:reclaim
//       Dry run. Prints every outstanding sponsorship's disposition as JSON and
//       writes nothing — not to the ledger, not to the chain.
//
//   npm run stellar:sponsorship:reclaim -- execute --network=testnet
//       Reconciles pending sponsorships, records released reserves, revokes the
//       eligible ones, and stores the run's report. `--network` must name the
//       network this environment is configured for, so an execute run is never
//       pointed at a ledger by accident.
//
// Runs wherever the sponsorship key already lives (it signs with
// `STELLAR_SPONSOR_SECRET`, which key-custody.ts requires is no payout signer),
// against that environment's `DATABASE_URL`. Exits 2 when any sponsorship ended
// `failed`, so a run that needs attention does not look like a clean one.
import "dotenv/config";
import prisma from "../lib/prisma";
import { runSponsorshipReclaim, type ReclaimMode } from "../lib/sponsorship-reclaim";
import { stellarNetwork } from "../lib/stellar/config";

/** Parse `[dry-run|execute] [--network=<name>]`, refusing anything else. */
function parseArgs(argv: string[]): ReclaimMode {
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const mode = positional[0] ?? "dry-run";
  if (mode !== "dry-run" && mode !== "execute") {
    throw new Error(`unknown mode "${mode}"; use dry-run or execute`);
  }
  const unknown = argv.filter((arg) => arg.startsWith("--") && !arg.startsWith("--network="));
  if (unknown.length) throw new Error(`unknown option(s): ${unknown.join(" ")}`);

  if (mode === "execute") {
    const named = argv.find((arg) => arg.startsWith("--network="))?.slice("--network=".length);
    const configured = stellarNetwork();
    if (named !== configured) {
      throw new Error(
        `execute needs --network=${configured} to confirm the network this environment is configured for (got ${named ?? "none"})`,
      );
    }
  }
  return mode;
}

async function main(): Promise<void> {
  const mode = parseArgs(process.argv.slice(2));
  const report = await runSponsorshipReclaim({ mode });
  console.log(JSON.stringify(report, null, 2));

  const { totals } = report;
  console.error(
    `[sponsorship-reclaim] ${mode} on ${report.network}: ${totals.sponsorships} outstanding, ` +
      `${JSON.stringify(totals.byDisposition)}, reclaimed ${totals.reclaimedStroops} stroops, ` +
      `${totals.lockedReserveUnits} reserve units still locked` +
      (report.runId ? `, run ${report.runId}` : ""),
  );
  // Not process.exit(): stdout to a pipe is written asynchronously, and exiting
  // here could truncate the report an operator is capturing with `| tee`.
  process.exitCode = (totals.byDisposition.failed ?? 0) > 0 ? 2 : 0;
}

main()
  .catch((error) => {
    console.error("SPONSORSHIP RECLAIM FAILED:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  // The database pool would otherwise keep the process alive after the report.
  .finally(() => prisma.$disconnect());
