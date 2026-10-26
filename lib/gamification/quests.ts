// Weekly quests (#203, ADR-0012). Pure, so the This week tab reads the same
// definitions the server awards from. Three small goals each Manila week, XP
// only, fixed for v1. A quest is labor, so its XP counts on the board.

export const QUEST_XP = 30;

export interface QuestStats {
  /** Accepted health answers this week. */
  healthAnswers: number;
  /** Quality checks passed this week, retest excluded. */
  checksPassed: number;
  /** Days this week the daily goal was met. */
  goalDays: number;
}

export interface QuestDef {
  id: string;
  title: string;
  /** Material Symbols name. */
  icon: string;
  stat: keyof QuestStats;
  target: number;
}

export const QUESTS: readonly QuestDef[] = [
  { id: "health-5", title: "Answer 5 health tasks", icon: "stethoscope", stat: "healthAnswers", target: 5 },
  { id: "checks-3", title: "Pass 3 quality checks", icon: "visibility", stat: "checksPassed", target: 3 },
  { id: "goal-days-4", title: "Meet the daily goal on 4 days", icon: "event_available", stat: "goalDays", target: 4 },
];

export interface QuestStatus {
  id: string;
  title: string;
  icon: string;
  current: number;
  target: number;
  xp: number;
  /** Awarded this week. */
  done: boolean;
}

export function questProgress(stats: QuestStats, awarded: ReadonlySet<string>): QuestStatus[] {
  return QUESTS.map((q) => ({
    id: q.id,
    title: q.title,
    icon: q.icon,
    current: Math.min(stats[q.stat], q.target),
    target: q.target,
    xp: QUEST_XP,
    done: awarded.has(q.id),
  }));
}

/** Quests reached this week and not yet awarded, in definition order. */
export function newlyComplete(stats: QuestStats, awarded: ReadonlySet<string>): string[] {
  return QUESTS.filter((q) => !awarded.has(q.id) && stats[q.stat] >= q.target).map((q) => q.id);
}
