import { describe, it, expect } from "vitest";
import { BOARD_RULES, boardFor, placesOnBoard, publicName, rankWeek, type WeekEntry } from "../board";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 12, 2, minute));

function entry(userId: string, xp: number, over: Partial<WeekEntry> = {}): WeekEntry {
  return { userId, xp, reachedAt: at(0), checks: { passed: 0, total: 0 }, ...over };
}

describe("placesOnBoard", () => {
  it(`lets XP alone place under ${BOARD_RULES.minChecks} checks that week`, () => {
    expect(placesOnBoard({ passed: 0, total: 0 })).toBe(true);
    expect(placesOnBoard({ passed: 0, total: 2 })).toBe(true);
  });

  it(`needs ${BOARD_RULES.checkFloor * 100}% from ${BOARD_RULES.minChecks} checks`, () => {
    expect(placesOnBoard({ passed: 2, total: 3 })).toBe(false);
    expect(placesOnBoard({ passed: 3, total: 3 })).toBe(true);
    expect(placesOnBoard({ passed: 4, total: 5 })).toBe(true);
    expect(placesOnBoard({ passed: 7, total: 9 })).toBe(false);
  });
});

describe("rankWeek", () => {
  it("ranks by XP, highest first", () => {
    const ranked = rankWeek([entry("a", 120), entry("b", 340), entry("c", 205)]);
    expect(ranked.map((r) => [r.rank, r.userId])).toEqual([
      [1, "b"],
      [2, "c"],
      [3, "a"],
    ]);
  });

  it("breaks a tie for whoever reached the total first", () => {
    const ranked = rankWeek([
      entry("late", 300, { reachedAt: at(30) }),
      entry("early", 300, { reachedAt: at(10) }),
    ]);
    expect(ranked.map((r) => r.userId)).toEqual(["early", "late"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2]);
  });

  it("orders a full tie by id, so the order never flips between reads", () => {
    const ranked = rankWeek([entry("b", 50), entry("a", 50)]);
    expect(ranked.map((r) => r.userId)).toEqual(["a", "b"]);
  });

  it("leaves out anyone under the quality floor, and ranks the rest without a gap", () => {
    const ranked = rankWeek([
      entry("sloppy", 900, { checks: { passed: 1, total: 4 } }),
      entry("careful", 400, { checks: { passed: 4, total: 4 } }),
      entry("new", 100),
    ]);
    expect(ranked.map((r) => [r.rank, r.userId])).toEqual([
      [1, "careful"],
      [2, "new"],
    ]);
  });

  it("leaves out anyone with no XP that week", () => {
    expect(rankWeek([entry("idle", 0)])).toEqual([]);
  });
});

describe("boardFor", () => {
  const many = Array.from({ length: 30 }, (_, i) => entry(`u${String(i).padStart(2, "0")}`, 1000 - i * 10));

  it(`shows the top ${BOARD_RULES.size} and the caller's own row below them`, () => {
    const board = boardFor(rankWeek(many), "u24");
    expect(board.top).toHaveLength(BOARD_RULES.size);
    expect(board.top.at(-1)?.rank).toBe(20);
    expect(board.you).toMatchObject({ userId: "u24", rank: 25, xp: 760, placed: true });
    expect(board.youInTop).toBe(false);
  });

  it("marks the caller inside the top rows", () => {
    const board = boardFor(rankWeek(many), "u05");
    expect(board.you).toMatchObject({ rank: 6 });
    expect(board.youInTop).toBe(true);
  });

  it("gives an unplaced caller their XP and no rank", () => {
    const entries = [...many, entry("sloppy", 2000, { checks: { passed: 0, total: 3 } })];
    const board = boardFor(rankWeek(entries), "sloppy", entries);
    expect(board.you).toEqual({ userId: "sloppy", rank: null, xp: 2000, placed: false });
    expect(board.top.some((r) => r.userId === "sloppy")).toBe(false);
  });

  it("gives a caller with no XP this week a zero row", () => {
    const board = boardFor(rankWeek(many), "nobody", many);
    expect(board.you).toEqual({ userId: "nobody", rank: null, xp: 0, placed: true });
  });
});

describe("publicName", () => {
  const named = { displayName: "tala.labels", showOnBoard: true, displayNameHiddenAt: null };

  it("shows a name only when the labeler opted in", () => {
    expect(publicName(named)).toBe("tala.labels");
    expect(publicName({ ...named, showOnBoard: false })).toBeNull();
  });

  it("never shows a name an admin hid, or one that isn't set", () => {
    expect(publicName({ ...named, displayNameHiddenAt: new Date() })).toBeNull();
    expect(publicName({ ...named, displayName: null })).toBeNull();
  });
});
