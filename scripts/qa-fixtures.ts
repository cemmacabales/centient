// The QA fixture command: `seed`, `reset`, `status`.
//
// Deliberately not part of `prisma/seed.ts`. `SEED_ON_DEPLOY` is enabled on the
// `web` service, so `db:seed` runs on every production deploy; a QA-only branch
// inside that path would be one mis-set variable away from writing fixture
// payouts into the environment under test, on every deploy, unasked.
import "dotenv/config";
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { getDailyPayoutCapUnits } from "../lib/payout-cap";
import { unitsToUsdcDisplay } from "../lib/stellar/config";
import { assertFixturePreconditions, QaFixtureGateError } from "../lib/qa-fixtures/gate";
import { loadRecipientManifest } from "../lib/qa-fixtures/manifest";
import { seedQaFixtures } from "../lib/qa-fixtures/seed";
import { resetQaFixtures } from "../lib/qa-fixtures/reset";

type Command = "seed" | "reset" | "status";

function usage(): never {
  console.error(
    [
      "usage: pnpm qa:fixtures <seed|reset|status> [runId]",
      "",
      "  seed           create one run's D1 fixtures (testnet only)",
      "  reset [runId]  remove a run's fixtures, preserving anything broadcast",
      "  status         list recent runs",
    ].join("\n"),
  );
  process.exit(2);
}

function prismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  return new PrismaClient({ adapter });
}

async function runSeed(prisma: PrismaClient): Promise<void> {
  const manifest = loadRecipientManifest();
  const { network } = assertFixturePreconditions(process.env, manifest.network);

  const capUnits = getDailyPayoutCapUnits();
  const result = await seedQaFixtures({ prisma, manifest, network, capUnits });

  console.log(`\nSeeded QA fixture run ${result.runId}`);
  console.log(`  SHA         ${result.gitSha}`);
  console.log(`  network     ${result.network}`);
  console.log(`  campaign    ${result.campaignId}`);
  console.log(`  rows        ${result.seededCount}`);

  if (result.capPlan) {
    const { capUnits: cap, seededUsageUnits, headroomUnits } = result.capPlan;
    console.log(
      `\n  Cap boundary: cap ${unitsToUsdcDisplay(cap)}, seeded usage ` +
        `${unitsToUsdcDisplay(seededUsageUnits)}, headroom ${unitsToUsdcDisplay(headroomUnits)}`,
    );
    for (const preset of result.capPlan.presets) {
      console.log(
        `    ${preset.slug.padEnd(14)} ${unitsToUsdcDisplay(preset.amountUnits).padStart(12)}  ${preset.expectation}`,
      );
    }
  } else {
    console.log(`\n  Cap fixtures skipped — ${result.capSkippedReason}`);
  }

  console.log("\n  Payout states:");
  for (const [slug, id] of Object.entries(result.fixtures)) {
    if (!slug.startsWith("qa-") || slug.startsWith("qa-payable")) continue;
    // The seeded cap usage is a standalone withdrawal job, not a submission.
    // Printing the wrong reference kind would send QA looking for a row that
    // does not exist under that name.
    const kind = slug === "qa-cap-usage" ? "payout_job" : "submission";
    console.log(`    ${slug.padEnd(24)} ${kind}:${id}`);
  }
  console.log(
    `\n  Plus ${Object.keys(result.fixtures).filter((s) => s.startsWith("qa-payable")).length} payable references (qa-payable-01…).`,
  );
  console.log("\n  Full slug → id map is on the qa_fixture_runs row for this runId.");
}

async function runReset(prisma: PrismaClient, runId?: string): Promise<void> {
  assertFixturePreconditions(process.env);
  const result = await resetQaFixtures(prisma, runId);

  console.log(`\nReset QA fixture run ${result.runId}`);
  console.log(`  deleted     ${result.deletedCount}`);
  console.log(`  preserved   ${result.preservedCount}`);
  console.log(`  campaign    ${result.campaignRemoved ? "removed" : "kept"}`);

  if (result.preserved.length > 0) {
    // Loud on purpose. A preserved row means a fixture reference carries a
    // transaction hash, and if that hash is a real one it means money moved
    // through a QA fixture — which QA must see now, not discover later.
    console.log("\n  PRESERVED — these rows were NOT deleted:");
    for (const row of result.preserved) {
      console.log(`    ${row.kind} ${row.id}`);
      console.log(`      hash ${row.txHash}  (${row.reason})`);
    }
    console.log(
      "\n  A 'real-broadcast' reason means funds actually moved for that reference.\n" +
        "  Investigate before re-seeding; the row is intentionally left in place.",
    );
  }
}

async function runStatus(prisma: PrismaClient): Promise<void> {
  const runs = await prisma.qaFixtureRun.findMany({
    orderBy: { seededAt: "desc" },
    take: 10,
  });

  if (runs.length === 0) {
    console.log("No QA fixture runs recorded.");
    return;
  }

  console.log("\nRecent QA fixture runs:\n");
  for (const run of runs) {
    const state = run.resetAt ? `reset ${run.resetAt.toISOString()}` : "ACTIVE";
    console.log(`  ${run.runId}  ${run.seededAt.toISOString()}  ${state}`);
    console.log(
      `    sha ${run.gitSha.slice(0, 12)}  network ${run.network}  seeded ${run.seededCount}` +
        (run.deletedCount !== null ? `  deleted ${run.deletedCount}` : "") +
        (run.preservedCount ? `  PRESERVED ${run.preservedCount}` : ""),
    );
    if (run.note) console.log(`    note: ${run.note}`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (!command || !["seed", "reset", "status"].includes(command)) usage();

  const prisma = prismaClient();
  try {
    if (command === "seed") await runSeed(prisma);
    else if (command === "reset") await runReset(prisma, process.argv[3]);
    else await runStatus(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  if (error instanceof QaFixtureGateError) {
    console.error(`\n${error.message}\n`);
    process.exit(3);
  }
  console.error(`\n[qa-fixtures] ${(error as Error).message}\n`);
  process.exit(1);
});
