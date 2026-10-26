import { describe, it, expect } from "vitest";
import { newlyComplete, QUEST_XP, QUESTS, questProgress, type QuestStats } from "../quests";

const zero: QuestStats = { healthAnswers: 0, checksPassed: 0, goalDays: 0 };

describe("QUESTS", () => {
  it("are the three fixed v1 quests, 30 XP each", () => {
    expect(QUESTS.map((q) => [q.id, q.title, q.target])).toEqual([
      ["health-5", "Answer 5 health tasks", 5],
      ["checks-3", "Pass 3 quality checks", 3],
      ["goal-days-4", "Meet the daily goal on 4 days", 4],
    ]);
    expect(QUEST_XP).toBe(30);
  });
});

describe("questProgress", () => {
  it("counts toward each target, capped, and marks the awarded ones done", () => {
    const view = questProgress({ healthAnswers: 7, checksPassed: 1, goalDays: 4 }, new Set(["health-5"]));
    expect(view).toEqual([
      { id: "health-5", title: "Answer 5 health tasks", icon: "stethoscope", current: 5, target: 5, xp: 30, done: true },
      { id: "checks-3", title: "Pass 3 quality checks", icon: "visibility", current: 1, target: 3, xp: 30, done: false },
      { id: "goal-days-4", title: "Meet the daily goal on 4 days", icon: "event_available", current: 4, target: 4, xp: 30, done: false },
    ]);
  });
});

describe("newlyComplete", () => {
  it("returns nothing for a new week", () => {
    expect(newlyComplete(zero, new Set())).toEqual([]);
  });

  it("returns each quest reached and not yet awarded", () => {
    expect(newlyComplete({ healthAnswers: 5, checksPassed: 3, goalDays: 3 }, new Set(["checks-3"]))).toEqual(["health-5"]);
  });

  it("holds a quest back one short", () => {
    expect(newlyComplete({ healthAnswers: 4, checksPassed: 2, goalDays: 3 }, new Set())).toEqual([]);
  });
});
