import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HORIZON_SUBMIT_ALLOWLIST,
  PAYMENTS_LANE_SOURCE_ROOTS,
  PAYOUT_SIGNER_SECRET_ALLOWLIST,
  USDC_PAYMENT_BUILDER_ALLOWLIST,
  paymentsLaneSourceFiles,
} from "@/tests/payments-lane";

/**
 * The lane-wide "no single-key payout path" guard (#12).
 *
 * WHY THIS TEST HAS TWO HALVES, and why deleting either one silently reopens the
 * regression it exists to prevent.
 *
 * The repository already had two weaker guards before this file. Neither is the
 * invariant the deliverable claims:
 *
 *   1. Absence-of-export tests (`client.test.ts`, `payout-usdc.test.ts`) assert
 *      `payUsdc` is gone. They catch a re-export of the retired function. They
 *      say nothing about a *new* single-key path written in a new file.
 *   2. Per-module assertions (`payout-envelope.test.ts`,
 *      `payout-submitter.test.ts`) prove that the envelope *this* submitter
 *      builds carries two verified signatures. They say nothing about code that
 *      never goes through that submitter.
 *
 * So neither fails if someone adds `server().submitTransaction(...)` on a singly
 * signed envelope in a file created tomorrow. That is the gap.
 *
 * Each candidate fix on its own is bypassable:
 *
 *   - A *boundary* test — the submitter refuses a <2-signature envelope — is
 *     airtight for everything that goes through the submitter and blind to
 *     anything that does not. A new direct caller of Horizon walks past it.
 *   - A *structural* test — no module outside the sanctioned ones reaches
 *     Horizon — catches the new caller, but proves nothing about whether the
 *     sanctioned path itself still checks signatures. Weaken
 *     `assertPayoutFullySigned` and a structural-only guard stays green.
 *
 * The two are therefore kept together, in this order: the structural half says
 * *only* the submitter may broadcast, and the boundary half (below, plus the
 * dedicated cases in `payout-submitter.test.ts`) says the submitter broadcasts
 * *only* what carries two distinct verified signatures. Together they close the
 * path; separately they do not.
 *
 * On brittleness. The structural half is deliberately glob-driven rather than a
 * hardcoded file list, so moving or renaming a file inside `lib/`, `app/`,
 * `services/`, or `scripts/` does not break it. What it does pin is the
 * allowlist, in both directions: an unlisted submit site fails, and a listed
 * path that has disappeared or stopped submitting fails too. That second
 * direction is the point — an allowlist entry is a promise about one file, and a
 * stale entry would otherwise become a blanket exemption for whatever later
 * occupies that path. When this test fails after a refactor, the fix is to move
 * the allowlist entry *and re-justify it*, not to widen the pattern.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");

/** Horizon's transaction-submitting entry points. */
const SUBMIT_PATTERN = /\bsubmit(?:Async)?Transaction\s*\(/;
/** Construction of a payment operation — the only op that moves USDC. */
const PAYMENT_BUILDER_PATTERN = /\bOperation\.payment\s*\(/;

const laneFiles = paymentsLaneSourceFiles(REPO_ROOT);
const read = (relative: string) =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

/**
 * Match `pattern` against code only. Every allowlist reason and half the payout
 * module docstrings name `submitTransaction` in prose, and a guard that counted
 * those would either fire on documentation or drive people to stop writing it.
 */
function matchesInCode(source: string, pattern: RegExp): boolean {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  return pattern.test(withoutComments);
}

function laneFilesMatching(pattern: RegExp): string[] {
  return laneFiles.filter((file) => matchesInCode(read(file), pattern));
}

describe("the payments lane scan itself", () => {
  it("reads the modules it claims to cover", () => {
    // A guard that silently scanned nothing would pass forever. Pin the roots
    // and a few known members so an empty or misrooted walk fails loudly.
    expect(laneFiles.length).toBeGreaterThan(40);
    expect(laneFiles).toContain("lib/stellar/payout-submitter.ts");
    expect(laneFiles).toContain("lib/payout.ts");
    expect(laneFiles).toContain("services/cosigner/server.ts");
    expect(laneFiles).toContain("scripts/stellar-multisig-payout-spike.ts");
    for (const root of PAYMENTS_LANE_SOURCE_ROOTS) {
      expect(laneFiles.some((file) => file.startsWith(`${root}/`))).toBe(true);
    }
  });

  it("never reads test code, whose fakes submit freely by design", () => {
    expect(laneFiles.filter((file) => file.includes("__tests__"))).toEqual([]);
  });
});

describe("no single-key payout path exists in the payments lane", () => {
  it("routes every Horizon submit through an allowlisted, dual-signature-guarded site", () => {
    // THE regression this issue exists to make impossible: a fresh
    // `server().submitTransaction(...)` on a singly signed envelope, in a file
    // that no per-module test covers. Adding one fails here by name.
    expect(laneFilesMatching(SUBMIT_PATTERN).sort()).toEqual(
      Object.keys(HORIZON_SUBMIT_ALLOWLIST).sort(),
    );
  });

  it("builds a USDC payment only where an envelope is provably multi-signed", () => {
    // The other end of the same path. A payment that is never constructed
    // outside these modules cannot be signed once and broadcast from anywhere.
    expect(laneFilesMatching(PAYMENT_BUILDER_PATTERN).sort()).toEqual(
      Object.keys(USDC_PAYMENT_BUILDER_ALLOWLIST).sort(),
    );
  });

  it("holds every allowlist entry to the file it was written about", () => {
    // Both allowlists are exemptions with a stated reason. A moved or renamed
    // file must carry its justification with it rather than leaving an entry
    // that exempts whatever occupies the path next.
    for (const [file, reason] of [
      ...Object.entries(HORIZON_SUBMIT_ALLOWLIST),
      ...Object.entries(USDC_PAYMENT_BUILDER_ALLOWLIST),
      ...Object.entries(PAYOUT_SIGNER_SECRET_ALLOWLIST),
    ]) {
      expect(reason.length, `${file} needs a stated reason, not a bare exemption`)
        .toBeGreaterThan(40);
      expect(laneFiles, `${file} is allowlisted but no longer in the lane`).toContain(file);
    }
  });

  it("keeps the retired single-key broadcast retired", () => {
    // `payUsdc` was the original single-key path. The existing absence-of-export
    // tests prove the module does not re-export it; this proves no module in the
    // lane has quietly reintroduced the name either.
    const callers = laneFiles.filter((file) => matchesInCode(read(file), /\bpayUsdc\b/));
    expect(callers).toEqual([]);
  });

  it("gives the payout account's signing secret to one runtime module and one ceremony", () => {
    // The platform payout signer is signature #1 of two. Nothing that ships can
    // read it except the submitter, so no other runtime module is positioned to
    // sign a payout envelope at all — the co-signer's key half is public here by
    // design (issue #8). The one script that reads it is a hand-run testnet
    // ceremony, allowlisted with its reason like every other exemption.
    const readers = laneFiles.filter((file) =>
      matchesInCode(read(file), /STELLAR_OPS_SIGNER_SECRET/),
    );
    expect(readers.sort()).toEqual(Object.keys(PAYOUT_SIGNER_SECRET_ALLOWLIST).sort());
    expect(readers.filter((file) => !file.startsWith("scripts/"))).toEqual([
      "lib/stellar/payout-submitter.ts",
    ]);
  });
});
