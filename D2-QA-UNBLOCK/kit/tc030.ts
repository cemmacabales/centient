// TC-030: tx_bad_seq inside the fee bump -> retry answered, row released, no leaked reserve.
// Developer-prepared state: the sponsor's sequence is advanced (bumpSequence, sponsor-signed) between build and submit.
import { Client } from "pg";
import { Keypair } from "@stellar/stellar-sdk";
import { account, call, evidence, horizon, key, Operation, short, signIn, signXdr, submitOps } from "./kit";

(async () => {
  const sponsor = Keypair.fromSecret(process.env.STELLAR_SPONSOR_SECRET!);
  const F1 = key(process.argv[2] ?? "tc030-F1");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const rows = async () => (await db.query(`select status, kind, "revokedAt" is null as live from sponsored_trustlines where address=$1 order by "createdAt"`, [F1.publicKey()])).rows;
  const numSponsoring = async () => (await horizon.loadAccount(sponsor.publicKey())).num_sponsoring;
  const out: any = { F1: short(F1.publicKey()), sponsor: short(sponsor.publicKey()), steps: [] };

  const f = await signIn(F1);
  const nsBefore = await numSponsoring();
  const g = await call("GET", "/api/me/wallet/sponsor", { cookie: f.cookie });
  const signed = signXdr(g.body.xdr, F1);
  out.steps.push({ step: "setup: envelope built for F1 and signed by F1", kind: g.body.kind, sponsorSeqAtBuild: (await horizon.loadAccount(sponsor.publicKey())).sequence });

  const acct = await horizon.loadAccount(sponsor.publicKey());
  const bump = await submitOps(sponsor, [Operation.bumpSequence({ bumpTo: (BigInt(acct.sequence) + 2n).toString() })]);
  out.steps.push({ step: "state: sponsor sequence advanced outside the app", tx: bump.hash, sponsorSeqNow: (await horizon.loadAccount(sponsor.publicKey())).sequence });

  const p1 = await call("POST", "/api/me/wallet/sponsor", { cookie: f.cookie, json: { signedXdr: signed } });
  out.steps.push({
    step: "1: submit the stale envelope",
    expect: "409 retry; row released; no leaked reserve",
    got: { status: p1.status, body: p1.body, at: p1.at },
    rowsForF1: await rows(),
    f1OnChain: (await account(F1.publicKey())) ? "exists" : "404 (no partial account)",
    sponsorNumSponsoring: { before: nsBefore, after: await numSponsoring() },
  });

  const g2 = await call("GET", "/api/me/wallet/sponsor", { cookie: f.cookie });
  const p2 = await call("POST", "/api/me/wallet/sponsor", { cookie: f.cookie, json: { signedXdr: signXdr(g2.body.xdr, F1) } });
  const f1 = await account(F1.publicKey());
  out.steps.push({
    step: "2: retry (rebuild, re-sign, resubmit)",
    expect: "retry answered; onboarding completes",
    got: { rebuild: g2.status, submit: p2.status, body: p2.body },
    rowsForF1: await rows(),
    f1XlmBalance: f1?.balances.find((b: any) => b.asset_type === "native")?.balance,
    f1HasUsdcTrustline: Boolean(f1?.balances.find((b: any) => b.asset_code === "USDC")),
    sponsorNumSponsoring: await numSponsoring(),
  });
  evidence("030", "E030-2-bad-seq-retry.json", out);
  console.log(JSON.stringify(out, null, 1));
  await db.end();
})();
