// #202 — GET /api/me/progress: the tier card and the stamps.
import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/me/progress/route";
import { signLabelerJWT } from "@/lib/labeler-auth";
import { prisma, truncateAll } from "@/tests/helpers/db";
import { createTask, createUser } from "@/tests/helpers/factories";

beforeEach(async () => {
  await truncateAll();
});

async function getAs(userId: string) {
  const res = await GET(
    new NextRequest("http://localhost/api/me/progress", {
      headers: { cookie: `labeler_session=${await signLabelerJWT(userId)}` },
    }),
  );
  expect(res.status).toBe(200);
  return res.json();
}

async function labeler(data: { tier?: number; xp?: number; tierOnHold?: boolean; holdChecksPassed?: number }) {
  const user = await createUser();
  await prisma.user.update({ where: { id: user.id }, data });
  return user.id;
}

async function priced(difficulty: number, rewardUnits: bigint, disabled = false) {
  const t = await createTask({ difficulty });
  await prisma.task.update({ where: { id: t.id }, data: { rewardUnits, disabled } });
}

describe("GET /api/me/progress - tier (#202)", () => {
  it("shows Starter, the XP to Skilled and what Skilled tasks pay up to", async () => {
    await priced(3, 9_000_000n);
    await priced(4, 5_000_000n);
    await priced(5, 14_500_000n);
    await priced(5, 99_000_000n, true);
    await priced(6, 30_000_000n);
    const body = await getAs(await labeler({ xp: 180 }));

    expect(body.tier).toEqual({
      tier: 0,
      name: "Starter",
      onHold: false,
      holdChecksPassed: 0,
      reopenAfter: 3,
      checks: { passed: 0, total: 0 },
      crowd: { matched: 0, total: 0 },
      activeDays: 0,
      answers: 0,
      band: null,
      next: { tier: 1, name: "Skilled", xp: 250, xpToGo: 70, payUpTo: "1.45" },
    });
  });

  it("has no pay line when nothing is open in the next band", async () => {
    const body = await getAs(await labeler({ xp: 0 }));
    expect(body.tier.next.payUpTo).toBeNull();
  });

  it("reports a hold and the passes toward reopening", async () => {
    const body = await getAs(await labeler({ tier: 2, xp: 2000, tierOnHold: true, holdChecksPassed: 1 }));
    expect(body.tier).toMatchObject({ tier: 2, name: "Trusted", onHold: true, holdChecksPassed: 1 });
  });

  it("lists the band a tier opened: unanswered tasks, difficulty, pay and XP", async () => {
    await priced(4, 4_000_000n);
    await priced(5, 11_500_000n);
    await priced(6, 30_000_000n);
    const userId = await labeler({ tier: 1, xp: 300 });
    const answered = await createTask({ difficulty: 5 });
    await prisma.task.update({ where: { id: answered.id }, data: { rewardUnits: 9_000_000n } });
    await prisma.submission.create({
      data: { userId, taskId: answered.id, choice: "A", reason: "A clear and careful answer.", payoutAmountUnits: 1n, payoutStatus: "sent" },
    });
    const body = await getAs(userId);
    expect(body.tier.band).toEqual({ difficulty: "4\u20135", tasks: 2, payFrom: "0.4", payTo: "1.15", xp: "15" });
  });

  it("gives an XP range when the band spans two XP steps", async () => {
    const body = await getAs(await labeler({ tier: 2, xp: 1600 }));
    expect(body.tier.band).toMatchObject({ difficulty: "6\u20137", tasks: 0, payFrom: null, payTo: null, xp: "15\u201320" });
  });

  it("has no next tier at Expert", async () => {
    const body = await getAs(await labeler({ tier: 3, xp: 5000 }));
    expect(body.tier.next).toBeNull();
  });
});

describe("GET /api/me/progress - stamps (#202)", () => {
  it("lists all 14, earned ones with their date and locked ones with progress", async () => {
    const userId = await labeler({});
    const awardedAt = new Date("2026-10-11T03:00:00Z");
    await prisma.userStamp.create({ data: { userId, stampId: "first-answer", awardedAt } });
    await prisma.user.update({ where: { id: userId }, data: { bestStreak: 4 } });

    const { stamps } = await getAs(userId);
    expect(stamps).toHaveLength(14);
    expect(stamps[0]).toEqual({ id: "first-answer", awardedAt: awardedAt.toISOString(), progress: { current: 0, target: 1 } });
    expect(stamps.find((s: { id: string }) => s.id === "streak-7")).toEqual({
      id: "streak-7",
      awardedAt: null,
      progress: { current: 4, target: 7 },
    });
    expect(stamps.find((s: { id: string }) => s.id === "top-3-week")).toEqual({ id: "top-3-week", awardedAt: null, progress: null });
  });
});
