// Stamps (#202). Pure, like tiers.ts, so the Progress screen reads the same
// definitions the server awards from. A stamp is a keepsake: it never pays and
// never opens a task.
//
// Four of the fourteen aren't counted from stats (#203): the Event slot, filled
// by an event code; the two invite stamps, awarded when an invited friend
// reaches Skilled; and the weekly Top 3, awarded when a week's board closes. Each
// code also has a stamp of its own, `event:<codeId>`, held beside the slot
// (lib/gamification/events.ts), so the count grows with every event.

export const STAMP_RULES = {
  sharpEyeRun: 10,
  inStepMatches: 25,
  allRounderCategories: 6,
  /** The live pool has 31 health tasks (12 Oct), and each is answered once. */
  healthAnswers: 25,
  /** The task category the Health specialist stamp counts. */
  healthCategory: "health",
} as const;

export interface StampStats {
  /** Accepted answers and passed quality checks, retest excluded. */
  answers: number;
  /** Answers whose payout has settled. */
  payouts: number;
  bestStreak: number;
  /** Quality checks passed in a row, most recent first, retest excluded. */
  checkRun: number;
  /** Answers that matched the crowd on resolved, non-tie tasks. */
  crowdMatches: number;
  /** Distinct task categories among accepted answers. */
  categories: number;
  healthAnswers: number;
}

export interface StampDef {
  id: string;
  title: string;
  /** Material Symbols name. */
  icon: string;
  criteria: string;
  /** The stat it counts and the target; null for a stamp awarded by its own hook. */
  goal: { stat: keyof StampStats; target: number } | null;
  /** False until the issue that awards it lands. */
  earnable: boolean;
}

function counted(id: string, title: string, icon: string, criteria: string, stat: keyof StampStats, target: number): StampDef {
  return { id, title, icon, criteria, goal: { stat, target }, earnable: true };
}

export const STAMPS: readonly StampDef[] = [
  counted("first-answer", "First answer", "flag", "Get your first answer accepted.", "answers", 1),
  counted("first-payout", "First payout", "payments", "Receive your first payout.", "payouts", 1),
  counted("answers-50", "50 answers", "task_alt", "Get 50 answers accepted.", "answers", 50),
  counted("answers-250", "250 answers", "workspace_premium", "Get 250 answers accepted.", "answers", 250),
  counted("streak-7", "7-day streak", "event_available", "Meet your daily goal 7 days in a row.", "bestStreak", 7),
  counted("streak-30", "30-day streak", "date_range", "Meet your daily goal 30 days in a row.", "bestStreak", 30),
  counted(
    "sharp-eye",
    "Sharp eye",
    "visibility",
    `Pass ${STAMP_RULES.sharpEyeRun} quality checks in a row.`,
    "checkRun",
    STAMP_RULES.sharpEyeRun,
  ),
  counted(
    "in-step",
    "In step",
    "groups",
    `Match the crowd on ${STAMP_RULES.inStepMatches} answers.`,
    "crowdMatches",
    STAMP_RULES.inStepMatches,
  ),
  counted(
    "all-rounder",
    "All-rounder",
    "category",
    `Answer tasks in ${STAMP_RULES.allRounderCategories} categories.`,
    "categories",
    STAMP_RULES.allRounderCategories,
  ),
  counted(
    "health-specialist",
    "Health specialist",
    "stethoscope",
    `Answer ${STAMP_RULES.healthAnswers} health tasks.`,
    "healthAnswers",
    STAMP_RULES.healthAnswers,
  ),
  {
    id: "event",
    title: "Event",
    icon: "festival",
    criteria: "Add a code from a Centient event.",
    goal: null,
    earnable: true,
  },
  {
    id: "invited-in",
    title: "Invited in",
    icon: "waving_hand",
    criteria: "Join through a friend's invite and reach Skilled.",
    goal: null,
    earnable: true,
  },
  {
    id: "brought-a-friend",
    title: "Brought a friend",
    icon: "group_add",
    criteria: "Invite a friend who reaches Skilled.",
    goal: null,
    earnable: true,
  },
  {
    id: "top-3-week",
    title: "Top 3 of the week",
    icon: "trophy",
    criteria: "Finish a week in the top 3 of the board.",
    goal: null,
    earnable: true,
  },
];

export function stampProgress(def: StampDef, stats: StampStats): { current: number; target: number } | null {
  if (!def.goal) return null;
  return { current: Math.min(stats[def.goal.stat], def.goal.target), target: def.goal.target };
}

/** Stamps reached and not yet held, in definition order. */
export function newlyEarned(stats: StampStats, held: ReadonlySet<string>): string[] {
  return STAMPS.filter((s) => s.earnable && s.goal && !held.has(s.id) && stats[s.goal.stat] >= s.goal.target).map(
    (s) => s.id,
  );
}
