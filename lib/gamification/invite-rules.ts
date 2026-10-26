// Invites (#203, ADR-0012). Pure: the code format and the numbers, shared by
// the invite card, the sign-in route and the reward.
//
// An invite pays off only when the invited labeler first reaches Skilled: then
// both get 50 XP and a stamp. The inviter is paid for at most 10.

export const INVITE_RULES = {
  xp: 50,
  /** Rewarded invites per inviter. */
  cap: 10,
  /** Set by the ?invite= link, read once when the account is created. */
  cookie: "centient_invite",
  /** How long a link's invite waits for the first sign-in. */
  cookieDays: 7,
} as const;

// No 0/O, 1/I/L: a code is read aloud and typed from a phone.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LENGTH = 8;

export function newInviteCode(): string {
  const bytes = new Uint8Array(LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function normalizeInviteCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return code.length === LENGTH && [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}

export function inviteLink(code: string, origin: string): string {
  return `${origin}/?invite=${code}`;
}
