import { track } from "@/lib/analytics";
import type { Progress } from "./types";

/**
 * #201: PostHog events for one answer's `progress` block. Counts and kinds
 * only: no wallet, no task text. The server settles each award once, so each
 * event fires once.
 */
export function trackProgress(progress: Progress): void {
  for (const line of progress.lines) {
    track("xp_awarded", { kind: line.kind, amount: line.amount });
  }
  if (progress.streak.endedAtDays !== null) {
    track("streak_ended", { ended_at_days: progress.streak.endedAtDays });
  }
  for (let i = 0; i < progress.streak.restUsed; i++) track("rest_day_used");
  if (progress.today.goalJustMet) {
    track("daily_goal_met", { streak_days: progress.streak.days });
    // A streak of 1 has just started, not been extended.
    if (progress.streak.days > 1) track("streak_extended", { streak_days: progress.streak.days });
  }
}
