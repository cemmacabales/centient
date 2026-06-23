import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/labeler-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/labeler-auth")>();
  return { ...actual, getLabelerSession: vi.fn() };
});

import { POST } from "@/app/api/me/withdraw/route";
import { getLabelerSession } from "@/lib/labeler-auth";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser } from "@/tests/helpers/factories";

const ORIGINAL_ENV = { ...process.env };
const MIN = "1000000000000000000"; // 1 token
const SOME_SESSION = "11111111-1111-1111-1111-111111111111";

function makeReq(): NextRequest {
  return new NextRequest("http://localhost/api/me/withdraw", { method: "POST" });
}

beforeEach(async () => {
  await truncateAll();
  vi.mocked(getLabelerSession).mockReset();
  process.env = { ...ORIGINAL_ENV, MIN_WITHDRAWAL_WEI: MIN };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("POST /api/me/withdraw", () => {
  it("returns 401 when there is no session", async () => {
    vi.mocked(getLabelerSession).mockResolvedValue(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 when the session user no longer exists", async () => {
    vi.mocked(getLabelerSession).mockResolvedValue(SOME_SESSION);
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 403 when the user is banned (frozen balance)", async () => {
    const user = await createUser({ isBanned: true, pendingBalanceWei: 5000000000000000000n });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);
    const res = await POST(makeReq());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "account_frozen" });
  });

  it("returns 400 when the user has no linked wallet", async () => {
    const user = await prisma.user.create({
      data: { walletAddress: null, pendingBalanceWei: 5000000000000000000n },
    });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);
    const res = await POST(makeReq());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no_wallet_linked" });
  });

  it("returns 400 below_minimum when balance is under the threshold", async () => {
    const user = await createUser({ pendingBalanceWei: 500000000000000000n });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);
    const res = await POST(makeReq());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "below_minimum",
      minimumWei: MIN,
      balanceWei: "500000000000000000",
    });
  });

  it("queues a single lump-sum payout and decrements the balance on success", async () => {
    const user = await createUser({ pendingBalanceWei: 5000000000000000000n });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);

    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("queued");
    expect(body.amountWei).toBe("5000000000000000000");
    expect(body.destinationAddress).toBe(user.walletAddress);
    expect(body.withdrawalId).toBeTruthy();

    const jobs = await prisma.payoutJob.findMany({ where: { userId: user.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe("WITHDRAWAL");
    expect(jobs[0].amountWei).toBe(5000000000000000000n);

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.pendingBalanceWei).toBe(0n);

    const ledger = await prisma.userBalanceLedger.findMany({
      where: { userId: user.id, type: "WITHDRAWAL" },
    });
    expect(ledger).toHaveLength(1);
  });

  it("returns 409 when a withdrawal is already in flight", async () => {
    const user = await createUser({ pendingBalanceWei: 5000000000000000000n });
    await prisma.payoutJob.create({
      data: {
        type: "WITHDRAWAL",
        userId: user.id,
        amountWei: 5000000000000000000n,
        destinationAddress: user.walletAddress,
        status: "queued",
      },
    });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);

    const res = await POST(makeReq());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "withdrawal_in_flight" });

    // Balance untouched; still exactly one (the pre-existing) job.
    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.pendingBalanceWei).toBe(5000000000000000000n);
    expect(await prisma.payoutJob.count({ where: { userId: user.id } })).toBe(1);
  });
});
