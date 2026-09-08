import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, truncateAll } from "@/tests/helpers/db";

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

import { claimNextJob } from "@/lib/payout-worker";

// One minute past STALE_PROCESSING_MS, so heartbeat staleness is never the
// reason a job is skipped in these cases.
const STALE_HEARTBEAT = new Date(Date.now() - 120_000);

beforeEach(async () => {
  await truncateAll();
});

describe("claimNextJob and the quarantine boundary", () => {
  it("reclaims a stale processing job that was never quarantined", async () => {
    const job = await prisma.payoutJob.create({
      data: {
        type: "WITHDRAWAL",
        status: "processing",
        userId: null,
        amountUnits: 123n,
        workerHeartbeatAt: STALE_HEARTBEAT,
      },
    });

    expect((await claimNextJob())?.id).toBe(job.id);
  });

  it("never reclaims a job quarantined after an accepted payment", async () => {
    // This is the double-payment guard: quarantining moves the job out of the
    // claimable set, so no sweep can re-run the handler and pay a second time.
    await prisma.payoutJob.create({
      data: {
        type: "WITHDRAWAL",
        status: "failed",
        userId: null,
        amountUnits: 123n,
        completedAt: new Date(),
        lastError: "accepted payment needs manual reconciliation",
        workerHeartbeatAt: STALE_HEARTBEAT,
      },
    });

    expect(await claimNextJob()).toBeNull();
  });
});
