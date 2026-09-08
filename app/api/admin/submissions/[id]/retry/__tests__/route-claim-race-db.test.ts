import { Keypair } from "@stellar/stellar-sdk";
import { NextRequest } from "next/server";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// The admin retry route against a retry that is already in flight (#12).
//
// `route.test.ts` covers this handler with prisma mocked, which is the right
// shape for its status and rollback branches but cannot see the interaction
// this file exists for: the cron's retry claim and the admin reset are two
// transactions against one row, and only a real database orders them.
//
// `claimForRetry` leases a submission by writing `lastRetriedAt`, and a second
// claimant stands down when it reads a lease younger than the lease window.
// This route resets that column, so the lease it clears may be a live one — the
// exact overlap the lease was added for (#79 review, F1).
//
// Only the Horizon submit is replaced, so every broadcast is counted exactly.
// The claim, the advisory lock, the row lock this route takes, and both control
// flows all run for real.

const { mockSubmitMultisigPayout, mockGetSession, mockRequireRole } = vi.hoisted(() => ({
  mockSubmitMultisigPayout: vi.fn(),
  mockGetSession: vi.fn(),
  mockRequireRole: vi.fn(),
}));

vi.mock("@/lib/stellar/payout-submitter", () => ({
  submitMultisigPayout: mockSubmitMultisigPayout,
}));

vi.mock("@/lib/stellar/payout-cosigner", () => ({
  resolvePayoutCoSigner: vi.fn(() => ({ signPayout: vi.fn() })),
}));

vi.mock("@/lib/stellar/balance", () => ({ checkAndAlert: vi.fn(async () => {}) }));

vi.mock("@/lib/health-alert", () => ({
  sendDedupedDiscordAlert: vi.fn(async () => "sent"),
}));

vi.mock("@/lib/admin-auth", () => ({
  getAdminSession: mockGetSession,
  requireRoleForRoute: mockRequireRole,
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

import { reprocessPayoutWithNonceSafety } from "@/lib/payout-service";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser, createTask, VALID_REASON } from "@/tests/helpers/factories";
import { POST } from "../route";

const AMOUNT_UNITS = 5_000_000n;
const ORIGINAL_ENV = { ...process.env };

let broadcasts: string[] = [];

function makeReq(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/admin/submissions/${id}/retry`, {
    method: "POST",
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  // The cap is not what this case is about; zero disables it.
  process.env.DAILY_PAYOUT_CAP_UNITS = "0";
  broadcasts = [];
  mockGetSession.mockResolvedValue({ email: "ops@centient.test" });
  mockRequireRole.mockResolvedValue(null);
  await truncateAll();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/** A submission a retry may legitimately claim: failed, no hash, lease expired. */
async function createRetryableSubmission() {
  const user = await createUser({ walletAddress: Keypair.random().publicKey() });
  const task = await createTask({ campaignId: null, isGold: false });
  return prisma.submission.create({
    data: {
      walletAddress: user.walletAddress,
      userId: user.id,
      taskId: task.id,
      choice: "A",
      reason: VALID_REASON,
      payoutAmountUnits: AMOUNT_UNITS,
      payoutStatus: "failed",
      retryCount: 1,
      lastRetriedAt: new Date(Date.now() - 10 * 60_000),
    },
  });
}

describe("an admin retry racing a retry already in flight", () => {
  it("broadcasts once when the operator retries mid-broadcast", async () => {
    const submission = await createRetryableSubmission();

    // The cron's retry, held open inside the broadcast so the operator's request
    // lands while the claim is live rather than by hoping a delay was long
    // enough.
    let releaseBroadcast!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseBroadcast = resolve;
    });
    let inFlight!: () => void;
    const broadcasting = new Promise<void>((resolve) => {
      inFlight = resolve;
    });

    // Only the first broadcast is held open. A second one must not block, or a
    // double-pay would surface as a deadlock rather than as the count it is.
    mockSubmitMultisigPayout.mockImplementation(async (request: { reference: { id: string } }) => {
      broadcasts.push(request.reference.id);
      if (broadcasts.length === 1) {
        inFlight();
        await held;
      }
      return { hash: `hash-${broadcasts.length}` };
    });

    const cronRetry = reprocessPayoutWithNonceSafety(submission.id);
    await broadcasting;

    // The operator hits retry while the first broadcast is still open. The row
    // still reads `failed` with no hash — nothing about it says "in flight"
    // except the lease.
    const res = await POST(makeReq(submission.id), {
      params: Promise.resolve({ id: submission.id }),
    } as any);

    releaseBroadcast();
    await cronRetry;

    // One submission, one payment. A second broadcast here is a real double-pay:
    // both attempts are authorized, both reach Horizon, and only one hash is
    // ever recorded.
    expect(broadcasts).toEqual([submission.id]);
    expect(res.status).toBe(409);

    const settled = await prisma.submission.findUnique({
      where: { id: submission.id },
      select: { payoutStatus: true, payoutTxHash: true },
    });
    expect(settled?.payoutStatus).toBe("sent");
    expect(settled?.payoutTxHash).toBe("hash-1");
  });

  it("still retries a submission whose lease has expired", async () => {
    // The refusal must not become a way to strand a payout: once no retry is in
    // flight, the operator's override works exactly as it did before.
    const submission = await createRetryableSubmission();
    mockSubmitMultisigPayout.mockImplementation(async (request: { reference: { id: string } }) => {
      broadcasts.push(request.reference.id);
      return { hash: "manual-hash" };
    });

    const res = await POST(makeReq(submission.id), {
      params: Promise.resolve({ id: submission.id }),
    } as any);

    expect(res.status).toBe(200);
    expect(broadcasts).toEqual([submission.id]);

    const settled = await prisma.submission.findUnique({
      where: { id: submission.id },
      select: { payoutStatus: true, payoutTxHash: true, retryCount: true },
    });
    expect(settled?.payoutStatus).toBe("sent");
    expect(settled?.payoutTxHash).toBe("manual-hash");
  });
});
