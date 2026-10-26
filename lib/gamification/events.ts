// Event codes (#203, ADR-0012). Pure: the rules for a code, its dates and its
// stamp, shared by the admin form, the labeler's form and the server.
//
// A code gives one stamp of its own and 25 XP, once per account, only on the
// Manila days it runs, both ends included. Codes match case-insensitively.

import { isDayKey, addDays } from "./time";

export const EVENT_CODE_XP = 25;

export const EVENT_RULES = {
  codeMin: 4,
  codeMax: 16,
  titleMin: 3,
  titleMax: 40,
  /** The longest a code can run, in days. */
  maxDays: 31,
  /** Wrong codes a labeler may try per window before they're slowed down. */
  guesses: { max: 10, windowMs: 60 * 60 * 1000 },
} as const;

/** Material Symbols an event stamp can wear. */
export const EVENT_ICONS = [
  "festival",
  "celebration",
  "podcasts",
  "school",
  "groups",
  "rocket_launch",
  "emoji_events",
  "star",
  "storefront",
  "handshake",
] as const;

export type EventIcon = (typeof EVENT_ICONS)[number];

export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  const { codeMin, codeMax } = EVENT_RULES;
  return code.length >= codeMin && code.length <= codeMax && /^[A-Z0-9]+$/.test(code) ? code : null;
}

export type CodeWindow = "before" | "open" | "after";

export function codeWindow(code: { startsDay: string; endsDay: string }, today: string): CodeWindow {
  if (today < code.startsDay) return "before";
  if (today > code.endsDay) return "after";
  return "open";
}

const EVENT_PREFIX = "event:";

/** A code's own stamp, held beside the generic Event slot. */
export function eventStampId(codeId: string): string {
  return EVENT_PREFIX + codeId;
}

export function isEventStampId(stampId: string): boolean {
  return stampId.startsWith(EVENT_PREFIX) && stampId.length > EVENT_PREFIX.length;
}

/** The code row behind an event stamp. */
export function eventCodeIdOf(stampId: string): string {
  return stampId.slice(EVENT_PREFIX.length);
}

export interface EventCodeInput {
  code: string;
  stampTitle: string;
  stampIcon: EventIcon;
  startsDay: string;
  endsDay: string;
}

export type EventCodeField = keyof EventCodeInput;

/** The admin's new code, checked. Past dates are fine: an event can be recorded after it ran. */
export function validateEventCode(body: unknown): { ok: true; value: EventCodeInput } | { ok: false; field: EventCodeField } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const code = normalizeCode(b.code);
  if (!code) return { ok: false, field: "code" };

  const stampTitle = typeof b.stampTitle === "string" ? b.stampTitle.trim() : "";
  if (stampTitle.length < EVENT_RULES.titleMin || stampTitle.length > EVENT_RULES.titleMax) {
    return { ok: false, field: "stampTitle" };
  }

  const stampIcon = b.stampIcon;
  if (!EVENT_ICONS.includes(stampIcon as EventIcon)) return { ok: false, field: "stampIcon" };

  const { startsDay, endsDay } = b;
  if (!isDayKey(startsDay)) return { ok: false, field: "startsDay" };
  if (!isDayKey(endsDay) || endsDay < startsDay || endsDay > addDays(startsDay, EVENT_RULES.maxDays - 1)) {
    return { ok: false, field: "endsDay" };
  }

  return { ok: true, value: { code, stampTitle, stampIcon: stampIcon as EventIcon, startsDay, endsDay } };
}
