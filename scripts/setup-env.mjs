#!/usr/bin/env node
/**
 * Generate a complete, bootable .env.local for local dev/testing.
 *
 * Fills in every key the app needs so no route 500s on a missing/placeholder
 * value. Idempotent and safe: it only replaces values that are MISSING or still
 * a known placeholder — a real secret you've already set is never overwritten.
 *
 * Usage:
 *   node scripts/setup-env.mjs            # writes ./.env.local
 *   node scripts/setup-env.mjs <path>     # writes a custom target (used in tests)
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE_PATH = resolve(ROOT, ".env.local.example");
const ENV_PATH = process.argv[2] ? resolve(process.argv[2]) : resolve(ROOT, ".env.local");

const hex = (bytes = 32) => randomBytes(bytes).toString("hex");
const changes = [];

if (!existsSync(EXAMPLE_PATH)) {
  console.error("✗ .env.local.example not found — cannot scaffold .env.local");
  process.exit(1);
}

if (!existsSync(ENV_PATH)) {
  copyFileSync(EXAMPLE_PATH, ENV_PATH);
  changes.push("created .env.local from .env.local.example");
}

let lines = readFileSync(ENV_PATH, "utf8").split("\n");

function findLine(key) {
  const re = new RegExp(`^\\s*${key}\\s*=`);
  return lines.findIndex((l) => re.test(l));
}

function valueAt(idx) {
  return lines[idx].slice(lines[idx].indexOf("=") + 1).trim();
}

/**
 * Ensure `key` holds a usable value. `isBad(current)` decides whether the
 * current value is missing/placeholder and should be replaced by `desired`.
 */
function ensure(key, desired, isBad) {
  const idx = findLine(key);
  if (idx === -1) {
    lines.push(`${key}=${desired}`);
    changes.push(`+ ${key} (added)`);
    return;
  }
  if (isBad(valueAt(idx))) {
    lines[idx] = `${key}=${desired}`;
    changes.push(`~ ${key} (replaced placeholder)`);
  }
}

/** Comment out a placeholder so the var is unset and the feature no-ops. */
function disablePlaceholder(key, isPlaceholder, note) {
  const idx = findLine(key);
  if (idx === -1) return;
  if (isPlaceholder(valueAt(idx))) {
    lines[idx] = `# ${lines[idx].trim()}   # disabled by setup — ${note}`;
    changes.push(`# ${key} (disabled placeholder — ${note})`);
  }
}

const isMissing = (v) => v === "" || v === undefined;
const looksPlaceholder = (v) => /change_me|your_|placeholder|get_api_key|_here|^xxx/i.test(v);

// JWT secret — must be >= 32 chars (admin auth + middleware + labeler fallback).
ensure("ADMIN_JWT_SECRET", hex(32), (v) => isMissing(v) || v.length < 32 || looksPlaceholder(v));

// Hot wallet — must be 0x + 64 hex. Throwaway/unfunded is fine just to boot.
ensure("PAYOUT_PRIVATE_KEY", `0x${hex(32)}`, (v) => isMissing(v) || !/^0x[0-9a-fA-F]{64}$/.test(v));

// App URL — used in email links and redirects.
ensure("NEXT_PUBLIC_APP_URL", "http://localhost:3000", (v) => isMissing(v) || !/^https?:\/\//.test(v));

// Per-submission platform fee in wei — getPlatformFeeWei() throws if unset/invalid.
ensure("PLATFORM_FEE_WEI", "150000000000000000", (v) => isMissing(v) || !/^\d+$/.test(v));

// Cron shared secret — /api/cron/* return 401 unless this is set. Generate one so
// the cron endpoints are testable with `Authorization: Bearer <CRON_SECRET>`.
ensure("CRON_SECRET", hex(32), (v) => isMissing(v) || looksPlaceholder(v));

// Analytics webhook HMAC secret (optional integration) — replace the change_me
// placeholder so no secret-shaped placeholder lingers in a fresh setup.
ensure("ANALYTICS_HMAC_SECRET", hex(32), (v) => isMissing(v) || looksPlaceholder(v));

// Email — leave unset in dev so sends are graceful no-ops instead of failing on
// a fake key. A real key (re_...) / verified sender is left untouched.
disablePlaceholder("RESEND_API_KEY", (v) => isMissing(v) || looksPlaceholder(v), "email no-ops in dev");
disablePlaceholder("RESEND_EMAIL_FROM", (v) => isMissing(v) || looksPlaceholder(v), "uses Resend default sender");

writeFileSync(ENV_PATH, lines.join("\n"));

console.log(`\n✓ ${ENV_PATH} is ready for local testing.`);
if (changes.length === 0) {
  console.log("  (no changes — everything was already set)");
} else {
  for (const c of changes) console.log(`  ${c}`);
}
console.log("\n  Seeded test login (after db:seed):");
console.log("    admin   → admin@centient.work     / GoCent!123   (SUPER_ADMIN, full access)");
console.log("    customer→ centient@centient.work  / GoCent!123   (CUSTOMER)\n");
