export function isSpamReason(reason: string): boolean {
  const trimmed = reason.trim();
  if (trimmed.length < 10) return true;
  if (/^(.)\1+$/.test(trimmed)) return true;
  return false;
}
