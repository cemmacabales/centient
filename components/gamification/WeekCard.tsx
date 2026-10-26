import type { ProgressSummary, WeekDayStatus } from "@/lib/gamification/types";
import { DAILY_GOAL } from "@/lib/gamification/types";
import { restLine, todayLine, weekdayInitial, weekdayName } from "./format";

const STATUS_LABEL: Record<WeekDayStatus, string> = {
  met: "goal met",
  rest: "covered by a rest day",
  protected: "no tasks were open",
  today: "today",
  missed: "missed",
  open: "not yet",
};

function Disc({ status, counted }: { status: WeekDayStatus; counted: number }) {
  if (status === "met") {
    return (
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-tertiary">
        <span className="material-symbols-outlined text-[18px] text-on-tertiary" aria-hidden="true">
          check
        </span>
      </span>
    );
  }
  if (status === "today") {
    return (
      <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-tertiary bg-tertiary-fixed font-headline text-[11px] font-extrabold tabular-nums text-on-tertiary-fixed-variant">
        {Math.min(counted, DAILY_GOAL)}/{DAILY_GOAL}
      </span>
    );
  }
  if (status === "rest") {
    return (
      <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-dashed border-tertiary bg-tertiary-fixed">
        <span className="material-symbols-outlined text-[16px] text-on-tertiary-fixed-variant" aria-hidden="true">
          bedtime
        </span>
      </span>
    );
  }
  return <span className="h-9 w-9 rounded-full border-[1.5px] border-outline-variant" />;
}

/** The most recent day this week a rest day covered, before today. */
function lastRestDay(week: ProgressSummary["week"]): string | null {
  const rest = week.filter((d) => d.status === "rest");
  return rest.length ? rest[rest.length - 1].dayKey : null;
}

/** Home's week, Monday to Sunday in Manila time, with today's tally (#201, board 03). */
export default function WeekCard({ progress }: { progress: ProgressSummary }) {
  const { week, today, streak } = progress;
  const ended = streak.endedAtDays !== null && !today.goalMet;
  const restDay = ended ? null : lastRestDay(week);
  const filled = Math.min(today.counted, DAILY_GOAL);

  return (
    <section
      aria-labelledby="week-heading"
      className="flex w-full flex-col gap-3.5 rounded-3xl bg-surface-container-lowest p-5 shadow-[0_8px_24px_rgba(25,28,30,0.06)]"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="week-heading" className="font-headline text-base font-bold text-on-surface">
          This week
        </h2>
        {streak.days > 0 && (
          <span className="font-headline text-base font-extrabold tracking-tight text-tertiary">
            {streak.days}-day streak
          </span>
        )}
      </div>

      <ol className="grid grid-cols-7 gap-1">
        {week.map((d) => {
          const isToday = d.dayKey === today.dayKey;
          return (
            <li
              key={d.dayKey}
              aria-label={`${weekdayName(d.dayKey)}: ${STATUS_LABEL[d.status]}`}
              className="flex flex-col items-center gap-1.5"
            >
              <Disc status={d.status} counted={today.counted} />
              <span
                aria-hidden="true"
                className={`font-label text-[11px] ${
                  isToday ? "font-extrabold text-tertiary" : d.status === "open" ? "font-semibold text-outline" : "font-semibold text-on-surface-variant"
                }`}
              >
                {weekdayInitial(d.dayKey)}
              </span>
            </li>
          );
        })}
      </ol>

      {ended ? (
        <div className="flex flex-col gap-1 pt-0.5">
          <p className="font-headline text-base font-bold text-on-surface">
            Your streak ended at {streak.endedAtDays} days.
          </p>
          <p className="font-body text-[13px] leading-[19px] text-on-surface-variant">
            Meet today&apos;s goal to start a new one. Your XP doesn&apos;t change.
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-2.5 pt-0.5">
          <div aria-hidden="true" className="flex gap-1">
            {Array.from({ length: DAILY_GOAL }, (_, i) => (
              <span key={i} className={`h-4 w-1 rounded-sm ${i < filled ? "bg-tertiary" : "bg-outline-variant"}`} />
            ))}
          </div>
          <span className="flex-1 font-body text-[13px] leading-[18px] text-on-surface-variant">
            {todayLine(today.counted, today.goalMet, streak.days)}
          </span>
          <span className="whitespace-nowrap font-label text-xs font-semibold text-on-surface-variant">
            {restLine(streak.restDays, streak.days)}
          </span>
        </div>
      )}

      {restDay && (
        <p className="flex items-start gap-2 font-body text-[13px] leading-[19px] text-on-surface-variant">
          <span className="material-symbols-outlined pt-px text-[16px] text-tertiary" aria-hidden="true">
            bedtime
          </span>
          You missed {weekdayName(restDay)}, so a rest day covered it. Your streak is {streak.days}{" "}
          {streak.days === 1 ? "day" : "days"}.
        </p>
      )}
    </section>
  );
}
