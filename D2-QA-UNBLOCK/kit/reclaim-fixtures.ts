// TC-033 developer-prepared state on staging: one sponsored contributor per protected class, one owner who cannot
// absorb the reserve, and two eligible entries. Every account is onboarded through the deployed sponsorship path.
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { Asset, account, call, evidence, friendbot, key, Operation, short, signIn, signXdr, submitOps, USDC } from "./kit";

const FIXTURES = ["P1-linked", "P2-flagged-withdrawal", "P3-unsettled-submission", "P4-owed-balance", "P5-usdc-on-trustline", "O1-cannot-absorb", "E1-eligible", "E2-eligible"];

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const helper = key("reclaim-helper");
  if (!(await account(helper.publicKey()))) await friendbot(helper.publicKey());

  const made: any[] = [];
  for (const name of FIXTURES) {
    const kp = key(`tc033-${name}`);
    const s = await signIn(kp);
    if (!(await account(kp.publicKey()))) {
      const g = await call("GET", "/api/me/wallet/sponsor", { cookie: s.cookie });
      const p = await call("POST", "/api/me/wallet/sponsor", { cookie: s.cookie, json: { signedXdr: signXdr(g.body.xdr, kp) } });
      if (p.status !== 200) throw new Error(`${name} onboarding ${p.status} ${JSON.stringify(p.body)}`);
    }
    made.push({ name, kp, userId: s.userId });
  }
  const by = (n: string) => made.find((m) => m.name === n)!;

  // Everyone except P1 is unlinked, so the linked-wallet rule does not mask the class under test.
  for (const m of made.filter((m) => m.name !== "P1-linked")) {
    await db.query(`update users set "walletAddress"=null where id=$1`, [m.userId]);
  }
  const P2 = by("P2-flagged-withdrawal");
  if (!(await db.query(`select 1 from flagged_withdrawals where "userId"=$1 and status='PENDING'`, [P2.userId])).rowCount) await db.query(
    `insert into flagged_withdrawals (id,"userId","walletAddress",reason,detail,"balanceUnits",status,"updatedAt") values ($1,$2,$3,'INELIGIBLE',$4,0,'PENDING',now())`,
    [randomUUID(), P2.userId, P2.kp.publicKey(), JSON.stringify({ qaFixture: "D2-TC-033" })],
  );
  const P3 = by("P3-unsettled-submission");
  const task = (await db.query(`select id from tasks limit 1`)).rows[0].id;
  if (!(await db.query(`select 1 from submissions where "userId"=$1`, [P3.userId])).rowCount) await db.query(
    `insert into submissions (id,"walletAddress","userId","taskId",choice,reason,"payoutAmountUnits","payoutStatus") values ($1,$2,$3,$4,'qa-fixture','D2-TC-033 fixture',0,'needs_reconciliation')`,
    [randomUUID(), P3.kp.publicKey(), P3.userId, task],
  );
  const P4 = by("P4-owed-balance");
  await db.query(`update users set "pendingBalanceUnits"=1 where id=$1`, [P4.userId]);

  // P5, E1, E2 hold their own XLM (so rule 6 does not stop them); P5 also holds USDC buying liabilities.
  for (const n of ["P5-usdc-on-trustline", "E1-eligible", "E2-eligible"]) {
    const a = await account(by(n).kp.publicKey());
    const xlm = Number(a!.balances.find((b: any) => b.asset_type === "native")!.balance);
    if (xlm < 3) await submitOps(helper, [Operation.payment({ destination: by(n).kp.publicKey(), asset: Asset.native(), amount: "5" })]);
  }
  const P5 = by("P5-usdc-on-trustline");
  const p5 = await account(P5.kp.publicKey());
  if (!p5!.balances.some((b: any) => b.asset_code === "USDC" && Number(b.buying_liabilities) > 0)) {
    await submitOps(P5.kp, [Operation.manageBuyOffer({ selling: Asset.native(), buying: USDC, buyAmount: "1", price: "0.01" })]);
  }

  const summary = made.map((m) => ({ fixture: m.name, address: m.kp.publicKey(), userId: m.userId }));
  evidence("033", "E033-2-fixture-state.json", {
    note: "Every fixture onboarded through the deployed GET/POST /api/me/wallet/sponsor path (zero-XLM, account+trustline). All but P1 then unlinked.",
    protectionPlaced: {
      "P1-linked": "wallet still bound to its user",
      "P2-flagged-withdrawal": "flagged_withdrawals row, status PENDING, walletAddress = P2",
      "P3-unsettled-submission": "submissions row, payoutStatus needs_reconciliation (no cron acts on it), amount 0",
      "P4-owed-balance": "owner pendingBalanceUnits = 1",
      "P5-usdc-on-trustline": "5 XLM funded; manageBuyOffer 1 USDC @ 0.01 XLM -> USDC buying liabilities on the trustline",
      "O1-cannot-absorb": "0 XLM of its own",
      "E1-eligible / E2-eligible": "5 XLM of their own, no protection",
    },
    fixtures: summary,
  });
  console.log(JSON.stringify(summary.map((s) => ({ ...s, address: short(s.address) })), null, 1));
  await db.end();
})();
