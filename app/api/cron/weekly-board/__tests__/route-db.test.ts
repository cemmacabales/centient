// #203 — POST /api/cron/weekly-board: the backstop that closes last week if no
// board read has yet.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/gamification/server-analytics", () => ({ captureStanding: vi.fn(), captureServer: vi.fn() }));

import { POST } from "@/app/api/cron/weekly-board/route";
import { addDays, manilaWeekKey } from "@/lib/gamification/time";
import { prisma, truncateAll } from "@/tests/helpers/db";

const SECRET = "test-cron-secret";
const ORIGINAL = process.env.CRON_SECRET;

beforeEach(async () => {
  await truncateAll();
  process.env.CRON_SECRET = SECRET;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

const call = (auth?: string) =>
  POST(new NextRequest("http://localhost/api/cron/weekly-board", { method: "POST", headers: auth ? { Authorization: auth } : {} }));

describe("POST /api/cron/weekly-board", () => {
  it("needs the cron secret", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect(await prisma.boardWeek.count()).toBe(0);
  });

  it("closes last week once", async () => {
    const lastWeek = addDays(manilaWeekKey(), -7);
    const first = await call(`Bearer ${SECRET}`);
    expect(await first.json()).toEqual({ weekKey: lastWeek, closed: [lastWeek], stamped: 0 });
    const again = await call(`Bearer ${SECRET}`);
    expect(await again.json()).toEqual({ weekKey: lastWeek, closed: [], stamped: 0 });
  });

  it("catches up on weeks missed since the last one closed", async () => {
    const lastWeek = addDays(manilaWeekKey(), -7);
    await prisma.boardWeek.create({ data: { weekKey: addDays(lastWeek, -21) } });
    const res = await call(`Bearer ${SECRET}`);
    expect((await res.json()).closed).toEqual([addDays(lastWeek, -14), addDays(lastWeek, -7), lastWeek]);
  });
});
