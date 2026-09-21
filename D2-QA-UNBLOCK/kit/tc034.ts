// TC-034: stored report has no keys, user ids, or wallet addresses; a second execute sends nothing;
// sponsor num_sponsoring equals the ledger's sponsorship liability.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Client } from "pg";
import { evidence, horizon } from "./kit";
import { byFixture, snapshot } from "./reclaim-view";

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const run = (await db.query(`select * from sponsorship_reclaim_runs order by "startedAt" desc limit 1`).catch(() => db.query(`select * from sponsorship_reclaim_runs limit 1`))).rows[0];
  const stored = JSON.stringify(run);
  const userIds = (await db.query(`select id from users`)).rows.map((r) => r.id as string);
  const scan = {
    stellarAccountIds: stored.match(/G[A-Z2-7]{55}/g) ?? [],
    stellarSecretSeeds: (stored.match(/S[A-Z2-7]{55}/g) ?? []).length,
    userIdsFound: userIds.filter((id) => stored.includes(id)).length,
    columns: Object.keys(run),
  };

  // scan.stellarAccountIds records every G... in the stored row, which includes the
  // sponsor's own key from the `sponsor` column. Only contributor keys matter here.
  const contributorAccountIds = (scan.stellarAccountIds as string[]).filter((g) => g !== run.sponsor);

  const before = await snapshot(db);
  const second = execFileSync("npx", ["tsx", "scripts/stellar-sponsorship-reclaim.ts", "execute", "--network=testnet"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const p = require("node:path").resolve(__dirname, "../../exec2.json");
  writeFileSync(p, second);
  const after = await snapshot(db);
  const r2 = byFixture(p);

  evidence("034", "E034-2-report-and-second-run.json", {
    step1_storedReport: { runId: run.id, scan, contributorAccountIds, sponsorKeyPresent: (scan.stellarAccountIds as string[]).includes(run.sponsor), expect: "0 seeds, 0 user ids, 0 CONTRIBUTOR account ids; the platform sponsor's own key may appear (run.sponsor column, by design)", sample: stored.slice(0, 1500) },
    step2_secondExecute: {
      expect: "sends nothing",
      sponsorSequence: { before: before.sponsorSequence, after: after.sponsorSequence },
      reclaimedStroops: r2.totals.reclaimedStroops,
      fixtureDispositions: r2.fixtures.map((f: any) => `${f.fixture}: ${f.disposition}`),
    },
    step3_liability: { sponsorNumSponsoring: after.sponsorNumSponsoring, ledgerSponsorshipLiabilityUnits: after.ledgerSponsorshipLiabilityUnits, equal: after.sponsorNumSponsoring === after.ledgerSponsorshipLiabilityUnits },
  });
  console.log(JSON.stringify({ scan: { ...scan, stellarAccountIds: scan.stellarAccountIds.length }, seq: [before.sponsorSequence, after.sponsorSequence], reclaimed: r2.totals.reclaimedStroops, e: r2.fixtures.filter((f: any) => f.fixture.startsWith("E")), liability: [after.sponsorNumSponsoring, after.ledgerSponsorshipLiabilityUnits] }, null, 1));
  await db.end();
})();
