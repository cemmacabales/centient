import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/task/route";
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

function makeReq(wallet?: string): NextRequest {
  const url = wallet
    ? `http://localhost/api/task?wallet=${wallet}`
    : "http://localhost/api/task";
  return new NextRequest(url, { method: "GET" });
}

async function getTask(wallet?: string) {
  return GET(makeReq(wallet ?? makeWallet()));
}

function mockRandom(value: number) {
  vi.spyOn(Math, "random").mockReturnValue(value);
}

describe("GET /api/task - validation", () => {
  it("returns 400 invalid_wallet when wallet is missing", async () => {
    const res = await makeReq();
    const response = await GET(res);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_wallet" });
  });

  it("returns 400 invalid_wallet for non-hex address", async () => {
    const res = await getTask("0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/task - task assignment", () => {
  it("returns a non-gold task with submissionsRemaining", async () => {
    mockRandom(0.5);
    const campaign = await createCampaign({ defaultResponseTarget: 5 });
    await createTask({ campaignId: campaign.id, responseTarget: null });

    const wallet = makeWallet();
    const res = await getTask(wallet);
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

    const wallet = makeWallet();
    const res = await getTask(wallet);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task.submissionsRemaining).toBe(7);
  });

  it("returns null submissionsRemaining for gold tasks", async () => {
    mockRandom(0);
    const wallet = makeWallet();
    await createGoldTask("A");

    const res = await getTask(wallet);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task).not.toBeNull();
    expect(body.task.submissionsRemaining).toBeNull();
  });

  it("returns no task message when all tasks are done by this user", async () => {
    mockRandom(0.5);
    const campaign = await createCampaign();
    const task = await createTask({ campaignId: campaign.id });
    const wallet = makeWallet();
    const user = await createUser({ walletAddress: wallet });

    await prisma.submission.create({
      data: {
        walletAddress: wallet,
        userId: user.id,
        taskId: task.id,
        choice: "A",
        reason: VALID_REASON,
        payoutAmountStroops: 1,
        payoutStatus: "sent",
      },
    });

    const res = await getTask(wallet);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task).toBeNull();
    expect(body.message).toBe("No more tasks available");
  });
});

describe("GET /api/task - response target filtering", () => {
  it("filters out tasks that have met their task-level responseTarget", async () => {
    mockRandom(0.5);
    const campaign = await createCampaign();
    const targetMet = await createTask({ campaignId: campaign.id, responseTarget: 2, prompt: "Prompt A?" });
    const targetNotMet = await createTask({ campaignId: campaign.id, responseTarget: 2, prompt: "Prompt B?" });

    const u1 = makeWallet();
    const u2 = makeWallet();
    const u3 = makeWallet();
    const user1 = await createUser({ walletAddress: u1 });
    const user2 = await createUser({ walletAddress: u2 });
    const user3 = await createUser({ walletAddress: u3 });

    await prisma.submission.createMany({
      data: [
        { walletAddress: u1, userId: user1.id, taskId: targetMet.id, choice: "A", reason: VALID_REASON, payoutAmountStroops: 1, payoutStatus: "sent" },
        { walletAddress: u2, userId: user2.id, taskId: targetMet.id, choice: "B", reason: VALID_REASON, payoutAmountStroops: 1, payoutStatus: "sent", isGoldCheck: false },
      ],
    });

    await prisma.submission.create({
      data: { walletAddress: u3, userId: user3.id, taskId: targetNotMet.id, choice: "A", reason: VALID_REASON, payoutAmountStroops: 1, payoutStatus: "sent", isGoldCheck: false },
    });

    const wallet = makeWallet();
    const res = await getTask(wallet);
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

    const u1 = makeWallet();
    const user1 = await createUser({ walletAddress: u1 });
    await prisma.submission.create({
      data: { walletAddress: u1, userId: user1.id, taskId: targetMet.id, choice: "A", reason: VALID_REASON, payoutAmountStroops: 1, payoutStatus: "sent", isGoldCheck: false },
    });

    const wallet = makeWallet();
    const res = await getTask(wallet);
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

    const u1 = makeWallet();
    const u2 = makeWallet();
    const user1 = await createUser({ walletAddress: u1 });
    const user2 = await createUser({ walletAddress: u2 });

    await prisma.submission.createMany({
      data: [
        { walletAddress: u1, userId: user1.id, taskId: task1.id, choice: "A", reason: VALID_REASON, payoutAmountStroops: 1, payoutStatus: "sent", isGoldCheck: false },
        { walletAddress: u2, userId: user2.id, taskId: task2.id, choice: "A", reason: VALID_REASON, payoutAmountStroops: 1, payoutStatus: "sent", isGoldCheck: false },
      ],
    });

    const wallet = makeWallet();
    const res = await getTask(wallet);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task).toBeNull();
    expect(body.message).toBe("No more tasks available");
  });

  it("does not count gold-check submissions against target", async () => {
    mockRandom(0.5);
    const campaign = await createCampaign({ defaultResponseTarget: 2 });
    const task = await createTask({ campaignId: campaign.id, responseTarget: null });

    const u1 = makeWallet();
    const u2 = makeWallet();
    const user1 = await createUser({ walletAddress: u1 });
    const user2 = await createUser({ walletAddress: u2 });

    await prisma.submission.createMany({
      data: [
        { walletAddress: u1, userId: user1.id, taskId: task.id, choice: "A", reason: VALID_REASON, payoutAmountStroops: 1, payoutStatus: "sent", isGoldCheck: true },
        { walletAddress: u2, userId: user2.id, taskId: task.id, choice: "A", reason: VALID_REASON, payoutAmountStroops: 1, payoutStatus: "sent", isGoldCheck: true },
      ],
    });

    const wallet = makeWallet();
    const res = await getTask(wallet);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task).not.toBeNull();
    expect(body.task.submissionsRemaining).toBe(2);
  });

  it("does not count non-sent submissions against target", async () => {
    mockRandom(0.5);
    const campaign = await createCampaign({ defaultResponseTarget: 2 });
    const task = await createTask({ campaignId: campaign.id, responseTarget: null });

    const u1 = makeWallet();
    const u2 = makeWallet();
    const user1 = await createUser({ walletAddress: u1 });
    const user2 = await createUser({ walletAddress: u2 });

    await prisma.submission.createMany({
      data: [
        { walletAddress: u1, userId: user1.id, taskId: task.id, choice: "A", reason: VALID_REASON, payoutAmountStroops: 0, payoutStatus: "skipped", isGoldCheck: false },
        { walletAddress: u2, userId: user2.id, taskId: task.id, choice: "A", reason: VALID_REASON, payoutAmountStroops: 0, payoutStatus: "pending", isGoldCheck: false },
      ],
    });

    const wallet = makeWallet();
    const res = await getTask(wallet);
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

    const u1 = makeWallet();
    const u2 = makeWallet();
    const user1 = await createUser({ walletAddress: u1 });
    const user2 = await createUser({ walletAddress: u2 });

    await prisma.submission.createMany({
      data: [
        { walletAddress: u1, userId: user1.id, taskId: targetMet.id, choice: "A", reason: VALID_REASON, payoutAmountStroops: 1, payoutStatus: "confirmed", isGoldCheck: false },
        { walletAddress: u2, userId: user2.id, taskId: targetMet.id, choice: "B", reason: VALID_REASON, payoutAmountStroops: 1, payoutStatus: "confirmed", isGoldCheck: false },
      ],
    });

    const wallet = makeWallet();
    const res = await getTask(wallet);
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

    const u1 = makeWallet();
    const u2 = makeWallet();
    const user1 = await createUser({ walletAddress: u1 });
    const user2 = await createUser({ walletAddress: u2 });

    await prisma.submission.createMany({
      data: [
        { walletAddress: u1, userId: user1.id, taskId: targetMet.id, choice: "A", reason: VALID_REASON, payoutAmountStroops: 1, payoutStatus: "accrued", isGoldCheck: false },
        { walletAddress: u2, userId: user2.id, taskId: targetMet.id, choice: "B", reason: VALID_REASON, payoutAmountStroops: 1, payoutStatus: "accrued", isGoldCheck: false },
      ],
    });

    const wallet = makeWallet();
    const res = await getTask(wallet);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task).not.toBeNull();
    expect(body.task.id).toBe(targetNotMet.id);
    expect(body.task.submissionsRemaining).toBe(2);
  });
});
