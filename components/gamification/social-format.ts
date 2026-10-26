// #203: the board, name, event-code, quest and invite copy, kept apart so it
// reads as one voice and is tested on its own. Never blame, never red.
import { NAME_RULES, type NameRejection } from "@/lib/gamification/names";
import { BOARD_RULES } from "@/lib/gamification/board";
import { TIERS } from "@/lib/gamification/tiers";
import { QUEST_XP, type QuestStatus } from "@/lib/gamification/quests";
import { INVITE_RULES } from "@/lib/gamification/invite-rules";
import type { RedeemError } from "@/lib/gamification/redeem-types";
import type { BoardRow } from "@/lib/gamification/types";

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const WEEKDAY_DAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const at = (dayKey: string) => new Date(`${dayKey}T00:00:00Z`);

export function weekHeading(weekKey: string): string {
  return `Week of ${DAY.format(at(weekKey))}`;
}

export function endsLine(endsDay: string): string {
  return `Ends ${WEEKDAY_DAY.format(at(endsDay)).replace(",", "")}, 11:59 PM PHT.`;
}

/** An event's days: "10–12 Oct", "15 Oct", or "30 Oct – 2 Nov". */
export function dayRange(startsDay: string, endsDay: string): string {
  if (startsDay === endsDay) return DAY.format(at(startsDay));
  if (startsDay.slice(0, 7) === endsDay.slice(0, 7)) {
    return `${Number(startsDay.slice(8))}\u2013${DAY.format(at(endsDay))}`;
  }
  return `${DAY.format(at(startsDay))} \u2013 ${DAY.format(at(endsDay))}`;
}

/** Days left in the week, today included. */
export function daysLeft(endsDay: string, today: string): string {
  const n = Math.round((at(endsDay).getTime() - at(today).getTime()) / 86_400_000) + 1;
  return n <= 1 ? "Last day" : `${n} days left`;
}

const CHIPS = [
  "bg-tertiary-fixed text-on-tertiary-fixed-variant",
  "bg-tertiary-container text-on-tertiary-fixed",
  "bg-tertiary text-on-tertiary",
  "bg-on-tertiary-fixed text-on-tertiary",
];

/** A tier as a small pill on the board: the indigo ramp, palest to darkest. */
export function tierChip(tier: number): { name: string; className: string } {
  return { name: TIERS[tier]?.name ?? TIERS[0].name, className: CHIPS[tier] ?? CHIPS[0] };
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

export function boardRowLabel(row: BoardRow): string {
  const who = [row.name ?? "Hidden labeler", ...(row.you ? ["you"] : [])].join(", ");
  return `${ordinal(row.rank)}, ${who}, ${tierChip(row.tier).name}, ${row.xp} XP`;
}

export const BOARD_NOTE = `Ranked by XP earned Monday to Sunday, Philippine time. To place, keep quality checks at ${
  BOARD_RULES.checkFloor * 100
}% or higher this week. No wallets or earnings are shown. The top ${BOARD_RULES.stamped} each week get a stamp.`;

export function notPlacedLine(xp: number): string {
  return `Your quality checks are under ${BOARD_RULES.checkFloor * 100}% this week, so you're not on the board yet. Your ${xp} XP still counts toward your tier.`;
}

export type RedeemFailure = RedeemError | "network";

const REDEEM: Record<RedeemFailure, string> = {
  unknown_code: "That code doesn't match an event. Check it and try again.",
  not_open: "This code opens on its event day.",
  ended: "This event's code has closed.",
  already_redeemed: "You've already added this code.",
  wallet_required: "Sign in with your wallet to add a code.",
  banned: "Codes can't be added while your account is paused.",
  rate_limited: "Too many tries. Wait a little, then try again.",
  network: "Couldn't add the code. Check your connection and try again.",
};

export function redeemError(error: RedeemFailure): string {
  return REDEEM[error] ?? REDEEM.network;
}

export type NameFailure = NameRejection | "name_taken" | "name_retired" | "name_required" | "invalid" | "network";

const NAME: Record<NameFailure, string> = {
  too_short: `Use ${NAME_RULES.min} to ${NAME_RULES.max} characters.`,
  too_long: `Use ${NAME_RULES.min} to ${NAME_RULES.max} characters.`,
  bad_chars: "Use letters, numbers, dots and underscores.",
  bad_start: "Start with a letter.",
  not_allowed: "That name isn't allowed. Try another.",
  name_taken: "Someone has that name. Try another.",
  name_retired: "That name can't be used again. Try another.",
  name_required: "Choose a name first.",
  invalid: "Couldn't save that. Try again.",
  network: "Couldn't save your name. Check your connection and try again.",
};

export function nameError(error: NameFailure): string {
  return NAME[error] ?? NAME.network;
}

export const QUESTS_NOTE = `${QUEST_XP} XP each. They start over on Monday.`;

/** The value end of a quest's receipt row: "3 / 5", or "+30 XP" once done. */
export function questValue(q: QuestStatus): string {
  return q.done ? `+${q.xp} XP` : `${q.current} / ${q.target}`;
}

export function questLabel(q: QuestStatus): string {
  return q.done ? `${q.title}, done, ${q.xp} XP earned` : `${q.title}, ${q.current} of ${q.target}`;
}

export const INVITE_NOTE = `You both get ${INVITE_RULES.xp} XP and a stamp when they reach ${TIERS[1].name}.`;

export const INVITE_SHARE_TEXT = "Join me on Centient.";

/** The link as it reads on the card: no scheme, so the code shows on a phone. */
export function inviteLinkShown(link: string): string {
  return link.replace(/^https?:\/\//, "");
}

export function inviteCount(qualified: number, cap: number): string {
  return `${Math.min(qualified, cap)} of ${cap}`;
}

/** Past the cap the friend is still rewarded; the inviter isn't (ADR-0012). */
export function inviteCapLine(qualified: number, cap: number): string | null {
  return qualified >= cap ? `You've reached ${cap}. Friends you invite still get their ${INVITE_RULES.xp} XP and stamp.` : null;
}
