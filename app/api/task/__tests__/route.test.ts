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
  it("serves a task to an email-only user with no linked wallet", async () => {
    mockRandom(0.5);
    const campaign = await createCampaign({ defaultResponseTarget: 5 });
    await createTask({ campaignId: campaign.id, responseTarget: null });

    const user = await createUser({ walletAddress: null, email: "labeler@example.com" });
    const res = await getTaskAs(user.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task).not.toBeNull();
    expect(body.task.id).toBeTruthy();
    expect(body.task.submissionsRemaining).toBe(5);
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

  it("does not count non-sent submissions against target", async () => {
    mockRandom(0.5);
    const campaign = await createCampaign({ defaultResponseTarget: 2 });
    const task = await createTask({ campaignId: campaign.id, responseTarget: null });

    const user1 = await createUser();
    const user2 = await createUser();

    await prisma.submission.createMany({
      data: [
        { walletAddress: user1.walletAddress, userId: user1.id, taskId: task.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 0, payoutStatus: "skipped", isGoldCheck: false },
        { walletAddress: user2.walletAddress, userId: user2.id, taskId: task.id, choice: "A", reason: VALID_REASON, payoutAmountUnits: 0, payoutStatus: "pending", isGoldCheck: false },
      ],
    });

    const res = await getTaskAsFreshUser();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task).not.toBeNull();
    expect(body.task.submissionsRemaining).toBe(2);
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
