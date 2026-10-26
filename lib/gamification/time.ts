// Days and weeks for the XP loop are Manila calendar days (#201). A day key is
// "YYYY-MM-DD"; a week key is the day key of that week's Monday. Asia/Manila
// has no DST, but the zone is read from GAMIFICATION_TZ so tests can pin it.

const DEFAULT_TZ = "Asia/Manila";
const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function zone(): string {
  return process.env.GAMIFICATION_TZ || DEFAULT_TZ;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // en-CA formats a date as YYYY-MM-DD.
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, f);
  }
  return f;
}

function toUtcMs(dayKey: string): number {
  return Date.parse(`${dayKey}T00:00:00Z`);
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function manilaDayKey(at: Date = new Date()): string {
  return formatter(zone()).format(at);
}

export function manilaWeekKey(at: Date = new Date()): string {
  return weekKeyOf(manilaDayKey(at));
}

/** Monday of the week that holds `dayKey`. */
export function weekKeyOf(dayKey: string): string {
  const mondayOffset = (new Date(toUtcMs(dayKey)).getUTCDay() + 6) % 7;
  return addDays(dayKey, -mondayOffset);
}

export function addDays(dayKey: string, n: number): string {
  return fromUtcMs(toUtcMs(dayKey) + n * DAY_MS);
}

/** Day keys strictly after `from` and strictly before `to`. */
export function dayKeysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = addDays(from, 1); d < to; d = addDays(d, 1)) days.push(d);
  return days;
}

/** Monday through Sunday of the week starting `weekKey`. */
export function weekDayKeys(weekKey: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekKey, i));
}

/** A real calendar day written as a day key. */
export function isDayKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = toUtcMs(value);
  return !Number.isNaN(ms) && fromUtcMs(ms) === value;
}

/**
 * The instant a Manila day begins (#203): the board counts a week's quality
 * checks by their time, since a failed check has no XP row to carry a week key.
 */
export function dayStartUtc(dayKey: string): Date {
  const guess = toUtcMs(dayKey);
  const wall = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone(),
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(guess));
  const part = (type: string) => wall.find((p) => p.type === type)?.value ?? "00";
  const wallMs = Date.parse(`${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:00Z`);
  return new Date(guess - (wallMs - guess));
}
