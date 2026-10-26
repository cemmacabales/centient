import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/task/route";
import { signLabelerJWT } from "@/lib/labeler-auth";
import { prisma, truncateAll } from "@/tests/helpers/db";
import {
  createTask,
  createCampaign,
  createGoldTask,
  createUser,
  makeWallet,
  VALID_REASON,
} from "@/tests/helpers/factories";

beforeEach(async () => {
  await truncateAll();
  vi.restoreAllMocks();
});

function makeReq(token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `labeler_session=${token}`;
  return new NextRequest("http://localhost/api/task", { method: "GET", headers });
}

// Task assignment is keyed on the session (userId) as of ST-5d. Create a user
// and drive the route with a signed session cookie instead of a `?wallet=` param.
async function getTaskAs(userId: string) {
  const token = await signLabelerJWT(userId);
  return GET(makeReq(token));
}

async function getTaskAsFreshUser() {
  const user = await createUser();
  return getTaskAs(user.id);
}

function mockRandom(value: number) {
  vi.spyOn(Math, "random").mockReturnValue(value);
}

describe("GET /api/task - session auth", () => {
  it("returns 401 when no session cookie is present", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("returns 401 for a tampered token", async () => {
    const res = await GET(makeReq("not.a.valid.jwt"));
    expect(res.status).toBe(401);
  });

  it("returns 401 when the session user no longer exists", async () => {
    const token = await signLabelerJWT("00000000-0000-0000-0000-000000000000");
    const res = await GET(makeReq(token));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/task - task assignment", () => {
  it("serves no task to an email-only account until it binds a wallet (#30)", async () => {
    mockRandom(0.5);
    const campaign = await createCampaign({ defaultResponseTarget: 5 });
    await createTask({ campaignId: campaign.id, responseTarget: null });

    const user = await createUser({ walletAddress: null, email: "labeler@example.com" });
    const res = await getTaskAs(user.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "wallet_required" });
  });

  it("serves no task to an account holding only a legacy 0x wallet (#30)", async () => {
    mockRandom(0.5);
    const campaign = await createCampaign({ defaultResponseTarget: 5 });
    await createTask({ campaignId: campaign.id, responseTarget: null });

    const user = await createUser({ walletAddress: makeWallet() });
    const res = await getTaskAs(user.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "wallet_required" });
  });

  it("returns a non-gold task with submissionsRemaining", async () => {
    mockRandom(0.5);
    const campaign = await createCampaign({ defaultResponseTarget: 5 });
    await createTask({ campaignId: campaign.id, responseTarget: null });

    const res = await getTaskAsFreshUser();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task).not.toBeNull();
    expect(body.task.id).toBeTruthy();
    expect(body.task.prompt).toBe("Test prompt?");
    expect(body.task.submissionsRemaining).toBe(5);
  });

  it("uses task-level responseTarget over campaign default", async () => {
    mockRandom(0.5);
    const campaign = await createCampaign({ defaultResponseTarget: 5 });
    await createTask({ campaignId: campaign.id, responseTarget: 7 });

    const res = await getTaskAsFreshUser();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task.submissionsRemaining).toBe(7);
  });

  it("returns null submissionsRemaining for gold tasks", async () => {
    mockRandom(0);
    await createGoldTask("A");

    const res = await getTaskAsFreshUser();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task).not.toBeNull();
    expect(body.task.submissionsRemaining).toBeNull();
  });

  it("returns no task message when all tasks are done by this user", async () => {
    mockRandom(0.5);
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id });
    const user = await createUser();

    await prisma.submission.create({
      data: {
        walletAddress: user.walletAddress,
        userId: user.id,
        taskId: task.id,
        choice: "A",
        reason: VALID_REASON,
        payoutAmountUnits: 1,
        payoutStatus: "sent",
      },
    });

    const res = await getTaskAs(user.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task).toBeNull();
    expect(body.message).toBe("No more tasks available");
  });

  it("does not treat another user's submissions as done for this user", async () => {
    mockRandom(0.5);
    const campaign = await createCampaign({ defaultResponseTarget: 5 });
    const task = await createTask({ campaignId: campaign.id, responseTarget: null });
    const other = await createUser();
    await prisma.submission.create({
      data: {
        walletAddress: other.walletAddress,
        userId: other.id,
        taskId: task.id,
        choice: "A",
        reason: VALID_REASON,
        payoutAmountUnits: 1,
        payoutStatus: "sent",
      },
    });

    const res = await getTaskAsFreshUser();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task).not.toBeNull();
    expect(body.task.id).toBe(task.id);
  });
});

describe("GET /api/task - response target filtering", () => {
  it("filters out tasks that have met their task-level responseTarget", async () => {
    mockRandom(0.5);
    const campaign = await createCampaign();
    const targetMet = await createTask({ campaignId: campaign.id, responseTarget: 2, prompt: "Prompt A?" });
    const targetNotMet = await createTask({ campaignId: campaign.id, responseTarget: 2, prompt: "Prompt B?" });

    const user1 = await createUser();
    const user2 = await createUser();
    const user3 = await createUser();

    await prisma.submission.createMany({
      data: [
        { walletAddress: user1.walletAddress, userId: user1.id, taskId: targetMet.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 1, payoutStatus: "sent" },
        { walletAddress: user2.walletAddress, userId: user2.id, taskId: targetMet.id, choice: "B", reason: VALID_REASON, payoutAmountUnits: 1, payoutStatus: "sent", isGoldCheck: false },
      ],
    });

    await prisma.submission.create({
      data: { walletAddress: user3.walletAddress, userId: user3.id, taskId: targetNotMet.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 1, payoutStatus: "sent", isGoldCheck: false },
    });

    const res = await getTaskAsFreshUser();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task).not.toBeNull();
    expect(body.task.id).toBe(targetNotMet.id);
    expect(body.task.submissionsRemaining).toBe(1);
  });

  it("filters out tasks that have met campaign-level responseTarget", async () => {
    mockRandom(0.5);
    const campaign = await createCampaign({ defaultResponseTarget: 1 });
    const targetMet = await createTask({ campaignId: campaign.id, responseTarget: null, prompt: "Prompt A?" });
    await createTask({ campaignId: campaign.id, responseTarget: null, prompt: "Prompt B?" });

    const user1 = await createUser();
    await prisma.submission.create({
      data: { walletAddress: user1.walletAddress, userId: user1.id, taskId: targetMet.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 1, payoutStatus: "sent", isGoldCheck: false },
    });

    const res = await getTaskAsFreshUser();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task).not.toBeNull();
    expect(body.task.id).not.toBe(targetMet.id);
    expect(body.task.submissionsRemaining).toBe(1);
  });

  it("returns no task when all non-gold tasks have met targets", async () => {
    mockRandom(0.5);
    const campaign = await createCampaign({ defaultResponseTarget: 1 });
    const task1 = await createTask({ campaignId: campaign.id, responseTarget: null, prompt: "Prompt A?" });
    const task2 = await createTask({ campaignId: campaign.id, responseTarget: null, prompt: "Prompt B?" });

    const user1 = await createUser();
    const user2 = await createUser();

    await prisma.submission.createMany({
      data: [
        { walletAddress: user1.walletAddress, userId: user1.id, taskId: task1.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 1, payoutStatus: "sent", isGoldCheck: false },
        { walletAddress: user2.walletAddress, userId: user2.id, taskId: task2.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 1, payoutStatus: "sent", isGoldCheck: false },
      ],
    });

    const res = await getTaskAsFreshUser();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task).toBeNull();
    expect(body.message).toBe("No more tasks available");
  });

  it("does not count gold-check submissions against target", async () => {
    mockRandom(0.5);
    const campaign = await createCampaign({ defaultResponseTarget: 2 });
    const task = await createTask({ campaignId: campaign.id, responseTarget: null });

    const user1 = await createUser();
    const user2 = await createUser();

    await prisma.submission.createMany({
      data: [
        { walletAddress: user1.walletAddress, userId: user1.id, taskId: task.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 1, payoutStatus: "sent", isGoldCheck: true },
        { walletAddress: user2.walletAddress, userId: user2.id, taskId: task.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 1, payoutStatus: "sent", isGoldCheck: true },
      ],
    });

    const res = await getTaskAsFreshUser();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task).not.toBeNull();
    expect(body.task.submissionsRemaining).toBe(2);
  });

  it("does not count skipped or failed submissions against target", async () => {
    mockRandom(0.5);
    const campaign = await createCampaign({ defaultResponseTarget: 2 });
    const task = await createTask({ campaignId: campaign.id, responseTarget: null });

    const user1 = await createUser();
    const user2 = await createUser();

    await prisma.submission.createMany({
      data: [
        { walletAddress: user1.walletAddress, userId: user1.id, taskId: task.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 0, payoutStatus: "skipped", isGoldCheck: false },
        { walletAddress: user2.walletAddress, userId: user2.id, taskId: task.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 0, payoutStatus: "failed", isGoldCheck: false },
      ],
    });

    const res = await getTaskAsFreshUser();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task).not.toBeNull();
    expect(body.task.submissionsRemaining).toBe(2);
  });

  it("counts an in-flight pending payout against target (#37)", async () => {
    // An accepted answer is written `pending` and paid out of band. Serving the
    // task as if that answer did not exist would let submit then refuse it as
    // full, or let it be answered past its target while payouts are in flight.
    mockRandom(0.5);
    const campaign = await createCampaign({ defaultResponseTarget: 2 });
    const task = await createTask({ campaignId: campaign.id, responseTarget: null });
    const user1 = await createUser();

    await prisma.submission.create({
      data: { walletAddress: user1.walletAddress, userId: user1.id, taskId: task.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 1, payoutStatus: "pending", isGoldCheck: false },
    });

    const res = await getTaskAsFreshUser();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task).not.toBeNull();
    expect(body.task.submissionsRemaining).toBe(1);
  });

  it("counts confirmed submissions against target", async () => {
    mockRandom(0.5);
    const campaign = await createCampaign();
    const targetMet = await createTask({ campaignId: campaign.id, responseTarget: 2, prompt: "Prompt A?" });
    const targetNotMet = await createTask({ campaignId: campaign.id, responseTarget: 2, prompt: "Prompt B?" });

    const user1 = await createUser();
    const user2 = await createUser();

    await prisma.submission.createMany({
      data: [
        { walletAddress: user1.walletAddress, userId: user1.id, taskId: targetMet.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 1, payoutStatus: "confirmed", isGoldCheck: false },
        { walletAddress: user2.walletAddress, userId: user2.id, taskId: targetMet.id, choice: "B", reason: VALID_REASON, payoutAmountUnits: 1, payoutStatus: "confirmed", isGoldCheck: false },
      ],
    });

    const res = await getTaskAsFreshUser();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task).not.toBeNull();
    expect(body.task.id).toBe(targetNotMet.id);
    expect(body.task.submissionsRemaining).toBe(2);
  });

  it("counts accrued submissions against target", async () => {
    mockRandom(0.5);
    const campaign = await createCampaign();
    const targetMet = await createTask({ campaignId: campaign.id, responseTarget: 2, prompt: "Prompt A?" });
    const targetNotMet = await createTask({ campaignId: campaign.id, responseTarget: 2, prompt: "Prompt B?" });

    const user1 = await createUser();
    const user2 = await createUser();

    await prisma.submission.createMany({
      data: [
        { walletAddress: user1.walletAddress, userId: user1.id, taskId: targetMet.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 1, payoutStatus: "accrued", isGoldCheck: false },
        { walletAddress: user2.walletAddress, userId: user2.id, taskId: targetMet.id, choice: "B", reason: VALID_REASON, payoutAmountUnits: 1, payoutStatus: "accrued", isGoldCheck: false },
      ],
    });

    const res = await getTaskAsFreshUser();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task).not.toBeNull();
    expect(body.task.id).toBe(targetNotMet.id);
    expect(body.task.submissionsRemaining).toBe(2);
  });
});

describe("GET /api/task - XP loop (#201)", () => {
  it("carries the answer's XP by the task's difficulty", async () => {
    mockRandom(0.5);
    await createTask({ difficulty: 5 });
    const res = await getTaskAsFreshUser();
    expect((await res.json()).task.xp).toBe(15);
  });

  it("carries the lowest band for a task with no difficulty", async () => {
    mockRandom(0.5);
    await createTask({ difficulty: null });
    const res = await getTaskAsFreshUser();
    expect((await res.json()).task.xp).toBe(10);
  });

  it("carries no XP during retest, which earns none", async () => {
    mockRandom(0.5);
    await createGoldTask("A");
    const user = await createUser({ isBanned: true, bannedUntil: new Date(Date.now() - 1000), banCount: 1 });
    const res = await getTaskAs(user.id);
    const body = await res.json();
    expect(body.task).not.toBeNull();
    expect(body.task.xp).toBeNull();
  });

  it("protects today when nothing is left for the labeler", async () => {
    const user = await createUser();
    const res = await getTaskAs(user.id);
    expect((await res.json()).task).toBeNull();

    const days = await prisma.dailyProgress.findMany({ where: { userId: user.id } });
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ protected: true, counted: 0 });
  });

  it("does not protect today while a task is open", async () => {
    mockRandom(0.5);
    await createTask();
    const user = await createUser();
    await getTaskAs(user.id);
    expect(await prisma.dailyProgress.count({ where: { userId: user.id } })).toBe(0);
  });

  it("still answers when protecting today fails", async () => {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_refuse_daily_progress() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced daily_progress insert failure'; END;
      $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_refuse_daily_progress BEFORE INSERT ON "daily_progress"
      FOR EACH ROW EXECUTE FUNCTION test_refuse_daily_progress()`);
    try {
      const user = await createUser();
      const res = await getTaskAs(user.id);
      expect(res.status).toBe(200);
      expect((await res.json()).task).toBeNull();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_refuse_daily_progress ON "daily_progress"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_refuse_daily_progress()`);
    }
  });
});
