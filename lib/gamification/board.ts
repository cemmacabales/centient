// The weekly board's rules (#203, ADR-0012). Pure: no clock, no database, so
// the board screen reads the same numbers the server ranks with.
//
// The board ranks XP earned Monday to Sunday, Manila time. Event-code XP is
// left out of the sum (lib/gamification/leaderboard.ts), so a booth code can't
// buy a place. To place, a labeler keeps quality checks at 80% or better that
// week; under 3 checks, XP alone places, as with the tier floors (ADR-0011).
// Ties go to whoever reached the total first.

export const BOARD_RULES = {
  /** Rows shown above the caller's own. */
  size: 20,
  checkFloor: 0.8,
  /** The floor applies from this many checks in the week. */
  minChecks: 3,
  /** Places that earn the Top 3 stamp when the week closes. */
  stamped: 3,
} as const;

export interface WeekEntry {
  userId: string;
  /** Ranked XP earned this week. */
  xp: number;
  /** When the labeler's last ranked XP that week landed. */
  reachedAt: Date;
  /** Quality checks that week, retest excluded. */
  checks: { passed: number; total: number };
}

export interface RankedEntry extends WeekEntry {
  rank: number;
}

export function placesOnBoard(checks: { passed: number; total: number }): boolean {
  return checks.total < BOARD_RULES.minChecks || checks.passed / checks.total >= BOARD_RULES.checkFloor;
}

/** Everyone who places, best first, ranked 1, 2, 3… without gaps. */
export function rankWeek(entries: readonly WeekEntry[]): RankedEntry[] {
  return entries
    .filter((e) => e.xp > 0 && placesOnBoard(e.checks))
    .sort(
      (a, b) =>
        b.xp - a.xp ||
        a.reachedAt.getTime() - b.reachedAt.getTime() ||
        (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
    )
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

export interface OwnRow {
  userId: string;
  /** Null when the labeler doesn't place this week. */
  rank: number | null;
  xp: number;
  /** False when quality checks are under the floor. */
  placed: boolean;
}

export interface Board {
  top: RankedEntry[];
  you: OwnRow;
  /** The caller's row is one of `top`. */
  youInTop: boolean;
}

/**
 * The top rows and the caller's own. `entries` is every labeler with XP this
 * week, placed or not, so an unplaced caller still sees their XP.
 */
export function boardFor(ranked: readonly RankedEntry[], userId: string, entries: readonly WeekEntry[] = ranked): Board {
  const top = ranked.slice(0, BOARD_RULES.size);
  const mine = ranked.find((r) => r.userId === userId);
  if (mine) {
    return { top, you: { userId, rank: mine.rank, xp: mine.xp, placed: true }, youInTop: mine.rank <= BOARD_RULES.size };
  }
  const own = entries.find((e) => e.userId === userId);
  return {
    top,
    you: { userId, rank: null, xp: own?.xp ?? 0, placed: own ? placesOnBoard(own.checks) : true },
    youInTop: false,
  };
}

export interface NameSettings {
  displayName: string | null;
  showOnBoard: boolean;
  displayNameHiddenAt: Date | null;
}

/** The name the board may show, or null for "Hidden labeler". */
export function publicName(u: NameSettings): string | null {
  if (!u.showOnBoard || !u.displayName || u.displayNameHiddenAt) return null;
  return u.displayName;
}
