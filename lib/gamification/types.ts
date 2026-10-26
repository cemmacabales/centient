// Shapes the XP loop's API returns (#201). Kept free of server imports so client
// components can use them.

import type { QuestStatus } from "./quests";

export const DAILY_GOAL = 5;

export type XpKindName =
  | "ANSWER"
  | "QUALITY_CHECK"
  | "DAILY_GOAL"
  | "STREAK_MILESTONE"
  | "CROWD_MATCH"
  | "EVENT_CODE"
  | "QUEST"
  | "INVITE";

export interface ProgressLine {
  kind: XpKindName;
  amount: number;
  /** #203: the quest a QUEST line completed. */
  quest?: string;
}

/** The `progress` block on an accepted or quality-check-passed submit response. */
export interface Progress {
  lines: ProgressLine[];
  xpGained: number;
  xpTotal: number;
  today: { counted: number; goal: typeof DAILY_GOAL; goalMet: boolean; goalJustMet: boolean };
  streak: {
    days: number;
    best: number;
    restDays: number;
    restEarned: boolean;
    /** Rest days spent covering missed days when today's goal settled the streak. */
    restUsed: number;
    /** Set once, when today's goal starts a new streak after one ended. */
    endedAtDays: number | null;
  };
  /** #202: the labeler's tier after this answer; `tierUp` is set once, on the answer that opened it. */
  tier: TierStatus;
  /** #202: stamps this answer earned. */
  stampsAwarded: string[];
}

export interface TierStatus {
  tier: number;
  onHold: boolean;
  tierUp: number | null;
  /** Passes in a row since a hold began. */
  holdChecksPassed: number;
}

export type WeekDayStatus = "met" | "rest" | "protected" | "today" | "missed" | "open";

/** `GET /api/me/progress`. */
export interface ProgressSummary {
  xpTotal: number;
  xpThisWeek: number;
  today: { dayKey: string; counted: number; goal: typeof DAILY_GOAL; goalMet: boolean };
  week: { dayKey: string; status: WeekDayStatus }[];
  /** `days` is the effective streak: one whose gap can't be covered reads as ended. */
  streak: { days: number; best: number; restDays: number; endedAtDays: number | null };
}

/** #202: the tier card on Home and Progress. */
export interface TierSummary {
  tier: number;
  name: string;
  onHold: boolean;
  holdChecksPassed: number;
  /** Passes in a row that reopen a held tier. */
  reopenAfter: number;
  checks: { passed: number; total: number };
  crowd: { matched: number; total: number };
  activeDays: number;
  answers: number;
  /** The band this tier opened: what the tier-up screen lists. Null for Starter. */
  band: TierBand | null;
  next: {
    tier: number;
    name: string;
    xp: number;
    xpToGo: number;
    /** The most a task in the next tier's band pays, in USDC; null when none is open. */
    payUpTo: string | null;
  } | null;
}

export interface TierBand {
  /** "4–5". */
  difficulty: string;
  /** Live tasks in the band this labeler hasn't answered. */
  tasks: number;
  /** USDC range, e.g. "0.4" and "1.15"; null when none is open. */
  payFrom: string | null;
  payTo: string | null;
  /** "15" or "15–20". */
  xp: string;
}

/** #202: one stamp on Progress. Titles and criteria come from lib/gamification/stamps. */
export interface StampStatus {
  id: string;
  awardedAt: string | null;
  progress: { current: number; target: number } | null;
  /** #203: an event code's own stamp, `event:<codeId>`, carries its title and icon. */
  event?: { title: string; icon: string };
}

/** #202: added to `GET /api/me/progress`. */
export interface StandingSummary {
  tier: TierSummary;
  stamps: StampStatus[];
}

/** #203: where the labeler stands on this week's board, for Home's "You're #N". */
export interface BoardStanding {
  /** Null when the labeler doesn't place this week. */
  rank: number | null;
  xp: number;
  /** False when this week's quality checks are under the floor. */
  placed: boolean;
  /** The best place they finished a closed week. */
  bestRank: number | null;
}

/** #203: the invite card. `qualified` counts the friends who paid the inviter off. */
export interface InviteStanding {
  code: string;
  qualified: number;
  cap: number;
}

/** What `GET /api/me/progress` returns since #203. */
export type ProgressView = ProgressSummary &
  StandingSummary & { board: BoardStanding; quests: QuestStatus[]; invite: InviteStanding };

/** #203: one row of the weekly board. No wallet, no earnings, no id. */
export interface BoardRow {
  rank: number;
  /** Null shows as "Hidden labeler". */
  name: string | null;
  tier: number;
  xp: number;
  you: boolean;
}

/** #203: `GET /api/leaderboard`. */
export interface BoardView {
  weekKey: string;
  /** The week's Sunday; it ends at 11:59 PM Manila. */
  endsDay: string;
  rows: BoardRow[];
  you: { rank: number | null; xp: number; placed: boolean; inTop: boolean; tier: number; name: string | null };
  settings: { displayName: string | null; showOnBoard: boolean; nameHidden: boolean };
  /** The best place the caller finished a closed week, for "Best: #6". */
  bestRank: number | null;
}
