// #202 — a campaign CSV's difficulty reaches the task, so tier gating reads it.
import { describe, it, expect, beforeEach } from "vitest";
import { processJob } from "@/lib/upload-worker";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createAdminUser, createCampaign } from "@/tests/helpers/factories";

beforeEach(async () => {
  await truncateAll();
});

async function upload(rawText: string) {
  const admin = await createAdminUser();
  const campaign = await createCampaign({ adminUserId: admin.id });
  const job = await prisma.uploadJob.create({
    data: { campaignId: campaign.id, adminUserId: admin.id, fileName: "d.csv", fileSize: rawText.length, status: "processing", totalRows: 2, chunksTotal: 1, rawText },
  });
  await processJob(job.id);
  return campaign.id;
}

describe("upload worker - difficulty (#202)", () => {
  it("writes each row's difficulty, and none for an empty cell", async () => {
    const campaignId = await upload("prompt,responseA,responseB,difficulty\nq1,a,b,7\nq2,a,b,\n");
    const tasks = await prisma.task.findMany({ where: { campaignId }, orderBy: { prompt: "asc" }, select: { prompt: true, difficulty: true } });
    expect(tasks).toEqual([
      { prompt: "q1", difficulty: 7 },
      { prompt: "q2", difficulty: null },
    ]);
  });
});
