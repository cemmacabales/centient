// TC-029: a submit that times out at Horizon answers 202 pending until the envelope expires.
// Developer-prepared Horizon-timeout class: the deployed route code (this worktree = deployed SHA) runs in-process
// against the staging DB, with STELLAR_HORIZON_URL pointed at a local TLS proxy that forwards every Horizon call to
// horizon-testnet except POST /transactions, which gets Horizon's own 504 timeout problem while `faulted` is true.
import https from "node:https";
import { readFileSync } from "node:fs";
import { Client } from "pg";

let faulted = true;
const proxyLog: any[] = [];
const TIMEOUT_PROBLEM = {
  type: "https://stellar.org/horizon-errors/timeout",
  title: "Timeout",
  status: 504,
  detail: "Your request timed out before completing. Please try your request again.",
};

(async () => {
  const dir = process.env.CERT_DIR!;
  const server = https.createServer({ key: readFileSync(dir + "/key.pem"), cert: readFileSync(dir + "/cert.pem") }, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    if (faulted && req.method === "POST" && req.url?.startsWith("/transactions")) {
      proxyLog.push({ at: new Date().toISOString(), method: req.method, url: req.url, answered: "504 timeout (injected)" });
      res.writeHead(504, { "content-type": "application/problem+json" }).end(JSON.stringify(TIMEOUT_PROBLEM));
      return;
    }
    const up = await fetch("https://horizon-testnet.stellar.org" + req.url, {
      method: req.method,
      headers: { "content-type": req.headers["content-type"] ?? "application/json", accept: req.headers.accept ?? "application/json" },
      body: req.method === "GET" ? undefined : body,
    });
    if (req.method === "POST") proxyLog.push({ at: new Date().toISOString(), method: req.method, url: req.url, answered: `${up.status} (forwarded)` });
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await up.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(8443, "127.0.0.1", r));

  // Import the deployed code only after the env points at the proxy.
  const { NextRequest } = await import("next/server");
  const route = await import("../../app/api/me/wallet/sponsor/route");
  const kit = await import("./kit");
  const { account, evidence, key, short, signIn, signXdr, sleep } = kit;

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const F1 = key("tc029-F1");
  const f = await signIn(F1); // real sign-in on the deployed service
  const req = (method: string, json?: unknown) =>
    new NextRequest("https://centient.work/api/me/wallet/sponsor", {
      method,
      headers: { cookie: f.cookie, ...(json ? { "content-type": "application/json" } : {}) },
      body: json ? JSON.stringify(json) : undefined,
    });
  const answer = async (p: Promise<Response>) => {
    const r = await p;
    return { status: r.status, body: await r.json(), at: new Date().toISOString() };
  };
  const row = async () =>
    (await db.query(`select status, "expiresAt" as "expiresAtUtc", "confirmedAt" from sponsored_trustlines where address=$1 and "revokedAt" is null order by "createdAt" desc limit 1`, [F1.publicKey()])).rows[0] ?? null;

  const out: any = { F1: short(F1.publicKey()), harness: "deployed route code in-process, Horizon submit faulted to 504 timeout", steps: [], polls: [] };
  const g = await answer(route.GET(req("GET")));
  const signed = signXdr(g.body.xdr, F1);
  const p1 = await answer(route.POST(req("POST", { signedXdr: signed })));
  out.steps.push({ step: "1: submit while Horizon times out", expect: "202 pending", got: p1, row: await row(), f1OnChain: (await account(F1.publicKey())) ? "exists" : "404" });

  const expiresAt = new Date((await row()).expiresAtUtc + "Z");
  while (Date.now() < expiresAt.getTime() + 5_000) {
    await sleep(30_000);
    // Re-check the boundary AFTER the sleep: the loop condition was evaluated up
    // to 30s ago, so a poll can land past expiry and must not be counted as one
    // taken during the window.
    const withinWindow = Date.now() < expiresAt.getTime();
    const poll = await answer(route.POST(req("POST", { signedXdr: signed })));
    const build = await answer(route.GET(req("GET")));
    out.polls.push({
      at: poll.at,
      withinWindow,
      resubmitSameEnvelope: `${poll.status} ${JSON.stringify(poll.body)}`,
      buildAnother: `${build.status} ${JSON.stringify(build.body.xdr ? { needed: true, xdr: "<offered>" } : build.body)}`,
      row: (await row())?.status,
      f1OnChain: (await account(F1.publicKey())) ? "exists" : "404 (no partial account)",
    });
    console.log(out.polls[out.polls.length - 1]);
  }
  out.steps.push({
    step: "2: poll until envelope expiry",
    envelopeExpiresAtUtc: expiresAt.toISOString(),
    pollsDuringWindow: out.polls.filter((p: any) => p.withinWindow).length,
    pollsAfterExpiry: out.polls.filter((p: any) => !p.withinWindow).length,
  });

  faulted = false; // Horizon recovers
  const after = await answer(route.POST(req("POST", { signedXdr: signed })));
  out.steps.push({ step: "after expiry, Horizon answering again: resubmit the expired envelope", got: after, row: await row(), f1OnChain: (await account(F1.publicKey())) ? "exists" : "404 (no partial account)" });
  out.proxyLog = proxyLog;
  evidence("029", "E029-1-horizon-timeout-202.json", out);
  console.log(JSON.stringify(out.steps, null, 1));
  await db.end();
  server.close();
  process.exit(0);
})();
