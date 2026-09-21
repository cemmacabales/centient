// D2 QA unblock kit — shared helpers. Throwaway testnet keys only.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { Horizon, Keypair, Networks, TransactionBuilder, Operation, Asset, BASE_FEE } from "@stellar/stellar-sdk";

export const BASE = process.env.QA_BASE ?? "https://centient.work";
export const HORIZON = "https://horizon-testnet.stellar.org";
/**
 * Per-request deadline for `call`. Override with QA_TIMEOUT_MS.
 * Validated up front: `??` does not catch an empty string, so QA_TIMEOUT_MS=""
 * would become 0 and abort every request instantly, and a non-numeric or
 * negative value would throw from AbortSignal.timeout at the first call --
 * mid-run, after fixtures are already planted.
 */
const configuredTimeout = process.env.QA_TIMEOUT_MS === undefined ? 30_000 : Number(process.env.QA_TIMEOUT_MS);
if (!Number.isFinite(configuredTimeout) || configuredTimeout <= 0) {
  throw new Error(`QA_TIMEOUT_MS must be a finite positive number of milliseconds, got ${JSON.stringify(process.env.QA_TIMEOUT_MS)}`);
}
export const TIMEOUT_MS = configuredTimeout;
export const horizon = new Horizon.Server(HORIZON);
export const EVID = require("node:path").resolve(__dirname, "../evidence") + "/";
// Deliberately OUTSIDE D2-QA-UNBLOCK: these are throwaway testnet keypairs, but a
// keystore inside a committed tree is one `git add -A` away from being published.
const KEYS = require("node:path").resolve(__dirname, "../../keys.json");

/** Named fixture keypairs, persisted in the scratchpad (never in evidence). */
export function key(name: string): Keypair {
  const all: Record<string, string> = existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, "utf8")) : {};
  if (!all[name]) {
    all[name] = Keypair.random().secret();
    writeFileSync(KEYS, JSON.stringify(all, null, 2));
  }
  return Keypair.fromSecret(all[name]);
}

export function short(a: string) {
  return `${a.slice(0, 7)}…${a.slice(-4)}`;
}

/** Redact G-addresses / hex nonces are fine; strip cookies and any S… seeds. */
function redact(s: string) {
  return s.replace(/S[A-Z2-7]{55}/g, "S…REDACTED").replace(/labeler_session=[^;"\s]+/g, "labeler_session=REDACTED");
}

export function evidence(tc: string, file: string, body: unknown) {
  const dir = `${EVID}${tc}/`;
  mkdirSync(dir, { recursive: true });
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  writeFileSync(dir + file, redact(text) + "\n");
  console.log(`  [evidence] ${tc}/${file}`);
}

export type Res = { status: number; body: any; headers: Record<string, string>; at: string };

export async function call(method: string, path: string, opts: { cookie?: string; json?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  const at = new Date().toISOString();
  const r = await fetch(BASE + path, {
    method,
    // Without a deadline a stalled staging response keeps the await pending
    // forever, and a case that plants fixture rows never reaches its cleanup.
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      ...(opts.json !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
    redirect: "manual",
  });
  const text = await r.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    if (["retry-after", "set-cookie"].includes(k)) headers[k] = v;
  });
  return { status: r.status, body, headers, at };
}

/** SEP-53: ed25519(SHA256("Stellar Signed Message:\n" + message)), base64. */
export function sep53(kp: Keypair, message: string): string {
  const digest = createHash("sha256").update(Buffer.concat([Buffer.from("Stellar Signed Message:\n"), Buffer.from(message)])).digest();
  return kp.sign(digest).toString("base64");
}

/** Wallet sign-in through the deployed challenge/verify routes. Returns the session cookie. */
export async function signIn(kp: Keypair): Promise<{ cookie: string; userId: string }> {
  let c = await call("POST", "/api/auth/wallet/challenge", { json: { address: kp.publicKey() } });
  for (let i = 0; c.status === 429 && i < 4; i++) {
    await sleep(20_000);
    c = await call("POST", "/api/auth/wallet/challenge", { json: { address: kp.publicKey() } });
  }
  if (c.status !== 200) throw new Error(`challenge ${c.status} ${JSON.stringify(c.body)}`);
  const v = await call("POST", "/api/auth/wallet/verify", {
    json: { address: kp.publicKey(), nonce: c.body.nonce, signature: sep53(kp, c.body.message) },
  });
  if (v.status !== 200) throw new Error(`verify ${v.status} ${JSON.stringify(v.body)}`);
  const cookie = (v.headers["set-cookie"] ?? "").split(";")[0];
  const me = await call("GET", "/api/auth/me", { cookie });
  if (me.status !== 200 || typeof me.body?.userId !== "string") {
    throw new Error(`me ${me.status} ${JSON.stringify(me.body)}`);
  }
  return { cookie, userId: me.body.userId };
}

export function signXdr(xdr: string, kp: Keypair): string {
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
  tx.sign(kp);
  return tx.toXDR();
}

export async function friendbot(pub: string) {
  const r = await fetch(`https://friendbot.stellar.org/?addr=${pub}`);
  if (!r.ok) throw new Error(`friendbot ${r.status}`);
}

export async function account(pub: string) {
  try {
    return await horizon.loadAccount(pub);
  } catch (e: any) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
}

export async function submitOps(src: Keypair, ops: any[], signers: Keypair[] = []) {
  const acct = await horizon.loadAccount(src.publicKey());
  const b = new TransactionBuilder(acct, { fee: String(Number(BASE_FEE) * 10), networkPassphrase: Networks.TESTNET }).setTimeout(60);
  ops.forEach((o) => b.addOperation(o));
  const tx = b.build();
  tx.sign(src, ...signers);
  return horizon.submitTransaction(tx);
}

export const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
export { Operation, Keypair, Asset };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
