// #202: the tier UI's copy, kept apart so it reads as one voice and is tested
// on its own. Every rule quoted here comes from lib/gamification/tiers.
import { STAMPS } from "@/lib/gamification/stamps";
import { TIER_RULES, TIERS } from "@/lib/gamification/tiers";
import type { StampStatus, TierSummary } from "@/lib/gamification/types";
import { formatXp } from "./format";

const pct = (share: number) => `${Math.round(share * 100)}%`;

/** "Quality checks 80%+", or both floors in short. */
export function keepOpenLine(tier: number): string {
  const def = TIERS[tier];
  if (def.crowdFloor === null) return `Quality checks ${pct(def.checkFloor ?? 0)}+`;
  return `Checks ${pct(def.checkFloor ?? 0)}+ · crowd ${pct(def.crowdFloor)}+`;
}

function requirements(tier: number): string {
  const def = TIERS[tier];
  const floors = [`quality checks at ${pct(def.checkFloor ?? 0)}+`];
  if (def.crowdFloor !== null) floors.push(`crowd match at ${pct(def.crowdFloor)}+`);
  const days = def.activeDays !== null ? ` over ${def.activeDays} active days` : "";
  return `Keep your ${floors.join(" and ")}${days} to open it.`;
}

/** The line under the tier card's bar. */
export function nextLine(t: TierSummary): string {
  if (!t.next) return `${t.name} is the top tier. Every task is open to you.`;
  if (t.next.xpToGo === 0) return `You have the XP for ${t.next.name}. ${requirements(t.next.tier)}`;
  const pay = t.next.payUpTo ? ` It opens tasks that pay up to ${Number(t.next.payUpTo).toFixed(2)} USDC.` : "";
  return `${formatXp(t.next.xpToGo)} XP to ${t.next.name}.${pay}`;
}

/** "0.40–1.15", to the cent; one figure when the band pays one price. */
export function payRange(from: string | null, to: string | null): string | null {
  if (from === null || to === null) return null;
  const [a, b] = [Number(from).toFixed(2), Number(to).toFixed(2)];
  return a === b ? a : `${a}–${b}`;
}

/** Why a tier is on hold, and how to reopen it. Never blame, never red. */
export function holdLine(t: TierSummary): string {
  const def = TIERS[t.tier];
  const n = t.reopenAfter;
  const tail = `Your XP and tier stay.`;
  const checksLow =
    def.checkFloor !== null && t.checks.total >= TIER_RULES.minChecks && t.checks.passed / t.checks.total < def.checkFloor;
  if (checksLow) {
    return `Your quality checks dropped to ${t.checks.passed} of the last ${t.checks.total}. Pass the next ${n} to reopen ${t.name} tasks. ${tail}`;
  }
  const crowdLow =
    def.crowdFloor !== null && t.crowd.total >= TIER_RULES.minCrowd && t.crowd.matched / t.crowd.total < def.crowdFloor;
  const why = crowdLow ? `Your crowd match dropped to ${pct(t.crowd.matched / t.crowd.total)}. ` : "";
  return `${why}Pass the next ${n} quality checks to reopen ${t.name} tasks. ${tail}`;
}

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Manila" });
const DAY_KEY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" });

/** Earned today, Manila time. */
export function earnedToday(awardedAt: string, now: Date): boolean {
  return DAY_KEY.format(new Date(awardedAt)) === DAY_KEY.format(now);
}

/**
 * Under a stamp: when it was earned, or how far along it is. #203: an event
 * stamp says it's from an event, and the locked Top 3 shows the best finish.
 */
export function stampCaption(id: string, s: StampStatus, now: Date, bestRank: number | null = null): string {
  if (s.awardedAt) {
    const when = earnedToday(s.awardedAt, now) ? "Today" : DAY.format(new Date(s.awardedAt));
    return s.event ? `Event · ${when}` : when;
  }
  if (id === "event") return "Event code";
  if (id === "top-3-week") return bestRank !== null ? `Best: #${bestRank}` : "Weekly top 3";
  if (id === "invited-in") return "Joined by invite";
  if (id === "brought-a-friend") return "Invite a friend";
  if (!s.progress) return "";
  const of = `${s.progress.current} / ${s.progress.target}`;
  if (id === "in-step") return `Matched ${of}`;
  if (id === "all-rounder") return `${of} topics`;
  return of;
}

export function stampTitle(id: string): string {
  return STAMPS.find((s) => s.id === id)?.title ?? id;
}
