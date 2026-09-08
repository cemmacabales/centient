import { beforeEach, describe, expect, it } from "vitest";
import { getPayoutActivitySince } from "@/lib/payout-cap";
import { prisma, truncateAll } from "@/tests/helpers/db";

beforeEach(async () => {
  await truncateAll();
});

describe("getPayoutActivitySince", () => {
  it("counts only broadcast processing and done withdrawal jobs within the window", async () => {
    const since = new Date("2026-09-07T12:00:00.000Z");
    const recentBroadcast = new Date("2026-09-07T13:00:00.000Z");

    await prisma.payoutJob.createMany({
      data: [
        {
          type: "WITHDRAWAL",
          status: "processing",
          amountUnits: 250_000_000n,
          txHash: "processing-broadcast",
          broadcastAt: recentBroadcast,
        },
        {
          type: "WITHDRAWAL",
          status: "done",
          amountUnits: 500_000_000n,
          txHash: "done-broadcast",
          broadcastAt: recentBroadcast,
        },
        {
          type: "WITHDRAWAL",
          status: "queued",
          amountUnits: 900_000_000n,
          txHash: "queued-broadcast",
          broadcastAt: recentBroadcast,
        },
        {
          type: "WITHDRAWAL",
          status: "failed",
          amountUnits: 1_000_000_000n,
          txHash: "failed-broadcast",
          broadcastAt: recentBroadcast,
        },
        {
          type: "WITHDRAWAL",
          status: "done",
          amountUnits: 2_000_000_000n,
          txHash: "old-broadcast",
          broadcastAt: new Date("2026-09-07T11:59:59.999Z"),
        },
      ],
    });

    await expect(getPayoutActivitySince(since)).resolves.toEqual({
      count: 2,
      volumeUnits: 750_000_000n,
    });
  });
});
