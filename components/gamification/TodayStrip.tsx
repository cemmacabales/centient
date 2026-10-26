import { DAILY_GOAL } from "@/lib/gamification/types";

interface TodayStripProps {
  counted: number;
  streakDays: number;
}

/** Today's goal under the task screen's header, in the header's band (#201, board 04). */
export default function TodayStrip({ counted, streakDays }: TodayStripProps) {
  const filled = Math.min(counted, DAILY_GOAL);
  return (
    <div className="flex flex-col gap-1.5 px-4 pb-3">
      <div className="flex justify-between font-label text-xs leading-4">
        <span className="font-semibold text-on-surface-variant">
          Today {filled} of {DAILY_GOAL}
        </span>
        {streakDays > 0 && <span className="font-bold text-tertiary">{streakDays}-day streak</span>}
      </div>
      <div
        role="progressbar"
        aria-label="Today's goal"
        aria-valuemin={0}
        aria-valuemax={DAILY_GOAL}
        aria-valuenow={filled}
        className="grid grid-cols-5 gap-1"
      >
        {Array.from({ length: DAILY_GOAL }, (_, i) => (
          <span key={i} className={`h-1 rounded-full ${i < filled ? "bg-tertiary" : "bg-outline-variant"}`} />
        ))}
      </div>
    </div>
  );
}
