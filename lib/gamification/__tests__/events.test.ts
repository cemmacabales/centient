import { describe, it, expect } from "vitest";
import {
  codeWindow,
  eventCodeIdOf,
  EVENT_ICONS,
  EVENT_RULES,
  eventStampId,
  isEventStampId,
  normalizeCode,
  validateEventCode,
} from "../events";

describe("normalizeCode", () => {
  it("matches case-insensitively and ignores spaces around it", () => {
    expect(normalizeCode(" webinar1 ")).toBe("WEBINAR1");
    expect(normalizeCode("BQF2026")).toBe("BQF2026");
  });

  it.each(["", "abc", "A".repeat(EVENT_RULES.codeMax + 1), "WEB INAR", "WEB-1", "ÑAÑA", undefined, 7])(
    "refuses anything that can't be a code: %j",
    (raw) => {
      expect(normalizeCode(raw)).toBeNull();
    },
  );
});

describe("codeWindow", () => {
  const webinar = { startsDay: "2026-10-15", endsDay: "2026-10-16" };

  it("is open on its first and last Manila day, inclusive", () => {
    expect(codeWindow(webinar, "2026-10-15")).toBe("open");
    expect(codeWindow(webinar, "2026-10-16")).toBe("open");
  });

  it("is closed the day before and the day after", () => {
    expect(codeWindow(webinar, "2026-10-14")).toBe("before");
    expect(codeWindow(webinar, "2026-10-17")).toBe("after");
  });

  it("can run a single day", () => {
    expect(codeWindow({ startsDay: "2026-10-15", endsDay: "2026-10-15" }, "2026-10-15")).toBe("open");
  });
});

describe("event stamp ids", () => {
  it("names each code's stamp after the code row", () => {
    expect(eventStampId("abc")).toBe("event:abc");
    expect(isEventStampId("event:abc")).toBe(true);
    expect(isEventStampId("event")).toBe(false);
    expect(isEventStampId("first-answer")).toBe(false);
    expect(eventCodeIdOf(eventStampId("abc"))).toBe("abc");
  });
});

describe("validateEventCode", () => {
  const good = {
    code: "webinar1",
    stampTitle: " Contributor webinar ",
    stampIcon: "podcasts",
    startsDay: "2026-10-15",
    endsDay: "2026-10-16",
  };

  it("accepts a code and normalises it", () => {
    expect(validateEventCode(good)).toEqual({
      ok: true,
      value: { ...good, code: "WEBINAR1", stampTitle: "Contributor webinar" },
    });
  });

  it("accepts past dates, so an event can be recorded after it ran", () => {
    expect(validateEventCode({ ...good, code: "BQF2026", startsDay: "2026-10-10", endsDay: "2026-10-12" })).toMatchObject({
      ok: true,
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["code", { code: "a b" }],
    ["stampTitle", { stampTitle: "ab" }],
    ["stampTitle", { stampTitle: "x".repeat(EVENT_RULES.titleMax + 1) }],
    ["stampIcon", { stampIcon: "skull" }],
    ["startsDay", { startsDay: "2026-13-01" }],
    ["startsDay", { startsDay: "15 Oct" }],
    ["endsDay", { endsDay: "2026-02-30" }],
    ["endsDay", { endsDay: "2026-10-14" }],
    ["endsDay", { endsDay: "2026-11-30" }],
  ])("refuses a bad %s", (field, over) => {
    expect(validateEventCode({ ...good, ...over })).toEqual({ ok: false, field });
  });

  it("refuses a body that isn't an object", () => {
    expect(validateEventCode(null)).toEqual({ ok: false, field: "code" });
  });

  it("offers only icons from the allow-list", () => {
    expect(EVENT_ICONS).toContain("festival");
    expect(EVENT_ICONS).toContain(good.stampIcon);
  });
});
