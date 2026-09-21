// TC-024: per-user outstanding cap (2) and one outstanding sponsorship per address.
// Developer-prepared state: expired-pending rows (they can never land) placed in sponsored_trustlines.
import { randomUUID, randomBytes } from "node:crypto";
import { Client } from "pg";
import { call, evidence, key, signIn, short } from "./kit";

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const row = (userId: string, address: string) =>
    db.query(
      `insert into sponsored_trustlines (id,"userId",address,kind,"txHash",status,"expiresAt") values ($1,$2,$3,'account+trustline',$4,'pending',(now() at time zone 'utc') - interval '1 hour') returning id`,
      [randomUUID(), userId, address, randomBytes(32).toString("hex")],
    ).then((r) => r.rows[0].id as string);

  const W1 = key("tc024-U1-wallet"), X1 = key("tc024-X1"), X2 = key("tc024-X2");
  const Y1 = key("tc024-U1b-wallet"), Y2 = key("tc024-Y2");
  const W2 = key("tc024-U2-wallet"), X4 = key("tc024-X4");

  const U1 = await signIn(W1), U1b = await signIn(Y1), U2 = await signIn(W2), U3 = await signIn(X4);
  const ids: string[] = [];
  let scenarioError: unknown;
  try {
    ids.push(await row(U1.userId, X1.publicKey()));
    const x2 = await row(U1.userId, X2.publicKey());
    ids.push(x2);
    ids.push(await row(U1b.userId, Y1.publicKey()));
    ids.push(await row(U1b.userId, Y2.publicKey()));
    ids.push(await row(U2.userId, X4.publicKey()));
    const fixture = {
      U1: { wallet: short(W1.publicKey()), pendingRows: [short(X1.publicKey()), short(X2.publicKey())] },
      U1b: { wallet: short(Y1.publicKey()), pendingRows: [short(Y1.publicKey()) + " (own wallet)", short(Y2.publicKey())] },
      U2: { wallet: short(W2.publicKey()), pendingRows: [short(X4.publicKey())] },
      U3: { wallet: short(X4.publicKey()) + " (the address U2 holds an outstanding sponsorship for)" },
      rowState: "status=pending, expiresAt one hour in the past (counts as outstanding; can never land)",
    };

    const strip = (r: any) => ({ status: r.status, at: r.at, body: r.body?.xdr ? { ...r.body, xdr: `<${r.body.xdr.length}-char XDR offered>` } : r.body });
    const s1 = await call("GET", "/api/me/wallet/sponsor", { cookie: U1.cookie });
    await db.query(`update sponsored_trustlines set status='failed' where id=$1`, [x2]);
    const s2 = await call("GET", "/api/me/wallet/sponsor", { cookie: U1.cookie });
    const s3 = await call("GET", "/api/me/wallet/sponsor", { cookie: U1b.cookie });
    const s4 = await call("GET", "/api/me/wallet/sponsor", { cookie: U3.cookie });

    const out = {
      fixture,
      steps: [
        { step: 1, what: "U1 holds 2 pending rows; GET for its own new wallet", expect: "429 sponsorship_cap_reached", got: strip(s1) },
        { step: 2, what: "one of U1's rows marked failed (1 pending + 1 failed); GET again", expect: "envelope offered (failed rows do not count)", got: strip(s2) },
        { step: 3, what: "U1b holds 2 pending rows, one for its own wallet; GET for that wallet", expect: "envelope offered (own pending row not counted against itself)", got: strip(s3) },
        { step: 4, what: "U3 (wallet = address U2 holds an outstanding sponsorship for); GET", expect: "no envelope (409 address_in_use)", got: strip(s4) },
      ],
      noSignatureRequested: "No offered XDR was signed or submitted.",
    };
    evidence("024", "E024-1-cap-and-address-lock.json", out);
    console.log(JSON.stringify(out.steps.map((s) => ({ step: s.step, status: s.got.status, body: s.got.body })), null, 1));

  } catch (e) {
    scenarioError = e;
  }

  // Cleanup always runs, and never replaces the scenario's exception: the fake
  // rows are expired-pending, so leaving them behind counts against the real
  // per-user cap and per-address lock for live staging users.
  const cleanupErrors: unknown[] = [];
  if (ids.length) {
    try {
      await db.query(`delete from sponsored_trustlines where id = any($1)`, [ids]);
    } catch (e) {
      console.error("CLEANUP FAILED - remove these rows by hand:", ids, e);
      cleanupErrors.push(e);
    }
  }
  try {
    await db.end();
  } catch (e) {
    cleanupErrors.push(e);
  }

  if (scenarioError !== undefined && cleanupErrors.length) {
    throw new AggregateError([scenarioError, ...cleanupErrors], "scenario failed and cleanup failed");
  }
  if (scenarioError !== undefined) throw scenarioError;
  if (cleanupErrors.length) {
    throw cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "cleanup failed");
  }
})();
