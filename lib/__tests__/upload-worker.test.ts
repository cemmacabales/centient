import { describe, it, expect, beforeEach } from "vitest";

import { claimJob } from "@/lib/upload-worker";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createCampaign, createAdminUser } from "@/tests/helpers/factories";

async function createQueuedJob(
  status: "queued" | "processing" | "done" | "failed" | "cancelled" = "queued"
) {
  const admin = await createAdminUser();
  const campaign = await createCampaign({ adminUserId: admin.id });
  return prisma.uploadJob.create({
    data: {
      campaignId: campaign.id,
      adminUserId: admin.id,
      fileName: "data.csv",
      fileSize: 100,
      status,
      totalRows: 3,
      chunksTotal: 1,
      rawText: "prompt,responseA,responseB\nq,a,b\n",
    },
  });
}

beforeEach(async () => {
  await truncateAll();
});

describe("claimJob", () => {
  it("transitions a queued job to processing and returns true", async () => {
    const job = await createQueuedJob();

    const claimed = await claimJob(job.id);

    expect(claimed).toBe(true);
    const after = await prisma.uploadJob.findUnique({ where: { id: job.id } });
    expect(after?.status).toBe("processing");
    expect(after?.startedAt).not.toBeNull();
  });

  it("returns false when the job has already been claimed (no double-processing)", async () => {
    const job = await createQueuedJob();

    const first = await claimJob(job.id);
    const second = await claimJob(job.id);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("does not claim a job that is already done", async () => {
    const job = await createQueuedJob("done");

    const claimed = await claimJob(job.id);

    expect(claimed).toBe(false);
    const after = await prisma.uploadJob.findUnique({ where: { id: job.id } });
    expect(after?.status).toBe("done");
  });
});
