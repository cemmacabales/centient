import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";

import { POST } from "@/app/api/auth/wallet/verify/route";
import { issueSignInChallenge } from "@/lib/stellar/auth-challenge";
import { sep53Digest } from "@/lib/stellar/signature";
import { signLabelerJWT, verifyLabelerJWT } from "@/lib/labeler-auth";
import { prisma, truncateAll } from "@/tests/helpers/db";

// Real database throughout: the concurrent replay case below is the property
// that only the database can decide.

const ORIGINAL_NETWORK = process.env.STELLAR_NETWORK;

beforeEach(async () => {
  process.env.STELLAR_NETWORK = "testnet";
  await truncateAll();
});

afterEach(() => {
  if (ORIGINAL_NETWORK === undefined) delete process.env.STELLAR_NETWORK;
  else process.env.STELLAR_NETWORK = ORIGINAL_NETWORK;
});

const sign = (kp: Keypair, message: string) => kp.sign(sep53Digest(message)).toString("base64");

/** Build a verification request, optionally carrying an existing session. */
function makeReq(body: unknown, cookie?: string): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new NextRequest("http://localhost/api/auth/wallet/verify", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Return only the labeler-session cookies emitted by a route response. */
function sessionCookies(res: Response): string[] {
  return res.headers.getSetCookie().filter((c) => c.startsWith("labeler_session="));
}

/** Decode the contributor id from the response's labeler-session cookie. */
async function sessionUserId(res: Response): Promise<string | undefined> {
  const [cookie] = sessionCookies(res);
  if (!cookie) return undefined;
  const token = cookie.split(";")[0].split("=")[1];
  return (await verifyLabelerJWT(token))?.sub;
}

/** A contributor keypair with a freshly issued challenge and a valid proof for it. */
async function validProof(kp = Keypair.random()) {
  const challenge = await issueSignInChallenge(kp.publicKey());
  return {
    kp,
    challenge,
    body: {
      address: kp.publicKey(),
      nonce: challenge.nonce,
      signature: sign(kp, challenge.message),
      signerAddress: kp.publicKey(),
    },
  };
}

describe("POST /api/auth/wallet/verify — success", () => {
  it("issues exactly one wallet-keyed session and creates the contributor", async () => {
    const { body } = await validProof();

    const res = await POST(makeReq(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    const user = await prisma.user.findUniqueOrThrow({ where: { walletAddress: body.address } });
    expect(json).toEqual({ success: true, userId: user.id, walletAddress: body.address, created: true });

    expect(sessionCookies(res)).toHaveLength(1);
    expect(sessionCookies(res)[0]).toMatch(/HttpOnly/);
    expect(await sessionUserId(res)).toBe(user.id);
    expect(await prisma.user.count({ where: { walletAddress: body.address } })).toBe(1);
  });

  it("signs a returning wallet contributor in as itself", async () => {
    const kp = Keypair.random();
    const existing = await prisma.user.create({ data: { walletAddress: kp.publicKey() } });
    const { body } = await validProof(kp);

    const res = await POST(makeReq(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: existing.id, created: false });
    expect(await sessionUserId(res)).toBe(existing.id);
  });

  it("signs an email account that linked the address in as that account", async () => {
    const kp = Keypair.random();
    const emailUser = await prisma.user.create({
      data: { email: "linked@example.com", passwordHash: "x", isVerified: true, walletAddress: kp.publicKey() },
    });
    const { body } = await validProof(kp);

    const res = await POST(makeReq(body));

    expect(await res.json()).toMatchObject({ userId: emailUser.id, created: false });
    expect(await sessionUserId(res)).toBe(emailUser.id);
  });

  it("replaces an existing session with the proven address's contributor", async () => {
    const other = await prisma.user.create({ data: { email: "other@example.com" } });
    const { body } = await validProof();

    const res = await POST(makeReq(body, `labeler_session=${await signLabelerJWT(other.id)}`));

    expect(res.status).toBe(200);
    const { userId } = await res.json();
    expect(userId).not.toBe(other.id);
    expect(await sessionUserId(res)).toBe(userId);
  });

  it("accepts a proof without signerAddress", async () => {
    const { body } = await validProof();
    const withoutSigner = { address: body.address, nonce: body.nonce, signature: body.signature };

    const res = await POST(makeReq(withoutSigner));

    expect(res.status).toBe(200);
  });
});

describe("POST /api/auth/wallet/verify — rejections", () => {
  async function expectRejected(res: Response, status: number, error: string) {
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
    expect(sessionCookies(res)).toHaveLength(0);
  }

  it("401 challenge_not_found on a replay of an accepted proof", async () => {
    const { body } = await validProof();
    expect((await POST(makeReq(body))).status).toBe(200);

    await expectRejected(await POST(makeReq(body)), 401, "challenge_not_found");
  });

  it("gives exactly one session when the same proof arrives twice at once", async () => {
    const { body } = await validProof();

    const results = await Promise.all([POST(makeReq(body)), POST(makeReq(body))]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    const rejected = results.find((r) => r.status === 401)!;
    expect(await rejected.json()).toEqual({ error: "challenge_not_found" });
    expect(results.flatMap((r) => sessionCookies(r))).toHaveLength(1);
    expect(await prisma.user.count({ where: { walletAddress: body.address } })).toBe(1);
  });

  it("401 challenge_not_found for an unknown nonce", async () => {
    const { body } = await validProof();
    await expectRejected(await POST(makeReq({ ...body, nonce: "f".repeat(32) })), 401, "challenge_not_found");
  });

  it("401 challenge_expired for a challenge past its expiry", async () => {
    const { body, challenge } = await validProof();
    await prisma.walletNonce.update({
      where: { nonce: challenge.nonce },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expectRejected(await POST(makeReq(body)), 401, "challenge_expired");
  });

  it("401 wrong_address for a challenge issued to another address", async () => {
    const { challenge } = await validProof();
    const other = Keypair.random();

    const res = await POST(
      makeReq({ address: other.publicKey(), nonce: challenge.nonce, signature: sign(other, challenge.message) }),
    );

    await expectRejected(res, 401, "wrong_address");
  });

  it("401 wrong_network for a challenge issued on the other network", async () => {
    const { body } = await validProof();
    process.env.STELLAR_NETWORK = "public";

    await expectRejected(await POST(makeReq(body)), 401, "wrong_network");
  });

  it("401 wrong_signer when the wallet reports a different signer", async () => {
    const { body } = await validProof();
    await expectRejected(
      await POST(makeReq({ ...body, signerAddress: Keypair.random().publicKey() })),
      401,
      "wrong_signer",
    );
  });

  it.each([
    ["by a different key", (_kp: Keypair, message: string) => sign(Keypair.random(), message)],
    ["over the raw message", (kp: Keypair, message: string) => kp.sign(Buffer.from(message, "utf8")).toString("base64")],
    ["truncated", (kp: Keypair, message: string) => Buffer.from(sign(kp, message), "base64").subarray(0, 63).toString("base64")],
    ["that is not base64", () => "not a signature!!"],
  ])("401 bad_signature for a signature %s, leaving the challenge for the real signer", async (_name, forge) => {
    const { kp, challenge, body } = await validProof();

    await expectRejected(
      await POST(makeReq({ ...body, signature: forge(kp, challenge.message) })),
      401,
      "bad_signature",
    );
    expect(await prisma.walletNonce.count({ where: { nonce: challenge.nonce } })).toBe(1);
  });

  it("does not let a stranger's bad proof fail the contributor's sign-in (PR #105 review)", async () => {
    const { body } = await validProof();
    // Anyone can ask for the address's challenge and gets the same live nonce.
    const stranger = await issueSignInChallenge(body.address);
    expect(stranger.nonce).toBe(body.nonce);

    await expectRejected(
      await POST(makeReq({ ...body, signature: sign(Keypair.random(), stranger.message) })),
      401,
      "bad_signature",
    );

    const res = await POST(makeReq(body));
    expect(res.status).toBe(200);
    expect(sessionCookies(res)).toHaveLength(1);
  });

  it("400 invalid_address for a lowercased address, without consuming the challenge", async () => {
    const { body, challenge } = await validProof();

    await expectRejected(
      await POST(makeReq({ ...body, address: body.address.toLowerCase() })),
      400,
      "invalid_address",
    );
    expect(await prisma.walletNonce.count({ where: { nonce: challenge.nonce } })).toBe(1);
  });

  it.each([
    ["a non-JSON body", () => "not json"],
    ["a missing nonce", (b: Record<string, unknown>) => ({ ...b, nonce: undefined })],
    ["an empty nonce", (b: Record<string, unknown>) => ({ ...b, nonce: "" })],
    ["a missing signature", (b: Record<string, unknown>) => ({ ...b, signature: undefined })],
    ["a non-string signature", (b: Record<string, unknown>) => ({ ...b, signature: 123 })],
    ["a non-string signerAddress", (b: Record<string, unknown>) => ({ ...b, signerAddress: 7 })],
  ])("400 invalid_body for %s, without consuming the challenge", async (_name, mutate) => {
    const { body, challenge } = await validProof();

    await expectRejected(await POST(makeReq(mutate(body))), 400, "invalid_body");
    expect(await prisma.walletNonce.count({ where: { nonce: challenge.nonce } })).toBe(1);
  });
});

// #36: a banned identity is refused at the door, not only at submit. The admin
// flagged-withdrawal ban writes EMAIL, WALLET and USER_ID rows; any one of them
// matching the proven address's contributor refuses the session.
describe("POST /api/auth/wallet/verify — banned identity", () => {
  async function bannedContributor(identifierType: "WALLET" | "USER_ID" | "EMAIL") {
    const kp = Keypair.random();
    const user = await prisma.user.create({
      data: { email: "banned@example.com", passwordHash: "x", isVerified: true, walletAddress: kp.publicKey() },
    });
    const identifierValue = { WALLET: kp.publicKey(), USER_ID: user.id, EMAIL: "banned@example.com" }[identifierType];
    await prisma.bannedIdentity.create({ data: { identifierType, identifierValue, reason: "test ban" } });
    return kp;
  }

  it.each(["WALLET", "USER_ID", "EMAIL"] as const)("403 banned for a banned %s, with no session", async (type) => {
    const { body } = await validProof(await bannedContributor(type));

    const res = await POST(makeReq(body));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "banned" });
    expect(sessionCookies(res)).toHaveLength(0);
  });

  it("signs in once the identity ban has expired", async () => {
    const kp = Keypair.random();
    await prisma.bannedIdentity.create({
      data: { identifierType: "WALLET", identifierValue: kp.publicKey(), bannedUntil: new Date(Date.now() - 1000) },
    });
    const { body } = await validProof(kp);

    const res = await POST(makeReq(body));

    expect(res.status).toBe(200);
  });
});
