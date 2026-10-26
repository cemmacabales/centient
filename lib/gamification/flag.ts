// #201: the XP loop's UI shows only with NEXT_PUBLIC_GAMIFICATION=on. Server
// writes run regardless, so XP accrues before the UI ships (ADR-0010). Inlined
// at build time, like every NEXT_PUBLIC_ variable.
export const GAMIFICATION_ON = process.env.NEXT_PUBLIC_GAMIFICATION === "on";

// #202: tier gating changes which tasks real labelers get, so it has its own
// server flag, turned on with the UI flag. Read per request, never inlined.
export function gatingOn(): boolean {
  return process.env.GAMIFICATION_GATING === "on";
}
