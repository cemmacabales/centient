// TC-026: sponsor cannot cover reserves + fee -> 503 before any XDR.
// Developer-prepared F5: the sponsor's spendable XLM is parked in a holder account for a few seconds, then merged back.
import { Client } from "pg";
import { Keypair } from "@stellar/stellar-sdk";
import { account, call, evidence, horizon, key, Operation, short, signIn, submitOps } from "./kit";

async function sponsorState(pub: string) {
  const a = await horizon.loadAccount(pub);
  const ledger = (await horizon.ledgers().order("desc").limit(1).call()).records[0];
  const base = Number(ledger.base_reserve_in_stroops) / 1e7;
  const native = a.balances.find((b: any) => b.asset_type === "native") as any;
  const locked = (2 + a.subentry_count + (a.num_sponsoring ?? 0) - (a.num_sponsored ?? 0)) * base;
  const spendable = Number(native.balance) - Number(native.selling_liabilities ?? 0) - locked;
  return { balance: native.balance, subentry_count: a.subentry_count, num_sponsoring: a.num_sponsoring, base_reserve_xlm: base, spendable_xlm: spendable.toFixed(7), needed_for_account_plus_trustline_xlm: (3 * base).toFixed(7) + " + fee" };
}

(async () => {
  const sponsor = Keypair.fromSecret(process.env.STELLAR_SPONSOR_SECRET!);
  const holder = key("tc026-holder");
  const F1 = key("tc026-F1");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const out: any = { sponsor: sponsor.publicKey(), F1: short(F1.publicKey()), steps: [] };

  const f = await signIn(F1); // wallet-only fixture, never funded
  out.steps.push({ step: "setup", sponsorBefore: await sponsorState(sponsor.publicKey()) });

  const before = await sponsorState(sponsor.publicKey());
  const park = (Number(before.spendable_xlm) - 1.2).toFixed(7); // leaves ~0.2 XLM spendable after the holder's reserve & fee
  let parked = false;
  try {
    const t1 = await submitOps(sponsor, [Operation.createAccount({ destination: holder.publicKey(), startingBalance: park })]);
    parked = true;
    out.steps.push({ step: "F5 in place: spendable XLM parked in holder " + short(holder.publicKey()), tx: t1.hash, sponsorDuring: await sponsorState(sponsor.publicKey()) });

    const r = await call("GET", "/api/me/wallet/sponsor", { cookie: f.cookie });
    const rows = await db.query(`select count(*)::int n from sponsored_trustlines where address=$1`, [F1.publicKey()]);
    out.steps.push({
      step: "1: GET /api/me/wallet/sponsor for F1 while the sponsor is short",
      expect: "503 sponsorship_unavailable before any XDR; no signature requested; no intent row",
      got: { status: r.status, body: r.body, at: r.at },
      xdrOffered: Boolean(r.body?.xdr),
      intentRowsForF1: rows.rows[0].n,
      f1OnChain: (await account(F1.publicKey())) ? "exists" : "404 (no partial account)",
    });
  } finally {
    // Restoration is the whole safety story for this case: until the holder is
    // merged back, the shared staging sponsor is short of its reserve and real
    // onboarding answers 503. A Horizon timeout is ambiguous -- the merge may
    // still have landed -- so re-read the holder before every attempt and treat
    // "holder is gone" as success rather than resubmitting.
    if (parked || (await account(holder.publicKey()))) {
      const ATTEMPTS = 5;
      let restored = false;
      for (let i = 1; i <= ATTEMPTS && !restored; i++) {
        if (!(await account(holder.publicKey()))) {
          restored = true; // a previous attempt landed after all
          out.steps.push({ step: `restore: holder already merged (confirmed on attempt ${i})` });
          break;
        }
        try {
          const t2 = await submitOps(holder, [Operation.accountMerge({ destination: sponsor.publicKey() })]);
          restored = !(await account(holder.publicKey()));
          out.steps.push({ step: "restore: holder merged back into sponsor", attempt: i, tx: t2.hash, sponsorAfter: await sponsorState(sponsor.publicKey()) });
        } catch (e: any) {
          const detail = e?.response?.data?.extras?.result_codes ?? e?.message ?? String(e);
          out.steps.push({ step: "restore: attempt failed", attempt: i, error: detail });
          console.error(`restore attempt ${i}/${ATTEMPTS} failed:`, detail);
          if (i < ATTEMPTS) await new Promise((r) => setTimeout(r, 5_000 * i));
        }
      }
      if (!restored) {
        // Never exit quietly leaving the sponsor short. Record the state and the
        // exact command that finishes the job, in the evidence and on the console.
        const recovery = `npx tsx -e 'import{Keypair}from"@stellar/stellar-sdk";import{submitOps,Operation}from"./D2-QA-UNBLOCK/kit/kit";submitOps(Keypair.fromSecret(process.env.TC026_HOLDER_SECRET!),[Operation.accountMerge({destination:"${sponsor.publicKey()}"})]).then(t=>console.log(t.hash))'`;
        out.restoreFailed = {
          holder: holder.publicKey(),
          sponsor: sponsor.publicKey(),
          sponsorState: await sponsorState(sponsor.publicKey()).catch((e) => String(e)),
          impact: "THE STAGING SPONSOR IS STILL SHORT. Sponsored onboarding will answer 503 until the holder is merged back.",
          recoveryCommand: recovery,
        };
        console.error("\n*** TC-026 RESTORATION FAILED — STAGING SPONSOR IS SHORT ***");
        console.error("holder:", holder.publicKey());
        console.error("run:", recovery, "\n");
      }
    }
  }
  try {
    const again = await call("GET", "/api/me/wallet/sponsor", { cookie: f.cookie });
    out.steps.push({ step: "recovery check (not part of the TC): GET after restore", got: { status: again.status, kind: again.body?.kind, xdrOffered: Boolean(again.body?.xdr) } });
  } finally {
    // Write whatever was observed, including restoreFailed, even on a partial run.
    evidence("026", "E026-2-insolvent-sponsor-503.json", out);
    console.log(JSON.stringify(out, null, 1));
    await db.end();
  }
})();
