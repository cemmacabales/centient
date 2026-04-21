const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;

interface Entry {
  failures: number[];
}

const store = new Map<string, Entry>();

function prune(entry: Entry, now: number) {
  entry.failures = entry.failures.filter((ts) => now - ts < WINDOW_MS);
}

export function isLoginRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = store.get(ip);
  if (!entry) return false;
  prune(entry, now);
  return entry.failures.length >= MAX_FAILURES;
}

export function recordLoginFailure(ip: string) {
  const now = Date.now();
  const entry = store.get(ip) ?? { failures: [] };
  prune(entry, now);
  entry.failures.push(now);
  store.set(ip, entry);
}

export function resetLoginFailures(ip: string) {
  store.delete(ip);
}
