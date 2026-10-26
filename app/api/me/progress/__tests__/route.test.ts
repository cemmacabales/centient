// #201 — GET /api/me/progress: the labeler's XP, today and Manila week.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/me/progress/route";
import { signLabelerJWT } from "@/lib/labeler-auth";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createUser } from "@/tests/helpers/factories";

// Thursday 15 Oct 2026, 10:00 Manila.
const THU = new Date("2026-10-15T02:00:00Z");

beforeEach(async () => {
  await truncateAll();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(THU);
});

afterEach(() => {
  vi.useRealTimers();
});

async function getAs(userId?: string) {
  const headers: Record<string, string> = {};
  if (userId) headers.cookie = `labeler_session=${await signLabelerJWT(userId)}`;
  return GET(new NextRequest("http://localhost/api/me/progress", { method: "GET", headers }));
}

describe("GET /api/me/progress", () => {
  it("returns 401 without a session", async () => {
    const res = await getAs();
    expect(res.status).toBe(401);
  });

  it("returns 401 when the session user no longer exists", async () => {
    const res = await getAs("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(401);
  });

  it("returns a seeded week, Monday to Sunday in Manila time", async () => {
    const user = await createUser();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        createdAt: new Date("2026-10-01T02:00:00Z"),
        xp: 400,
        streakDays: 6,
        bestStreak: 9,
        restDays: 1,
        lastGoalDay: "2026-10-13",
      },
    });
    await prisma.dailyProgress.createMany({
      data: [
        { userId: user.id, dayKey: "2026-10-12", counted: 5, goalMet: true },
        { userId: user.id, dayKey: "2026-10-13", counted: 6, goalMet: true },
        { userId: user.id, dayKey: "2026-10-15", counted: 3 },
      ],
    });
    await prisma.xpEvent.createMany({
      data: [
        { userId: user.id, kind: "ANSWER", amount: 15, dedupeKey: "answer:a", dayKey: "2026-10-11", weekKey: "2026-10-05" },
        { userId: user.id, kind: "ANSWER", amount: 20, dedupeKey: "answer:b", dayKey: "2026-10-12", weekKey: "2026-10-12" },
        { userId: user.id, kind: "DAILY_GOAL", amount: 20, dedupeKey: "goal:c", dayKey: "2026-10-12", weekKey: "2026-10-12" },
      ],
    });

    const res = await getAs(user.id);
    expect(res.status).toBe(200);
    // #202 adds the tier and stamps beside these: see standing.test.ts.
    expect(await res.json()).toMatchObject({
      xpTotal: 400,
      xpThisWeek: 40,
      today: { dayKey: "2026-10-15", counted: 3, goal: 5, goalMet: false },
      week: [
        { dayKey: "2026-10-12", status: "met" },
        { dayKey: "2026-10-13", status: "met" },
        { dayKey: "2026-10-14", status: "rest" },
        { dayKey: "2026-10-15", status: "today" },
        { dayKey: "2026-10-16", status: "open" },
        { dayKey: "2026-10-17", status: "open" },
        { dayKey: "2026-10-18", status: "open" },
      ],
      streak: { days: 6, best: 9, restDays: 0, endedAtDays: null },
    });
  });
});
