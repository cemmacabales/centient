import { requireRoleForPage } from "@/lib/admin-auth";
import { BOARD_RULES } from "@/lib/gamification/board";
import { CROWD_MATCH_XP } from "@/lib/gamification/crowd";
import { EVENT_CODE_XP } from "@/lib/gamification/events";
import { answerXp, DAILY_GOAL, DAILY_GOAL_XP, QUALITY_CHECK_XP, STREAK_MILESTONES } from "@/lib/gamification/rules";
import { TIERS } from "@/lib/gamification/tiers";
import EventCodesPanel from "@/components/admin/EventCodesPanel";
import WeeklyBoardPanel from "@/components/admin/WeeklyBoardPanel";

export const dynamic = "force-dynamic";

const COUNT = new Intl.NumberFormat("en-US");

/**
 * #203 (board 10): event codes, the weekly board and the XP rules, for super
 * admins. It shows whatever NEXT_PUBLIC_GAMIFICATION says, so codes can be
 * made before the labeler side turns on.
 */
export default async function AdminGamificationPage() {
  await requireRoleForPage("SUPER_ADMIN");

  const streaks = Object.entries(STREAK_MILESTONES);
  const rules: [string, string][] = [
    ["Accepted answer, difficulty 1–3 / 4–6 / 7–9", [answerXp(1), answerXp(4), answerXp(7)].join(" / ")],
    ["Quality check passed · Matched the crowd", `${QUALITY_CHECK_XP} · ${CROWD_MATCH_XP}`],
    [`Daily goal (${DAILY_GOAL} answers)`, String(DAILY_GOAL_XP)],
    [`Streak at ${streaks.map(([d]) => d).join(" / ")} days`, streaks.map(([, xp]) => xp).join(" / ")],
    [
      TIERS.slice(1).map((t) => t.name).join(" / "),
      `${TIERS.slice(1).map((t) => COUNT.format(t.xp)).join(" / ")} XP`,
    ],
    ["Event code", `${EVENT_CODE_XP}, not ranked on the board`],
    [
      "Weekly board",
      `Top ${BOARD_RULES.size} shown; checks ${BOARD_RULES.checkFloor * 100}%+ from ${BOARD_RULES.minChecks} a week; top ${BOARD_RULES.stamped} stamped`,
    ],
    ["Day and week boundary", "Asia/Manila"],
  ];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-headline text-3xl font-extrabold tracking-tight text-on-surface">Gamification</h1>
        <p className="mt-2 max-w-2xl font-body text-sm text-on-surface-variant">
          Super admins run event codes and the weekly board here. The crowd setting lives on each campaign, so customers set
          it themselves.
        </p>
      </header>

      <EventCodesPanel />
      <WeeklyBoardPanel />

      <section
        aria-labelledby="xp-rules-heading"
        className="flex flex-col gap-4 rounded-3xl border border-outline-variant/40 bg-surface-container-lowest p-6 shadow-[0_4px_24px_rgba(25,28,30,0.04)]"
      >
        <div className="flex flex-col gap-1">
          <h2 id="xp-rules-heading" className="font-headline text-xl font-bold text-on-surface">
            XP rules
          </h2>
          <p className="max-w-2xl font-body text-sm leading-[21px] text-on-surface-variant">
            Read-only. Set in config and changed through a pull request, like the payout cap.
          </p>
        </div>
        <table className="w-full border-collapse font-body text-sm leading-5">
          <tbody>
            {rules.map(([rule, value]) => (
              <tr key={rule} className="border-t border-outline-variant/40">
                <td className="py-2.5 pr-4 text-on-surface-variant">{rule}</td>
                <td className="py-2.5 text-right font-semibold tabular-nums text-on-surface">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
