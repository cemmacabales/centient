import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import bcrypt from "bcryptjs";

// #30 — first connect end to end, through the real routes and the real ledger.
// Only Horizon is faked (the `@/lib/stellar/client` network calls), and the
// rate limiter, whose 15-second buckets would otherwise refuse a returning
// wallet's second read. Every identity, session, bind and sponsorship decision
// below is made by the routes against the database.

const { hasTrustline, buildTx, prepare, submit, txStatus } = vi.hoisted(() => ({
  hasTrustline: vi.fn(),
  buildTx: vi.fn(),
  prepare: vi.fn(),
  submit: vi.fn(),
  txStatus: vi.fn(),
}));

vi.mock("@/lib/stellar/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar/client")>();
  return {
    ...actual,
    accountHasUsdcTrustline: hasTrustline,
    buildSponsoredTrustlineTx: buildTx,
    prepareSponsoredTrustline: prepare,
    getTxStatus: txStatus,
  };
});
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, checkWalletRateLimit: vi.fn(async () => false) };
});
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { POST as challenge } from "@/app/api/auth/wallet/challenge/route";
import { POST as verify } from "@/app/api/auth/wallet/verify/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as me } from "@/app/api/auth/me/route";
import { GET as linkChallenge, POST as bindWallet } from "@/app/api/me/wallet/route";
import { GET as sponsorOffer, POST as sponsorSubmit } from "@/app/api/me/wallet/sponsor/route";
import { GET as withdrawSummary } from "@/app/api/me/withdraw/route";
import { GET as nextTask } from "@/app/api/task/route";
import { StellarPaymentError } from "@/lib/stellar/client";
import { sep53Digest } from "@/lib/stellar/signature";
import { prisma, truncateAll } from "@/tests/helpers/db";

const ORIGINAL_NETWORK = process.env.STELLAR_NETWORK;
const ORIGINAL_MIN_WITHDRAWAL = process.env.MIN_WITHDRAWAL_UNITS;

/** Restore one environment variable to what it was before the suite touched it. */
function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(async () => {
  process.env.STELLAR_NETWORK = "testnet";
  process.env.MIN_WITHDRAWAL_UNITS = "1000000"; // read by the withdrawal summary
  await truncateAll();
  vi.clearAllMocks();
  hasTrustline.mockResolvedValue(false);
  buildTx.mockResolvedValue({ xdr: "XDR", kind: "account+trustline" });
  // The envelope hash follows what the contributor signed, as it does on-chain.
  prepare.mockImplementation((signedXdr: string) => ({
    hash: `hash-${signedXdr}`,
    kind: "account+trustline",
    expiresAt: new Date(Date.now() + 180_000),
    submit,
  }));
  submit.mockImplementation(async () => ({ hash: "inner", feeBumpHash: "bump" }));
  txStatus.mockResolvedValue("not_found");
});

afterEach(() => {
  restoreEnv("STELLAR_NETWORK", ORIGINAL_NETWORK);
  restoreEnv("MIN_WITHDRAWAL_UNITS", ORIGINAL_MIN_WITHDRAWAL);
});

/** A request to `path`, with a JSON body and the session cookie when given. */
function req(path: string, opts: { method?: string; body?: unknown; cookie?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.ip) headers["x-real-ip"] = opts.ip;
  return new NextRequest(`http://localhost${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

/** The `labeler_session=<token>` pair a response set. */
function sessionCookie(res: Response): string {
  const set = res.headers.getSetCookie().find((c) => c.startsWith("labeler_session="));
  if (!set) throw new Error("test: response set no session cookie");
  return set.split(";")[0];
}

const sign = (kp: Keypair, message: string) => kp.sign(sep53Digest(message)).toString("base64");

/** Freighter sign-in as the browser runs it: challenge, sign, verify. */
async function signInWithWallet(kp: Keypair) {
  const address = kp.publicKey();
  const issued = await (await challenge(req("/api/auth/wallet/challenge", { method: "POST", body: { address } }))).json();
  const res = await verify(
    req("/api/auth/wallet/verify", {
      method: "POST",
      body: { address, nonce: issued.nonce, signature: sign(kp, issued.message), signerAddress: address },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { userId: string; walletAddress: string; created: boolean };
  return { ...body, cookie: sessionCookie(res) };
}

/** Payout setup as the browser runs it: read the offer, and co-sign and submit it when needed. */
async function setUpPayouts(cookie: string, signedXdr = "signed-1") {
  const offerRes = await sponsorOffer(req("/api/me/wallet/sponsor", { cookie }));
  const offer = await offerRes.json();
  if (offerRes.status !== 200 || offer.needed === false) return { offerRes, offer };
  const submitRes = await sponsorSubmit(req("/api/me/wallet/sponsor", { method: "POST", body: { signedXdr }, cookie }));
  return { offerRes, offer, submitRes, submitted: await submitRes.json() };
}

/** Sponsorship rows for `address` that still count: not failed, not revoked. */
const liveRows = (address: string) =>
  prisma.sponsoredTrustline.findMany({ where: { address, status: { not: "failed" }, revokedAt: null } });

describe("first connect — a wallet contributor", () => {
  it("reaches payout-ready as a new account whose proven address is its payout destination", async () => {
    const kp = Keypair.random();
    const address = kp.publicKey();

    const session = await signInWithWallet(kp);
    expect(session).toMatchObject({ walletAddress: address, created: true });
    expect(await (await me(req("/api/auth/me", { cookie: session.cookie }))).json()).toMatchObject({
      authenticated: true,
      userId: session.userId,
      wallet: address,
    });

    const setup = await setUpPayouts(session.cookie);
    expect(setup.offer).toEqual({ needed: true, address, xdr: "XDR", kind: "account+trustline" });
    expect(setup.submitRes?.status).toBe(200);
    expect(setup.submitted).toEqual({ established: true });
    expect(prepare).toHaveBeenCalledWith("signed-1", address);

    const rows = await liveRows(address);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: session.userId, status: "confirmed" });

    const summary = await (await withdrawSummary(req("/api/me/withdraw", { cookie: session.cookie }))).json();
    expect(summary.destinationAddress).toBe(address);
  });

  it("returns as the same account and passes payout setup with no second sponsorship", async () => {
    const kp = Keypair.random();
    const first = await signInWithWallet(kp);
    await setUpPayouts(first.cookie);
    hasTrustline.mockResolvedValue(true); // the sponsored trustline now exists on-chain

    const again = await signInWithWallet(kp);

    expect(again).toMatchObject({ userId: first.userId, walletAddress: kp.publicKey(), created: false });
    expect(await prisma.user.count()).toBe(1);
    const setup = await setUpPayouts(again.cookie);
    expect(setup.offer).toEqual({ needed: false, address: kp.publicKey() });
    expect(buildTx).toHaveBeenCalledTimes(1);
    expect(await liveRows(kp.publicKey())).toHaveLength(1);
  });

  it("resumes a submit whose outcome was unknown without a second sponsorship", async () => {
    const kp = Keypair.random();
    const session = await signInWithWallet(kp);
    submit.mockRejectedValueOnce(new StellarPaymentError("timeout", "submission_unknown", false));

    const interrupted = await setUpPayouts(session.cookie);
    expect(interrupted.submitRes?.status).toBe(202);
    expect(await liveRows(kp.publicKey())).toMatchObject([{ status: "pending" }]);

    // A reload while it is still unknown: no new envelope is offered.
    const reloaded = await sponsorOffer(req("/api/me/wallet/sponsor", { cookie: session.cookie }));
    expect(reloaded.status).toBe(409);
    expect(await reloaded.json()).toEqual({ error: "submission_pending" });

    // Try again with the same signed envelope: it settles on the same row.
    const retried = await sponsorSubmit(
      req("/api/me/wallet/sponsor", { method: "POST", body: { signedXdr: "signed-1" }, cookie: session.cookie }),
    );
    expect(retried.status).toBe(200);
    const rows = await liveRows(kp.publicKey());
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("confirmed");
    expect(await prisma.sponsoredTrustline.count()).toBe(1);
  });

  it("releases an envelope that provably cannot land, and settles the rebuilt one on a single live row", async () => {
    const kp = Keypair.random();
    const session = await signInWithWallet(kp);
    submit.mockRejectedValueOnce(new StellarPaymentError("stale", "tx_bad_seq", true));

    const stale = await setUpPayouts(session.cookie, "signed-1");
    expect(stale.submitRes?.status).toBe(409);
    expect(stale.submitted).toEqual({ error: "retry" });
    expect(await liveRows(kp.publicKey())).toHaveLength(0);

    const rebuilt = await setUpPayouts(session.cookie, "signed-2");
    expect(rebuilt.submitRes?.status).toBe(200);
    const rows = await liveRows(kp.publicKey());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ txHash: "hash-signed-2", status: "confirmed" });
  });

  it("logs out by clearing the session, after which the app treats the browser as signed out", async () => {
    const session = await signInWithWallet(Keypair.random());

    const res = await logout(req("/api/auth/logout", { method: "POST", cookie: session.cookie }));

    const cleared = res.headers.getSetCookie().find((c) => c.startsWith("labeler_session="));
    expect(cleared).toMatch(/^labeler_session=;/);
    expect(cleared).toMatch(/Max-Age=0/i);
    const after = sessionCookie(res);
    expect(await (await me(req("/api/auth/me", { cookie: after }))).json()).toEqual({ authenticated: false });
    expect((await sponsorOffer(req("/api/me/wallet/sponsor", { cookie: after }))).status).toBe(401);
  });
});

describe("first connect — an account created by email", () => {
  const PASSWORD = "Password1!";

  /** A verified email account with a balance and no wallet, as staging holds today. */
  async function emailAccount(email: string) {
    return prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        isVerified: true,
        pendingBalanceUnits: 7_000_000n,
      },
    });
  }

  async function signInWithEmail(email: string, ip: string) {
    const res = await login(req("/api/auth/login", { method: "POST", body: { email, password: PASSWORD }, ip }));
    expect(res.status).toBe(200);
    return sessionCookie(res);
  }

  /** The claim as the browser runs it: link challenge, sign, bind. */
  async function claim(kp: Keypair, cookie: string) {
    const address = kp.publicKey();
    const issued = await (
      await linkChallenge(req(`/api/me/wallet?address=${encodeURIComponent(address)}`, { cookie }))
    ).json();
    return bindWallet(
      req("/api/me/wallet", { method: "POST", body: { stellarAddress: address, signature: sign(kp, issued.message) }, cookie }),
    );
  }

  it("claims a wallet, keeps its balance, sets up payouts, and then signs in with that wallet", async () => {
    const account = await emailAccount("legacy@example.com");
    const cookie = await signInWithEmail("legacy@example.com", "198.51.100.1");
    expect(await (await me(req("/api/auth/me", { cookie }))).json()).toMatchObject({ wallet: null });
    const refused = await nextTask(req("/api/task", { cookie }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "wallet_required" });

    const kp = Keypair.random();
    const bound = await claim(kp, cookie);
    expect(bound.status).toBe(200);

    const setup = await setUpPayouts(cookie);
    expect(setup.submitRes?.status).toBe(200);
    expect(await liveRows(kp.publicKey())).toMatchObject([{ userId: account.id, status: "confirmed" }]);

    const walletSession = await signInWithWallet(kp);
    expect(walletSession).toMatchObject({ userId: account.id, created: false });
    expect(await prisma.user.count()).toBe(1);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: account.id } });
    expect(after).toMatchObject({ walletAddress: kp.publicKey(), pendingBalanceUnits: 7_000_000n });
  });

  it("takes back its wallet from the empty account an accidental wallet sign-in created (PR #105 review)", async () => {
    const account = await emailAccount("pressed-freighter-first@example.com");
    const kp = Keypair.random();
    const accidental = await signInWithWallet(kp);
    expect(accidental).toMatchObject({ created: true });
    const cookie = await signInWithEmail("pressed-freighter-first@example.com", "198.51.100.3");

    expect((await claim(kp, cookie)).status).toBe(200);

    expect(await prisma.user.findUnique({ where: { id: accidental.userId } })).toBeNull();
    const walletSession = await signInWithWallet(kp);
    expect(walletSession).toMatchObject({ userId: account.id, created: false });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({
      walletAddress: kp.publicKey(),
      pendingBalanceUnits: 7_000_000n,
    });
  });

  it("cannot take a wallet another account holds, or move to a second wallet once bound", async () => {
    const walletOwner = Keypair.random();
    const owner = await signInWithWallet(walletOwner);
    // An account with activity is never taken over, even by a verified proof.
    await prisma.user.update({ where: { id: owner.userId }, data: { pendingBalanceUnits: 1n } });
    await emailAccount("second@example.com");
    const cookie = await signInWithEmail("second@example.com", "198.51.100.2");

    const taken = await claim(walletOwner, cookie);
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "address_already_linked" });

    const own = Keypair.random();
    expect((await claim(own, cookie)).status).toBe(200);
    const moved = await claim(Keypair.random(), cookie);
    expect(moved.status).toBe(409);
    expect(await moved.json()).toEqual({ error: "wallet_already_bound" });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "second@example.com" } });
    expect(user.walletAddress).toBe(own.publicKey());
  });
});
