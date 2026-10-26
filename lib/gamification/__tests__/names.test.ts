import { describe, it, expect } from "vitest";
import { NAME_RULES, validateDisplayName } from "../names";

describe("validateDisplayName: shape", () => {
  it("accepts a name and stores it lowercase, trimmed", () => {
    expect(validateDisplayName("  Tala.Labels ")).toEqual({ ok: true, name: "tala.labels" });
    expect(validateDisplayName("bea_writes")).toEqual({ ok: true, name: "bea_writes" });
    expect(validateDisplayName("kiko.r2026")).toEqual({ ok: true, name: "kiko.r2026" });
  });

  it(`takes ${NAME_RULES.min} to ${NAME_RULES.max} characters`, () => {
    expect(validateDisplayName("abc")).toMatchObject({ ok: true });
    expect(validateDisplayName("ab")).toEqual({ ok: false, reason: "too_short" });
    expect(validateDisplayName("a".repeat(20))).toMatchObject({ ok: true });
    expect(validateDisplayName("a".repeat(21))).toEqual({ ok: false, reason: "too_long" });
  });

  it("starts with a letter", () => {
    expect(validateDisplayName("1tala")).toEqual({ ok: false, reason: "bad_start" });
    expect(validateDisplayName("_tala")).toEqual({ ok: false, reason: "bad_start" });
    expect(validateDisplayName(".tala")).toEqual({ ok: false, reason: "bad_start" });
  });

  it.each(["tala labels", "tala-labels", "ťala", "tala!", "tala@labels", "ta​la"])(
    "refuses characters outside a-z, 0-9, dot and underscore: %j",
    (raw) => {
      expect(validateDisplayName(raw)).toEqual({ ok: false, reason: "bad_chars" });
    },
  );

  it("refuses a non-string", () => {
    expect(validateDisplayName(undefined)).toEqual({ ok: false, reason: "too_short" });
    expect(validateDisplayName(42)).toEqual({ ok: false, reason: "too_short" });
  });
});

describe("validateDisplayName: filter", () => {
  it.each([
    "admin",
    "centient_team",
    "the.moderator",
    "support1",
    "staff",
    "hidden.labeler",
    "hiddenlabeler",
    "hidden_labeler2",
  ])("reserves names that pass for the team or the board: %s", (raw) => {
    expect(validateDisplayName(raw)).toEqual({ ok: false, reason: "not_allowed" });
  });

  it.each(["fuckthis", "f.u.c.k", "sh1tposter", "putanginamo", "pakyu", "tangina_mo", "kantot99", "nigga", "retarded"])(
    "refuses profanity and slurs, through dots, underscores and digit swaps: %s",
    (raw) => {
      expect(validateDisplayName(raw)).toEqual({ ok: false, reason: "not_allowed" });
    },
  );

  it.each(["gago", "gago123", "puta", "bobo.ako", "tanga", "ass", "dick_", "g4go"])(
    "refuses short words standing on their own: %s",
    (raw) => {
      expect(validateDisplayName(raw)).toEqual({ ok: false, reason: "not_allowed" });
    },
  );

  it.each(["batangas", "reputation", "peacock", "grapes", "assassin", "dickens", "bobby", "tala.labels"])(
    "lets everyday words that only contain a short one through: %s",
    (raw) => {
      expect(validateDisplayName(raw)).toMatchObject({ ok: true });
    },
  );
});
