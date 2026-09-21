// TC-038: provision F4 (verified email account, no wallet) on staging; optionally run the takeover to validate.
import { randomUUID, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { Client } from "pg";
import { call, evidence, key, sep53, signIn, short } from "./kit";

async function provision(db: Client, email: string) {
  const password = randomBytes(9).toString("base64url");
  const hash = await bcrypt.hash(password, 12);
  await db.query(
    `insert into users (id, email, "passwordHash", "isVerified", "verifiedAt", "onboardingCompleted")
     values ($1,$2,$3,true,now(),true)
     on conflict (email) do update set "passwordHash"=excluded."passwordHash", "walletAddress"=null, "isVerified"=true`,
    [randomUUID(), email, hash],
  );
  return password;
}

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const mode = process.argv[2] ?? "provision";

  if (mode === "provision") {
    const pwQa = await provision(db, "qa-d2-f4@centient.work");
    console.log(`F4 for QA: qa-d2-f4@centient.work / ${pwQa}`);
  }

  if (mode === "validate") {
    // Developer validation on a separate F4 so QA's fixture stays unused.
    const email = "qa-d2-f4-devcheck@centient.work";
    const password = await provision(db, email);
    const A = key("tc038-devcheck-A");
    const steps: any[] = [];

    const wallet = await signIn(A); // creates the unused wallet-only account bound to A
    steps.push({ step: "setup: wallet sign-in with A creates a wallet-only account", address: A.publicKey(), walletOnlyUserId: wallet.userId });
    await call("POST", "/api/auth/logout", { cookie: wallet.cookie });

    const login = await call("POST", "/api/auth/login", { json: { email, password } });
    const cookie = (login.headers["set-cookie"] ?? "").split(";")[0];
    const before = await call("GET", "/api/auth/me", { cookie });
    steps.push({ step: "preflight: F4 identity before (wallet must be null)", status: before.status, me: before.body });

    const ch = await call("GET", `/api/me/wallet?address=${A.publicKey()}`, { cookie });
    const claim = await call("POST", "/api/me/wallet", { cookie, json: { stellarAddress: A.publicKey(), signature: sep53(A, ch.body.message) } });
    steps.push({ step: "1: claim A via POST /api/me/wallet", status: claim.status, body: claim.body });

    const after = await call("GET", "/api/auth/me", { cookie });
    const rows = await db.query(`select id, email is not null as has_email, "walletAddress" from users where "walletAddress"=$1 or id=$2`, [A.publicKey(), wallet.userId]);
    steps.push({ step: "check: identity after", me: after.body, usersHoldingA: rows.rows });

    // Case sensitivity: a lowercased A is refused, never normalized.
    const lower = await call("GET", `/api/me/wallet?address=${A.publicKey().toLowerCase()}`, { cookie });
    steps.push({ step: "check: lowercased address refused", status: lower.status, body: lower.body });

    evidence("038", "E038-2-devcheck-takeover.json", { fixtureEmail: email, address: short(A.publicKey()), steps });
    console.log(JSON.stringify(steps, null, 1).slice(0, 3000));
  }
  await db.end();
})();
