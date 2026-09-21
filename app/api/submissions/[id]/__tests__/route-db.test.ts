// #37 — the per-submission payout status is a truthful, session-keyed read.
//
// It used to demand `?walletAddress=0x…` and compare it case-insensitively, so
// every Stellar contributor got 400. It now reads only the session.
import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import { GET } from "../route";
import { signLabelerJWT } from "@/lib/labeler-auth";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser, createTask, VALID_REASON } from "@/tests/helpers/factories";

beforeEach(async () => {
  await truncateAll();
});

async function read(id: string, userId?: string, query = "") {
  const headers: Record<string, string> = {};
  if (userId) headers.cookie = `labeler_session=${await signLabelerJWT(userId)}`;
  return GET(new NextRequest(`http://localhost/api/submissions/${id}${query}`, { headers }), {
    params: Promise.resolve({ id }),
  });
}

async function stellarSubmission() {
  const user = await createUser({ walletAddress: Keypair.random().publicKey() });
  const task = await createTask();
  const submission = await prisma.submission.create({
    data: {
      userId: user.id,
      walletAddress: user.walletAddress,
      taskId: task.id,
      choice: "A",
      reason: VALID_REASON,
      payoutAmountUnits: 2_500_000n,
      payoutStatus: "pending",
    },
  });
  return { user, submission };
}

describe("GET /api/submissions/[id] (#37)", () => {
  it("refuses a request with no session", async () => {
    const { submission } = await stellarSubmission();
    expect((await read(submission.id)).status).toBe(401);
  });

  it("reads a Stellar contributor's own submission with no wallet parameter", async () => {
    const { user, submission } = await stellarSubmission();
    const res = await read(submission.id, user.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: submission.id,
      payoutStatus: "pending",
      payoutTxHash: null,
      payoutAmount: "0.25",
      walletAddress: user.walletAddress,
    });
  });

  it("reports the payout as it moves from pending to sent to confirmed", async () => {
    const { user, submission } = await stellarSubmission();
    for (const payoutStatus of ["sent", "confirmed"] as const) {
      await prisma.submission.update({
        where: { id: submission.id },
        data: { payoutStatus, payoutTxHash: "a".repeat(64) },
      });
      const body = await (await read(submission.id, user.id)).json();
      expect(body.payoutStatus).toBe(payoutStatus);
      expect(body.payoutTxHash).toBe("a".repeat(64));
    }
  });

  it("answers 404 for another contributor's submission, as for one that does not exist", async () => {
    const { submission } = await stellarSubmission();
    const other = await createUser({ walletAddress: Keypair.random().publicKey() });
    const res = await read(submission.id, other.id);
    expect(res.status).toBe(404);
    expect((await read("00000000-0000-0000-0000-000000000000", other.id)).status).toBe(404);
  });

  it("ignores a wallet parameter naming someone else", async () => {
    const { submission } = await stellarSubmission();
    const other = await createUser({ walletAddress: Keypair.random().publicKey() });
    const res = await read(submission.id, other.id, `?walletAddress=${submission.walletAddress}`);
    expect(res.status).toBe(404);
  });
});
