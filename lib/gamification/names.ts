// Display names for the weekly board (#203, ADR-0012). Pure, so the name form
// can check a name before it is sent and the server checks it again.
//
// A name is opt-in, unique and filtered. The filter is an in-repo list, not a
// dependency: English and Filipino profanity and slurs, and words that would
// pass for the team or the board's own "Hidden labeler". Long words are caught
// anywhere in the name, through dots, underscores and digit swaps ("sh1t");
// short ones only standing on their own, so "batangas" and "peacock" stay fine.

export const NAME_RULES = { min: 3, max: 20 } as const;

export type NameRejection = "too_short" | "too_long" | "bad_start" | "bad_chars" | "not_allowed";

export type NameResult = { ok: true; name: string } | { ok: false; reason: NameRejection };

/** Caught anywhere in the name once separators are dropped. */
const ANYWHERE = [
  // Reserved: the team, the app, and the board's own label.
  "admin",
  "centient",
  "moderator",
  "support",
  "staff",
  "hiddenlabeler",
  "official",
  // English.
  "fuck",
  "shit",
  "cunt",
  "bitch",
  "pussy",
  "whore",
  "slut",
  "nigger",
  "nigga",
  "faggot",
  "retard",
  "rapist",
  "hitler",
  "porn",
  // Filipino.
  "putangina",
  "putang",
  "tangina",
  "pakyu",
  "pakshet",
  "kantot",
  "jakol",
  "pekpek",
  "burat",
  "tarantado",
  "ulol",
  "kupal",
  "hindot",
  "bayag",
] as const;

/** Caught only as a whole word between dots, underscores or digits. */
const ON_ITS_OWN = new Set([
  "ass",
  "dick",
  "cock",
  "fag",
  "rape",
  "sex",
  "tit",
  "tits",
  "puta",
  "gago",
  "gaga",
  "tanga",
  "bobo",
  "puke",
  "titi",
  "nazi",
  "inutil",
  "kingina",
  "leche",
  "punyeta",
]);

const LEET: Readonly<Record<string, string>> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t" };

function deLeet(s: string): string {
  return s.replace(/[013457]/g, (d) => LEET[d]);
}

function blocked(name: string): boolean {
  const joined = deLeet(name).replace(/[._]/g, "");
  if (ANYWHERE.some((w) => joined.includes(w))) return true;
  const words = [...name.split(/[._\d]+/), ...deLeet(name).split(/[._]+/)];
  return words.some((w) => ON_ITS_OWN.has(w));
}

export function validateDisplayName(raw: unknown): NameResult {
  const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (name.length < NAME_RULES.min) return { ok: false, reason: "too_short" };
  if (name.length > NAME_RULES.max) return { ok: false, reason: "too_long" };
  if (!/^[a-z0-9._]+$/.test(name)) return { ok: false, reason: "bad_chars" };
  if (!/^[a-z]/.test(name)) return { ok: false, reason: "bad_start" };
  if (blocked(name)) return { ok: false, reason: "not_allowed" };
  return { ok: true, name };
}
