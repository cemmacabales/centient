// #37 — the retry cron leaves the payout worker's submissions alone.
//
// Submit now enqueues a SUBMISSION_PAYOUT job for every accepted answer, and
// the row it writes (`pending`, no hash) is what this cron treats as stuck. The
// selection runs for real against the database here; only the broadcast
// (`reprocessPayoutWithNonceSafety`) is replaced, so each case asserts which
// rows the cron would have tried to pay.
import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockReprocess } = vi.hoisted(() => ({ mockReprocess: vi.fn() }));
vi.mock("@/lib/payout-service", () => ({ reprocessPayoutWithNonceSafety: mockReprocess }));

import { POST } from "../route";
import { SUBMISSION_RETRY_BUDGET } from "@/lib/payout-retry-claim";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser, createTask, VALID_REASON } from "@/tests/helpers/factories";

const TEN_MINUTES_AGO = () => new Date(Date.now() - 10 * 60_000);

beforeEach(async () => {
  await truncateAll();
  mockReprocess.mockReset();
  mockReprocess.mockResolvedValue(undefined);
  process.env.CRON_SECRET = "test-secret";
});

async function runCron() {
  const res = await POST(
    new NextRequest("http://localhost/api/cron/payout-retry", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret" },
    }),
  );
  expect(res.status).toBe(200);
  return mockReprocess.mock.calls.map((c) => c[0] as string);
}

/** An old submission, well past both the stuck window and every backoff. */
async function staleSubmission(payoutStatus: "pending" | "failed", retryCount = 0) {
  const user = await createUser();
  const task = await createTask({ campaignId: null });
  return prisma.submission.create({
    data: {
      walletAddress: user.walletAddress,
      userId: user.id,
      taskId: task.id,
      choice: "A",
      reason: VALID_REASON,
      payoutAmountUnits: 2_500_000n,
      payoutStatus,
      retryCount,
      createdAt: TEN_MINUTES_AGO(),
    },
  });
}

describe("/api/cron/payout-retry — worker-owned submissions (#37)", () => {
  it.each(["queued", "processing"] as const)(
    "skips a pending submission whose payout job is %s",
    async (status) => {
      const sub = await staleSubmission("pending");
      await prisma.payoutJob.create({ data: { type: "SUBMISSION_PAYOUT", submissionId: sub.id, status } });
      expect(await runCron()).not.toContain(sub.id);
    },
  );

  it("skips a failed submission whose payout job is still queued", async () => {
    const sub = await staleSubmission("failed");
    await prisma.payoutJob.create({ data: { type: "SUBMISSION_PAYOUT", submissionId: sub.id, status: "queued" } });
    expect(await runCron()).not.toContain(sub.id);
  });

  it("takes over a pending submission once its job has ended without paying (e.g. cap deferral)", async () => {
    const sub = await staleSubmission("pending");
    await prisma.payoutJob.create({ data: { type: "SUBMISSION_PAYOUT", submissionId: sub.id, status: "failed" } });
    expect(await runCron()).toContain(sub.id);
  });

  it("still retries a pending submission with no job at all", async () => {
    const sub = await staleSubmission("pending");
    expect(await runCron()).toContain(sub.id);
  });

  it("never offers a row the worker refunded, and abandons it", async () => {
    const sub = await staleSubmission("failed", SUBMISSION_RETRY_BUDGET);
    await prisma.payoutJob.create({ data: { type: "SUBMISSION_PAYOUT", submissionId: sub.id, status: "failed" } });
    expect(await runCron()).not.toContain(sub.id);
    const row = await prisma.submission.findUniqueOrThrow({ where: { id: sub.id } });
    expect(row.payoutStatus).toBe("abandoned");
  });
});
