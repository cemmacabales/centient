import type { QuestStatus } from "@/lib/gamification/quests";
import { QUESTS_NOTE, questLabel, questValue } from "./social-format";

/**
 * #203: this week's three quests on Progress → This week, as receipt rows:
 * the quest, a dotted leader, and how far along it is in indigo, or a check
 * and the XP it paid. Quests are labor, so their XP counts on the board.
 */
export default function QuestCard({ quests }: { quests: QuestStatus[] }) {
  if (quests.length === 0) return null;
  return (
    <section
      aria-labelledby="quests-heading"
      className="flex flex-col gap-3 rounded-2xl bg-surface-container-lowest px-[18px] py-4 shadow-[0_8px_24px_rgba(25,28,30,0.06)]"
    >
      <div className="flex flex-col gap-0.5">
        <h3 id="quests-heading" className="m-0 font-headline text-[15px] font-bold leading-5 text-on-surface">
          This week&apos;s quests
        </h3>
        <p className="m-0 font-body text-[13px] leading-[18px] text-on-surface-variant">{QUESTS_NOTE}</p>
      </div>
      <div aria-hidden="true" className="border-t-[1.5px] border-dashed border-outline-variant" />
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {quests.map((q) => (
          <li key={q.id} aria-label={questLabel(q)} className="flex min-h-6 items-center gap-2.5">
            <span
              aria-hidden="true"
              className={`material-symbols-outlined shrink-0 text-[20px] ${q.done ? "text-tertiary" : "text-outline"}`}
            >
              {q.icon}
            </span>
            <span
              aria-hidden="true"
              className={`min-w-0 shrink font-body text-sm leading-5 ${q.done ? "text-on-surface" : "text-on-surface-variant"}`}
            >
              {q.title}
            </span>
            <span aria-hidden="true" className="min-w-3 flex-1 border-b-2 border-dotted border-outline-variant" />
            <span
              aria-hidden="true"
              className="flex shrink-0 items-center gap-1 font-headline text-[15px] font-extrabold tabular-nums text-tertiary"
            >
              {q.done && (
                <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>
                  check_circle
                </span>
              )}
              {questValue(q)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
