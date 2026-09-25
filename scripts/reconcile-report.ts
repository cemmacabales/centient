// Zero-unreconciled payout report (#40).
//
//   npm run reconcile:report -- --since=2026-09-24T00:00:00Z [--until=…]
//   npm run reconcile:report -- --hours=24 [--out=<dir>] [--sent-overdue-min=30] [--no-horizon]
//
// Reads the database named by `DATABASE_URL` and Horizon for the configured
// network, and writes `report.json` (machine-readable) and `report.md`
// (reviewer-readable) to `--out` (default `./reconcile-report-<timestamp>`).
// Needs `STELLAR_PLATFORM_ACCOUNT` and `STELLAR_USDC_ISSUER` to check what each
// confirmed payout paid, unless run with `--no-horizon`.
//
// Read-only. Every database session is opened read-only, and the run refuses to
// start unless the server confirms it. Exits 1 when anything is unreconciled, so
// a run that needs attention never looks like a clean one.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Before the Prisma client exists: node-postgres reads PGOPTIONS for every
// connection it opens.
process.env.PGOPTIONS = [process.env.PGOPTIONS, "-c default_transaction_read_only=on"].filter(Boolean).join(" ");

interface Args {
  since: Date;
  until: Date;
  out: string;
  sentOverdueMs: number | undefined;
  horizon: boolean;
}

function parseArgs(argv: string[]): Args {
  const opts = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`unexpected argument "${arg}"`);
    opts.set(match[1], match[2] ?? "");
  }
  const known = new Set(["since", "until", "hours", "out", "sent-overdue-min", "no-horizon"]);
  const unknown = [...opts.keys()].filter((k) => !known.has(k));
  if (unknown.length) throw new Error(`unknown option(s): ${unknown.map((k) => `--${k}`).join(" ")}`);

  const date = (name: string) => {
    const value = new Date(opts.get(name)!);
    if (Number.isNaN(value.getTime())) throw new Error(`--${name} is not a date: ${opts.get(name)}`);
    return value;
  };
  const until = opts.has("until") ? date("until") : new Date();
  let since: Date;
  if (opts.has("since")) since = date("since");
  else if (opts.has("hours")) since = new Date(until.getTime() - Number(opts.get("hours")) * 3_600_000);
  else throw new Error("give a window: --since=<ISO date> or --hours=<n>");
  if (!(since < until)) throw new Error("--since must be before --until");

  const overdue = opts.get("sent-overdue-min");
  return {
    since,
    until,
    out: opts.get("out") || `reconcile-report-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    sentOverdueMs: overdue ? Number(overdue) * 60_000 : undefined,
    horizon: !opts.has("no-horizon"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { default: prisma } = await import("../lib/prisma");
  const { buildReconcileReport, renderReconcileMarkdown } = await import("../lib/payout-reconcile-report");
  const { lookupTx } = await import("../lib/stellar/client");
  const { usdcAsset } = await import("../lib/stellar/config");

  try {
    const [session] = await prisma.$queryRaw<{ transaction_read_only: string }[]>`SHOW transaction_read_only`;
    if (session?.transaction_read_only !== "on") {
      throw new Error("the database session is not read-only; refusing to run");
    }

    let horizon = null;
    if (args.horizon) {
      const payoutAccount = process.env.STELLAR_PLATFORM_ACCOUNT?.trim();
      if (!payoutAccount) throw new Error("STELLAR_PLATFORM_ACCOUNT is not set; set it, or run with --no-horizon");
      horizon = { lookupTx, expected: { payoutAccount, asset: usdcAsset() } };
    }

    const report = await buildReconcileReport({
      since: args.since,
      until: args.until,
      sentOverdueMs: args.sentOverdueMs,
      horizon,
    });

    mkdirSync(args.out, { recursive: true });
    writeFileSync(path.join(args.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(path.join(args.out, "report.md"), `${renderReconcileMarkdown(report)}\n`);

    console.error(
      `[reconcile-report] ${report.window.since} to ${report.window.until}: ${report.totals.submissions} submissions, ` +
        `${report.reconciled.length} reconciled, ${report.pending.length} pending, ` +
        `${report.excluded.qaFixture.length + report.excluded.legacyEvm.length} excluded, ` +
        `${report.unreconciled.length} unreconciled → ${args.out}/report.{json,md}`,
    );
    process.exitCode = report.zeroUnreconciled ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`[reconcile-report] ${err instanceof Error ? err.message : err}`);
  process.exitCode = 2;
});
