const rateLimitMap = new Map<string, number>();

export function isRateLimited(wallet: string): boolean {
  const last = rateLimitMap.get(wallet);
  if (!last) {
    rateLimitMap.set(wallet, Date.now());
    return false;
  }
  if (Date.now() - last < 15_000) return true;
  rateLimitMap.set(wallet, Date.now());
  return false;
}

export function isSpamReason(reason: string): boolean {
  const trimmed = reason.trim();
  if (trimmed.length < 10) return true;
  if (/^(.)\1+$/.test(trimmed)) return true;
  return false;
}
