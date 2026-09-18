import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/labeler-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/labeler-auth")>();
  return { ...actual, getLabelerSession: vi.fn() };
});

// ST-4b: the withdraw route prechecks the destination's USDC trustline via
// Horizon. Override just that read; default it to "has trustline" so the
// existing happy-path tests stay green.
vi.mock("@/lib/stellar/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar/client")>();
  return { ...actual, accountHasUsdcTrustline: vi.fn() };
});

import { GET, POST } from "@/app/api/me/withdraw/route";
import { getLabelerSession } from "@/lib/labeler-auth";
import { accountHasUsdcTrustline } from "@/lib/stellar/client";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser, makeWallet } from "@/tests/helpers/factories";

const ORIGINAL_ENV = { ...process.env };
const MIN = "1000000000000000000"; // 1 token
const SOME_SESSION = "11111111-1111-1111-1111-111111111111";
// #30: a withdrawal goes to the account's bound wallet, so every user that reaches
// the payout path is created holding a valid Stellar `G…`. The shared
// `makeWallet()` factory still emits `0x…` — it's used here only where a legacy,
// unpayable wallet is wanted.
const G_WALLET = "GCKIPQX2TEZWBQSUPPNMKGJBODL246B374Y52SPD2OGJ2AAQ6SHYUR6E";
// More distinct, valid `G…` StrKeys for the shared-wallet / ban-path tests, which
// match on case-sensitive StrKey (ST-4d) instead of lowercased `0x…`.
const G_SHARED = "GAX7VLUK2MZAQJ5JNRTUFSYO677CF642STTPECUJYCOZ3AD5BQS45SQZ";
const G_USERS = [
  "GCPE6PVCMTWNN3M3LSUW5NBLMDAF7OYK5ITU7VWVHC6PUQKOZ4V6ZQXD",
  "GB4PQVRZKT6IJF4XFTXS553JYFL2LC2HOML2N3YOGZUXPW42ERBNFSGV",
  "GCKPZ3UTFJAAMPWA2INEQKPQNLLI7EEI7QKQ6FVWV2ETRPVIJWM3AXE7",
];
const ENOUGH = 5000000000000000000n;

/** A withdraw request; the body names a destination only when one is given. */
function makeReq(destinationAddress?: string): NextRequest {
  return new NextRequest("http://localhost/api/me/withdraw", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: destinationAddress !== undefined ? JSON.stringify({ destinationAddress }) : undefined,
  });
}

function makeGetReq(): NextRequest {
  return new NextRequest("http://localhost/api/me/withdraw", { method: "GET" });
}

beforeEach(async () => {
  await truncateAll();
  vi.mocked(getLabelerSession).mockReset();
  vi.mocked(accountHasUsdcTrustline).mockReset();
  vi.mocked(accountHasUsdcTrustline).mockResolvedValue(true);
  process.env = { ...ORIGINAL_ENV, MIN_WITHDRAWAL_UNITS: MIN };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/** Nothing was enqueued and the balance is untouched. */
async function expectNothingWithdrawn(userId: string, balance: bigint = ENOUGH) {
  expect(await prisma.payoutJob.count({ where: { userId } })).toBe(0);
  const after = await prisma.user.findUnique({ where: { id: userId } });
  expect(after?.pendingBalanceUnits).toBe(balance);
}

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
    const user = await createUser({ isBanned: true, pendingBalanceUnits: ENOUGH, walletAddress: G_WALLET });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);
    const res = await POST(makeReq());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "account_frozen" });
  });

  it.each([
    ["no wallet", null],
    ["a legacy 0x wallet", "0x00000000000000000000000000000000000000aa"],
  ])("returns 409 wallet_required when the account has %s, withdrawing nothing (#30)", async (_label, walletAddress) => {
    const user = await createUser({ pendingBalanceUnits: ENOUGH, walletAddress });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);

    const res = await POST(makeReq(G_WALLET));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "wallet_required" });
    expect(accountHasUsdcTrustline).not.toHaveBeenCalled();
    await expectNothingWithdrawn(user.id);
  });

  it("returns 403 address_not_bound when the body names an address other than the bound wallet (#30)", async () => {
    const user = await createUser({ pendingBalanceUnits: ENOUGH, walletAddress: G_WALLET });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);

    const res = await POST(makeReq(G_SHARED));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "address_not_bound" });
    await expectNothingWithdrawn(user.id);
  });

  it("accepts a body naming the bound wallet", async () => {
    const user = await createUser({ pendingBalanceUnits: ENOUGH, walletAddress: G_WALLET });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);

    const res = await POST(makeReq(G_WALLET));

    expect(res.status).toBe(200);
    expect((await res.json()).destinationAddress).toBe(G_WALLET);
  });

  it("returns 400 below_minimum when balance is under the threshold", async () => {
    const user = await createUser({ pendingBalanceUnits: 500000000000000000n, walletAddress: G_WALLET });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);
    const res = await POST(makeReq());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "below_minimum",
      minimumUnits: MIN,
      balanceUnits: "500000000000000000",
    });
  });

  it("queues a single lump-sum payout to the bound wallet and decrements the balance on success", async () => {
    const user = await createUser({ pendingBalanceUnits: ENOUGH, walletAddress: G_WALLET });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);

    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("queued");
    expect(body.amountUnits).toBe("5000000000000000000");
    expect(body.destinationAddress).toBe(G_WALLET);
    expect(body.withdrawalId).toBeTruthy();

    const jobs = await prisma.payoutJob.findMany({ where: { userId: user.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe("WITHDRAWAL");
    expect(jobs[0].amountUnits).toBe(ENOUGH);
    expect(jobs[0].destinationAddress).toBe(G_WALLET);
    expect(accountHasUsdcTrustline).toHaveBeenCalledWith(G_WALLET);

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.pendingBalanceUnits).toBe(0n);

    const ledger = await prisma.userBalanceLedger.findMany({
      where: { userId: user.id, type: "WITHDRAWAL" },
    });
    expect(ledger).toHaveLength(1);
  });

  it("returns 409 payout_setup_required when the bound wallet holds no USDC trustline", async () => {
    const user = await createUser({ pendingBalanceUnits: ENOUGH, walletAddress: G_WALLET });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);
    vi.mocked(accountHasUsdcTrustline).mockResolvedValue(false);

    const res = await POST(makeReq());

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("payout_setup_required");
    // Funds stay locked to the user; nothing enqueued against an unpayable address.
    await expectNothingWithdrawn(user.id);
  });

  describe("P4a eligibility gates", () => {
    const HOUR_MS = 60 * 60 * 1000;

    /** A user holding the bound wallet; each test sets the one field that fails. */
    function userWith(fields: { submissionCount: number; goldCorrect: number; createdAt: Date }) {
      return prisma.user.create({
        data: { walletAddress: G_WALLET, pendingBalanceUnits: ENOUGH, goldAttempted: 10, ...fields },
      });
    }
    const WEEK_AGO = () => new Date(Date.now() - 7 * 24 * HOUR_MS);

    beforeEach(() => {
      process.env.WITHDRAWAL_MIN_SUBMISSIONS = "50";
      process.env.WITHDRAWAL_MIN_GOLD_RATE = "0.7";
      process.env.WITHDRAWAL_MIN_ACCOUNT_AGE_HOURS = "24";
    });

    it("blocks withdrawal with too few submissions", async () => {
      const user = await userWith({ submissionCount: 10, goldCorrect: 9, createdAt: WEEK_AGO() });
      vi.mocked(getLabelerSession).mockResolvedValue(user.id);

      const res = await POST(makeReq());

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "not_eligible", reason: "min_submissions" });
      await expectNothingWithdrawn(user.id);
    });

    it("blocks withdrawal with a low gold pass rate", async () => {
      const user = await userWith({ submissionCount: 100, goldCorrect: 5, createdAt: WEEK_AGO() }); // 0.5 < 0.7
      vi.mocked(getLabelerSession).mockResolvedValue(user.id);

      const res = await POST(makeReq());

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "not_eligible", reason: "gold_rate" });
      await expectNothingWithdrawn(user.id);
    });

    it("blocks withdrawal from a brand-new account", async () => {
      const user = await userWith({ submissionCount: 100, goldCorrect: 9, createdAt: new Date() });
      vi.mocked(getLabelerSession).mockResolvedValue(user.id);

      const res = await POST(makeReq());

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "not_eligible", reason: "account_age" });
      await expectNothingWithdrawn(user.id);
    });

    it("lets an eligible user withdraw", async () => {
      const user = await userWith({ submissionCount: 100, goldCorrect: 9, createdAt: WEEK_AGO() });
      vi.mocked(getLabelerSession).mockResolvedValue(user.id);

      const res = await POST(makeReq());

      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("queued");
      expect(await prisma.payoutJob.count({ where: { userId: user.id } })).toBe(1);
    });
  });

  it("returns 409 when a withdrawal is already in flight", async () => {
    const user = await createUser({ pendingBalanceUnits: ENOUGH, walletAddress: G_WALLET });
    await prisma.payoutJob.create({
      data: {
        type: "WITHDRAWAL",
        userId: user.id,
        amountUnits: ENOUGH,
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
    expect(updated?.pendingBalanceUnits).toBe(ENOUGH);
    expect(await prisma.payoutJob.count({ where: { userId: user.id } })).toBe(1);
  });

  it("returns 403 when the user's email is banned", async () => {
    const user = await createUser({ pendingBalanceUnits: ENOUGH, email: "banned@example.com", walletAddress: G_WALLET });
    await prisma.bannedIdentity.create({
      data: {
        identifierType: "EMAIL",
        identifierValue: "banned@example.com",
        reason: "test ban",
      },
    });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);

    const res = await POST(makeReq());

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("identity_banned");
    expect(body.identifierType).toBe("EMAIL");
    expect(body.identifierValue).toBe("banned@example.com");
    expect(body.reason).toBe("test ban");
  });

  it("returns 403 when the bound wallet is banned", async () => {
    const user = await createUser({ pendingBalanceUnits: ENOUGH, walletAddress: G_WALLET });
    await prisma.bannedIdentity.create({
      data: { identifierType: "WALLET", identifierValue: G_WALLET, reason: "wallet ban" },
    });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);

    const res = await POST(makeReq());

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("identity_banned");
    expect(body.identifierType).toBe("WALLET");
    expect(body.identifierValue).toBe(G_WALLET);
  });

  it("returns 403 when the userId is banned", async () => {
    const user = await createUser({ pendingBalanceUnits: ENOUGH, walletAddress: G_WALLET });
    await prisma.bannedIdentity.create({
      data: {
        identifierType: "USER_ID",
        identifierValue: user.id,
        reason: "user ban",
      },
    });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);

    const res = await POST(makeReq());

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("identity_banned");
    expect(body.identifierType).toBe("USER_ID");
    expect(body.identifierValue).toBe(user.id);
  });

  it("allows withdrawal when banned identity has expired", async () => {
    const user = await createUser({ pendingBalanceUnits: ENOUGH, email: "expired@example.com", walletAddress: G_WALLET });
    await prisma.bannedIdentity.create({
      data: {
        identifierType: "EMAIL",
        identifierValue: "expired@example.com",
        bannedUntil: new Date(Date.now() - 86400000), // yesterday
      },
    });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);

    const res = await POST(makeReq());

    expect(res.status).toBe(200);
  });

  /** Three other accounts that already withdrew to `destination`. */
  async function seedSharedDestination(destination: string) {
    const users = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        createUser({ walletAddress: G_USERS[i], pendingBalanceUnits: ENOUGH }),
      ),
    );
    for (const user of users) {
      await prisma.payoutJob.create({
        data: {
          type: "WITHDRAWAL",
          userId: user.id,
          amountUnits: 1000000000000000000n,
          destinationAddress: destination,
          status: "done",
        },
      });
    }
  }

  it("returns 403 when the bound wallet has received from too many accounts", async () => {
    await seedSharedDestination(G_SHARED);
    const abuser = await createUser({ pendingBalanceUnits: ENOUGH, walletAddress: G_SHARED });
    vi.mocked(getLabelerSession).mockResolvedValue(abuser.id);

    const res = await POST(makeReq());

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("shared_wallet_detected");
    expect(body.walletAddress).toBe(G_SHARED);
    expect(body.accountCount).toBe(3);
  });

  it("allows withdrawal when shared wallet count is below threshold", async () => {
    const sharedWallet = "0x0000000000000000000000000000000000000bBb";
    const users = await Promise.all(
      Array.from({ length: 2 }, (_, i) =>
        createUser({
          walletAddress: `0x0000000000000000000000000000000000000${i}b`,
          pendingBalanceUnits: ENOUGH,
        }),
      ),
    );

    for (const user of users) {
      await prisma.payoutJob.create({
        data: {
          type: "WITHDRAWAL",
          userId: user.id,
          amountUnits: 1000000000000000000n,
          destinationAddress: sharedWallet.toLowerCase(),
          status: "done",
        },
      });
    }

    // The new user holds a valid Stellar `G…` (so it clears the wallet + trustline
    // gates); the seeded 0x shared-wallet jobs are below the threshold, so the
    // shared-wallet gate passes and the withdrawal proceeds.
    const newUser = await createUser({ pendingBalanceUnits: ENOUGH, walletAddress: G_WALLET });
    vi.mocked(getLabelerSession).mockResolvedValue(newUser.id);

    const res = await POST(makeReq());

    expect(res.status).toBe(200);
  });

  describe("P4c flagged-withdrawal recording", () => {
    it("records a BANNED_IDENTITY flag when a blocked withdrawal is rejected", async () => {
      const user = await createUser({
        pendingBalanceUnits: ENOUGH,
        email: "banned@example.com",
        walletAddress: G_WALLET,
      });
      await prisma.bannedIdentity.create({
        data: { identifierType: "EMAIL", identifierValue: "banned@example.com", reason: "test ban" },
      });
      vi.mocked(getLabelerSession).mockResolvedValue(user.id);

      const res = await POST(makeReq());
      expect(res.status).toBe(403);

      const flags = await prisma.flaggedWithdrawal.findMany({ where: { userId: user.id } });
      expect(flags).toHaveLength(1);
      expect(flags[0].reason).toBe("BANNED_IDENTITY");
      expect(flags[0].status).toBe("PENDING");
      expect(flags[0].walletAddress).toBe(G_WALLET);
      expect(flags[0].balanceUnits).toBe(ENOUGH);
      expect((flags[0].detail as Record<string, unknown>).identifierValue).toBe("banned@example.com");
    });

    it("records a SHARED_WALLET flag when a shared wallet is blocked", async () => {
      await seedSharedDestination(G_SHARED);
      const abuser = await createUser({ pendingBalanceUnits: ENOUGH, walletAddress: G_SHARED });
      vi.mocked(getLabelerSession).mockResolvedValue(abuser.id);

      const res = await POST(makeReq());
      expect(res.status).toBe(403);

      const flags = await prisma.flaggedWithdrawal.findMany({ where: { userId: abuser.id } });
      expect(flags).toHaveLength(1);
      expect(flags[0].reason).toBe("SHARED_WALLET");
      expect((flags[0].detail as Record<string, unknown>).accountCount).toBe(3);
    });

    it("records an INELIGIBLE flag when an eligibility gate fails", async () => {
      process.env.WITHDRAWAL_MIN_SUBMISSIONS = "50";
      process.env.WITHDRAWAL_MIN_GOLD_RATE = "0.7";
      process.env.WITHDRAWAL_MIN_ACCOUNT_AGE_HOURS = "24";
      const user = await prisma.user.create({
        data: {
          walletAddress: G_WALLET,
          pendingBalanceUnits: ENOUGH,
          submissionCount: 1,
          goldCorrect: 9,
          goldAttempted: 10,
          createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        },
      });
      vi.mocked(getLabelerSession).mockResolvedValue(user.id);

      const res = await POST(makeReq());
      expect(res.status).toBe(403);

      const flags = await prisma.flaggedWithdrawal.findMany({ where: { userId: user.id } });
      expect(flags).toHaveLength(1);
      expect(flags[0].reason).toBe("INELIGIBLE");
      expect((flags[0].detail as Record<string, unknown>).reason).toBe("min_submissions");
    });

    it("does not duplicate a PENDING flag when the same block repeats", async () => {
      const user = await createUser({
        pendingBalanceUnits: ENOUGH,
        email: "repeat@example.com",
        walletAddress: G_WALLET,
      });
      await prisma.bannedIdentity.create({
        data: { identifierType: "EMAIL", identifierValue: "repeat@example.com", reason: "test ban" },
      });
      vi.mocked(getLabelerSession).mockResolvedValue(user.id);

      await POST(makeReq());
      await POST(makeReq());

      const flags = await prisma.flaggedWithdrawal.findMany({ where: { userId: user.id } });
      expect(flags).toHaveLength(1);
    });

    it("does not record a flag on a successful withdrawal", async () => {
      const user = await createUser({ pendingBalanceUnits: ENOUGH, walletAddress: G_WALLET });
      vi.mocked(getLabelerSession).mockResolvedValue(user.id);

      const res = await POST(makeReq());
      expect(res.status).toBe(200);

      expect(await prisma.flaggedWithdrawal.count({ where: { userId: user.id } })).toBe(0);
    });
  });
});

describe("GET /api/me/withdraw (summary)", () => {
  it("returns 401 when there is no session", async () => {
    vi.mocked(getLabelerSession).mockResolvedValue(null);
    const res = await GET(makeGetReq());
    expect(res.status).toBe(401);
  });

  it("returns balance, threshold, the bound wallet, empty history, and canWithdraw=true above the minimum", async () => {
    const user = await createUser({ pendingBalanceUnits: ENOUGH, walletAddress: G_WALLET });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);

    const res = await GET(makeGetReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      pendingBalanceUnits: "5000000000000000000",
      thresholdUnits: MIN,
      destinationAddress: G_WALLET,
      canWithdraw: true,
      withdrawals: [],
    });
    expect(body).not.toHaveProperty("walletLinked");
  });

  it.each([
    ["no wallet", null],
    ["a legacy 0x wallet", "0x00000000000000000000000000000000000000aa"],
  ])("reports canWithdraw=false and no destination when the account has %s (#30)", async (_label, walletAddress) => {
    const user = await createUser({ pendingBalanceUnits: ENOUGH, walletAddress });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);

    const body = await (await GET(makeGetReq())).json();
    expect(body.canWithdraw).toBe(false);
    expect(body.destinationAddress).toBeNull();
  });

  it("reports canWithdraw=false when the balance is below the minimum", async () => {
    const user = await createUser({ pendingBalanceUnits: 1n, walletAddress: G_WALLET });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);

    const body = await (await GET(makeGetReq())).json();
    expect(body.canWithdraw).toBe(false);
  });

  it("reports canWithdraw=false when a withdrawal is already in flight", async () => {
    const user = await createUser({ pendingBalanceUnits: ENOUGH, walletAddress: G_WALLET });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);

    await prisma.payoutJob.create({
      data: {
        type: "WITHDRAWAL",
        userId: user.id,
        amountUnits: 2000000000000000000n,
        destinationAddress: G_WALLET,
        status: "queued",
      },
    });

    const body = await (await GET(makeGetReq())).json();
    expect(body.canWithdraw).toBe(false);
  });

  it("lists the user's lump-sum withdrawals (newest first) and ignores other users' jobs", async () => {
    const user = await createUser({ pendingBalanceUnits: ENOUGH, walletAddress: G_WALLET });
    const other = await createUser({ pendingBalanceUnits: ENOUGH, walletAddress: makeWallet() });
    vi.mocked(getLabelerSession).mockResolvedValue(user.id);

    await prisma.payoutJob.create({
      data: {
        type: "WITHDRAWAL",
        userId: user.id,
        amountUnits: 2000000000000000000n,
        destinationAddress: G_WALLET,
        status: "done",
        txHash: "txhash-abc",
      },
    });
    await prisma.payoutJob.create({
      data: { type: "WITHDRAWAL", userId: other.id, amountUnits: 9n, status: "queued" },
    });

    const body = await (await GET(makeGetReq())).json();
    expect(body.withdrawals).toHaveLength(1);
    expect(body.withdrawals[0]).toMatchObject({
      amountUnits: "2000000000000000000",
      status: "done",
      txHash: "txhash-abc",
      completedAt: null,
      error: null,
    });
  });
});
