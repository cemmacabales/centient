// Re-derive missing ANSWER XP (#201, ADR-0010).
//
//   npm run xp:repair -- --since=2026-10-13T00:00:00Z            (dry run: lists what is missing)
//   npm run xp:repair -- --since=2026-10-13T00:00:00Z --apply    (writes it)
//
// The submit route writes XP after the accepted answer commits and reports a
// failure to Sentry ("submit-xp"). This finds accepted answers since `--since`
// with no ANSWER event and, with `--apply`, writes each once and credits the
// labeler. It restores XP only; the day's goal and the streak are not touched.
import "dotenv/config";
import { repairMissingAnswerXp } from "@/lib/gamification/repair";
import prisma from "@/lib/prisma";

function parseArgs(argv: string[]): { since: Date; apply: boolean } {
  let since: Date | undefined;
  let apply = false;
  for (const arg of argv) {
    const match = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
    if (match?.[1] === "since" && match[2]) since = new Date(match[2]);
    else if (match?.[1] === "apply" && match[2] === undefined) apply = true;
    else throw new Error(`unexpected argument "${arg}"`);
  }
  if (!since || Number.isNaN(since.getTime())) throw new Error("--since=<ISO date> is required");
  return { since, apply };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await repairMissingAnswerXp(args);
  for (const m of report.missing) console.log(`missing  ${m.submissionId}  user=${m.userId}  +${m.amount} XP`);
  console.log(
    args.apply
      ? `${report.missing.length} missing, ${report.applied} written`
      : `${report.missing.length} missing (dry run; pass --apply to write)`,
  );
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
