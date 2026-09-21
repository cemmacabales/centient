// TC-031 + TC-033 step 2-3: an onboarding envelope is signed and in flight when the reclaim execute run fires;
// the run consumes the shared sponsor sequence, so the in-flight submit must answer 409 retry, and the wallet retry lands.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Client } from "pg";
import { account, call, evidence, horizon, key, short, signIn, signXdr } from "./kit";
import { byFixture, snapshot } from "./reclaim-view";

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const OF = key("tc031-onboarding");
  const xlm = async (n: string) => (await account(key(`tc033-${n}`).publicKey()))!.balances.find((b: any) => b.asset_type === "native")!.balance;
  const hasUsdcLine = async (n: string) => (await account(key(`tc033-${n}`).publicKey()))!.balances.some((b: any) => b.asset_code === "USDC");

  const before = await snapshot(db);
  const chainBefore = { E1: await xlm("E1-eligible"), E2: await xlm("E2-eligible") };

  const s = await signIn(OF);
  const g = await call("GET", "/api/me/wallet/sponsor", { cookie: s.cookie });
  const signed = signXdr(g.body.xdr, OF);
  const seqAtBuild = (await horizon.loadAccount(process.env.SPONSOR_PUBLIC!)).sequence;

  // The operator run, while the contributor's envelope is signed and not yet submitted.
  const report = execFileSync("npx", ["tsx", "scripts/stellar-sponsorship-reclaim.ts", "execute", "--network=testnet"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const reportPath = require("node:path").resolve(__dirname, "../../exec1.json");
  writeFileSync(reportPath, report);
  const seqAfterRun = (await horizon.loadAccount(process.env.SPONSOR_PUBLIC!)).sequence;

  const p1 = await call("POST", "/api/me/wallet/sponsor", { cookie: s.cookie, json: { signedXdr: signed } });
  const g2 = await call("GET", "/api/me/wallet/sponsor", { cookie: s.cookie });
  const p2 = await call("POST", "/api/me/wallet/sponsor", { cookie: s.cookie, json: { signedXdr: signXdr(g2.body.xdr, OF) } });
  const of = await account(OF.publicKey());

  evidence("031", "E031-2-reclaim-concurrent-409.json", {
    onboardingFixture: short(OF.publicKey()),
    sponsorSequence: { atBuild: seqAtBuild, afterReclaimRun: seqAfterRun },
    step1: { what: "submit the envelope signed before the reclaim execute run", expect: "409 retry", got: { status: p1.status, body: p1.body, at: p1.at } },
    walletRetry: { rebuild: g2.status, resubmit: p2.status, body: p2.body, xlm: of?.balances.find((b: any) => b.asset_type === "native")?.balance, usdcTrustline: Boolean(of?.balances.some((b: any) => b.asset_code === "USDC")) },
    rowsForAddress: (await db.query(`select status, kind from sponsored_trustlines where address=$1 order by "createdAt"`, [OF.publicKey()])).rows,
  });

  const after = await snapshot(db);
  evidence("033", "E033-3-execute-run.json", {
    report: byFixture(reportPath),
    before,
    after,
    chain: {
      E1: { xlmBefore: chainBefore.E1, xlmAfter: await xlm("E1-eligible"), usdcTrustlineStillPresent: await hasUsdcLine("E1-eligible") },
      E2: { xlmBefore: chainBefore.E2, xlmAfter: await xlm("E2-eligible"), usdcTrustlineStillPresent: await hasUsdcLine("E2-eligible") },
    },
  });
  console.log(JSON.stringify({ p1: [p1.status, p1.body], p2: [p2.status, p2.body], report: byFixture(reportPath).fixtures.map((f: any) => `${f.fixture}: ${f.disposition}`), after: { ...after, fixtureRows: undefined } }, null, 1));
  await db.end();
})();
