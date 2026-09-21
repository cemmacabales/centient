// Map a reclaim report onto the fixture names, plus DB/chain state, for evidence.
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { horizon, key } from "./kit";

const NAMES = ["P1-linked", "P2-flagged-withdrawal", "P3-unsettled-submission", "P4-owed-balance", "P5-usdc-on-trustline", "O1-cannot-absorb", "E1-eligible", "E2-eligible"];
export const fixtureByAddress = () => Object.fromEntries(NAMES.map((n) => [key(`tc033-${n}`).publicKey(), n]));

export async function snapshot(db: Client) {
  const map = fixtureByAddress();
  const rows = (await db.query(`select address, status, "revokedAt" is not null as revoked, "releasedBy", "reclaimTxHash" from sponsored_trustlines`)).rows;
  const sponsor = await horizon.loadAccount(process.env.SPONSOR_PUBLIC!);
  const ledger = (await horizon.ledgers().order("desc").limit(1).call()).records[0];
  const liab = (await db.query(`select kind, count(*)::int n from sponsored_trustlines where "revokedAt" is null and status <> 'failed' group by kind`)).rows;
  const units = liab.reduce((s: number, r: any) => s + r.n * (r.kind === "account+trustline" ? 3 : 1), 0);
  return {
    sponsorSequence: sponsor.sequence,
    sponsorNumSponsoring: sponsor.num_sponsoring,
    ledgerSponsorshipLiabilityUnits: units,
    baseReserveStroops: ledger.base_reserve_in_stroops,
    totalRows: rows.length,
    runsStored: (await db.query(`select count(*)::int n from sponsorship_reclaim_runs`)).rows[0].n,
    fixtureRows: rows.filter((r) => map[r.address]).map((r) => ({ fixture: map[r.address], status: r.status, revoked: r.revoked, releasedBy: r.releasedBy })),
  };
}

export function byFixture(reportPath: string) {
  const r = JSON.parse(readFileSync(reportPath, "utf8"));
  const map = fixtureByAddress();
  return {
    mode: r.mode,
    runId: r.runId,
    totals: r.totals,
    fixtures: r.sponsorships.filter((s: any) => map[s.address]).map((s: any) => ({ fixture: map[s.address], disposition: s.disposition, entries: s.entries, txHash: s.txHash, detail: s.detail })),
    nonFixtureDispositions: r.sponsorships.filter((s: any) => !map[s.address]).reduce((a: any, s: any) => ((a[s.disposition] = (a[s.disposition] ?? 0) + 1), a), {}),
  };
}

if (require.main === module) {
  (async () => {
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const out: any = { snapshot: await snapshot(db) };
    if (process.argv[2]) out.report = byFixture(process.argv[2]);
    console.log(JSON.stringify(out, null, 1));
    await db.end();
  })();
}
