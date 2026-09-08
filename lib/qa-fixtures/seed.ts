// Build one run's worth of D1 QA fixtures.
//
// Every row this writes is addressable two ways: by a stable slug that says what
// the fixture means, and by the fresh UUID it got on this run. The slug is how QA
// finds it; the UUID is its payout reference. They are separate because the reset
// contract forbids reusing a payout reference across runs, so the identity cannot
// be stable — and a fixture whose identity changes every run is unusable unless
// something records the mapping. `QaFixtureRun.fixtures` is that record.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "../../app/generated/prisma/client";
import {
  CAP_HEADROOM_UNITS,
  FIXTURE_REWARD_UNITS,
  PAYABLE_REFERENCE_COUNT,
  PAYABLE_REWARD_UNITS,
  PAYOUT_STATE_FIXTURES,
  planCapFixtures,
  requiredCampaignBalanceUnits,
  type CapPlan,
} from "./definitions";
import { fixtureTxHash } from "./hash";
import { RECIPIENT_SHAPES, type RecipientManifest, type RecipientShape } from "./manifest";

const HOUR_MS = 60 * 60 * 1000;

/**
 * How far back the already-broadcast fixtures are dated.
 *
 * Deliberately outside the cap's trailing-24-hour window. `getPayoutActivitySince`
 * sums every `PayoutJob` carrying a hash inside that window, so fixtures that
 * carry one would silently consume the allowance the cap fixtures are trying to
 * position — and D1-TC-017's boundary amounts would be wrong by exactly the value
 * of two unrelated fixtures. Dating them two days back keeps the cap arithmetic
 * owned by the cap fixtures alone.
 */
const BROADCAST_BACKDATE_MS = 48 * HOUR_MS;

/** Where the seeded cap usage is dated: recent, and comfortably inside the window. */
const CAP_USAGE_BACKDATE_MS = 1 * HOUR_MS;

export const QA_ADMIN_EMAIL = "admin@centient.work";

export interface SeedOptions {
  prisma: PrismaClient;
  manifest: RecipientManifest;
  network: string;
  /** Configured daily cap, in units. Zero disables the cap fixtures. */
  capUnits: bigint;
  gitSha?: string;
  runId?: string;
  headroomUnits?: bigint;
}

export interface SeedResult {
  runId: string;
  gitSha: string;
  network: string;
  campaignId: string;
  /** slug -> the row id that carried it on this run. */
  fixtures: Record<string, string>;
  seededCount: number;
  capPlan: CapPlan | null;
  capSkippedReason: string | null;
}

/** A run id: lowercase alphanumeric so it composes into a fixture hash. */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.getTime().toString(36);
  const salt = randomBytes(3).toString("hex");
  return `${stamp}${salt}`.toLowerCase().replace(/[^0-9a-z]/g, "");
}

/**
 * The SHA the fixtures were seeded at.
 *
 * Recorded because the reset contract requires it and because a fixture set is
 * only meaningful against the build that produced it. Falls back through the
 * deployment-provided variables before shelling out, and reports `unknown` rather
 * than throwing — a missing SHA should degrade the evidence, not block the run.
 */
export function resolveGitSha(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv =
    env.QA_FIXTURE_GIT_SHA ??
    env.RAILWAY_GIT_COMMIT_SHA ??
    env.VERCEL_GIT_COMMIT_SHA ??
    env.GITHUB_SHA;
  if (fromEnv && fromEnv.trim() !== "") return fromEnv.trim();

  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * A recipient's email, derived from its address.
 *
 * `User.email` is unique independently of `walletAddress`, so a fixed
 * per-shape email collides the moment the manifest is re-provisioned: the
 * upsert misses on the new address, takes the create path, and fails on the
 * email left behind by the old one. Re-provisioning is a supported operation,
 * and the resulting error names the email rather than the cause. Deriving the
 * address into the email keeps both unique keys moving together.
 */
export function recipientEmail(shape: RecipientShape, address: string): string {
  return `qa-${shape.toLowerCase()}-${address.slice(1, 9).toLowerCase()}@centient.work`;
}

export async function seedQaFixtures(options: SeedOptions): Promise<SeedResult> {
  const {
    prisma,
    manifest,
    network,
    capUnits,
    headroomUnits = CAP_HEADROOM_UNITS,
  } = options;

  const runId = options.runId ?? newRunId();
  const gitSha = options.gitSha ?? resolveGitSha();
  const now = Date.now();

  // The fixtures are owned by the admin the ordinary seed already creates. A
  // dedicated QA admin would mean another seeded credential with a literal
  // password, which is the exact problem #87 is open about — so this reuses the
  // existing one rather than adding to that surface.
  const admin = await prisma.adminUser.findUnique({ where: { email: QA_ADMIN_EMAIL } });
  if (!admin) {
    throw new Error(
      `qa-fixtures: no admin user '${QA_ADMIN_EMAIL}'. Run \`pnpm db:seed\` first — ` +
        "the fixtures attach to the existing admin rather than seeding another credential.",
    );
  }

  // One transaction for the whole fixture set, including the run record.
  //
  // The run row used to be written last, which meant a failure partway through
  // left committed campaign, task and submission rows with no run record — and
  // `resetQaFixtures` resolves a run's campaign through `run.fixtures["campaign"]`,
  // so those rows were undiscoverable by the one command whose job is to clean
  // them up. All-or-nothing removes the orphan case entirely rather than making
  // it merely recoverable.
  //
  // The default 5s interactive-transaction budget is not enough for ~40 sequential
  // writes on a loaded machine, so both bounds are raised deliberately.
  const result = await prisma.$transaction(
    async (tx) => {
      const fixtures: Record<string, string> = {};
      let seededCount = 0;

      // Recipients are upserted on their pinned address rather than created: the
      // manifest addresses are stable across runs, and `User.walletAddress` is
      // unique, so a second run would collide. Stats are rewritten each run so a
      // previous run's spending cannot change what this one starts from.
      const recipientIdByShape = {} as Record<RecipientShape, string>;
      for (const shape of RECIPIENT_SHAPES) {
        const address = manifest.recipients[shape].address;
        const user = await tx.user.upsert({
          where: { walletAddress: address },
          update: {
            email: recipientEmail(shape, address),
            isVerified: true,
            onboardingCompleted: true,
            pendingBalanceUnits: 0n,
            totalEarnedUnits: 0n,
          },
          create: {
            walletAddress: address,
            email: recipientEmail(shape, address),
            isVerified: true,
            onboardingCompleted: true,
            submissionCount: 100,
            goldCorrect: 40,
            goldAttempted: 45,
          },
        });
        recipientIdByShape[shape] = user.id;
        fixtures[`recipient:${shape}`] = address;
      }

      const campaign = await tx.campaign.create({
        data: {
          adminUserId: admin.id,
          name: `QA D1 fixtures ${runId}`,
          defaultResponseTarget: 1,
          rewardUnits: FIXTURE_REWARD_UNITS,
        },
      });
      fixtures["campaign"] = campaign.id;

      await tx.campaignBalance.create({
        data: {
          campaignId: campaign.id,
          balanceUnits: requiredCampaignBalanceUnits() * 4n,
        },
      });

      /** One task + one submission, wired to the accounting the state implies. */
      async function createFixtureSubmission(args: {
        slug: string;
        shape: RecipientShape;
        payoutStatus: string;
        txHash: string | null;
        retryCount: number;
        payoutError: string | null;
        amountUnits: bigint;
        ledger: "reserved" | "refunded" | "none";
        prompt: string;
      }): Promise<string> {
        const task = await tx.task.create({
          data: {
            campaignId: campaign.id,
            prompt: args.prompt,
            responseA: "Fixture response A.",
            responseB: "Fixture response B.",
            category: "qa-fixture",
            rewardUnits: args.amountUnits,
            responseTarget: 1,
          },
        });

        const submission = await tx.submission.create({
          data: {
            userId: recipientIdByShape[args.shape],
            taskId: task.id,
            walletAddress: manifest.recipients[args.shape].address,
            choice: "A",
            reason: `QA D1 fixture ${args.slug} — see docs/qa-fixtures-runbook.md`,
            payoutAmountUnits: args.amountUnits,
            payoutStatus: args.payoutStatus,
            payoutTxHash: args.txHash,
            retryCount: args.retryCount,
            payoutError: args.payoutError,
            lastRetriedAt: args.retryCount > 0 || args.txHash ? new Date(now) : null,
          },
        });

        if (args.ledger !== "none") {
          await tx.balanceLedger.create({
            data: {
              campaignId: campaign.id,
              type: "DEBIT_REWARD",
              amountUnits: args.amountUnits,
              submissionId: submission.id,
              note: `QA fixture ${args.slug}`,
            },
          });
        }
        if (args.ledger === "refunded") {
          // A permanent failure gives the reward back, because no funds moved. The
          // reconciliation fixture pointedly does NOT get this row: there, the funds
          // did move and refunding would double-spend the campaign.
          await tx.balanceLedger.create({
            data: {
              campaignId: campaign.id,
              type: "REFUND",
              amountUnits: args.amountUnits,
              submissionId: submission.id,
              note: `QA fixture ${args.slug} — permanent rail error`,
            },
          });
        }

        seededCount += 1;
        return submission.id;
      }

      // ── The six payout states ────────────────────────────────────────────────
      let hashIndex = 0;
      for (const fixture of PAYOUT_STATE_FIXTURES) {
        const txHash = fixture.broadcast ? fixtureTxHash(runId, hashIndex++) : null;

        const submissionId = await createFixtureSubmission({
          slug: fixture.slug,
          shape: fixture.shape,
          payoutStatus: fixture.payoutStatus,
          txHash,
          retryCount: fixture.retryCount,
          payoutError: fixture.payoutError,
          amountUnits: FIXTURE_REWARD_UNITS,
          ledger: fixture.ledger,
          prompt: `[${fixture.slug}] ${fixture.why}`,
        });
        fixtures[fixture.slug] = submissionId;

        if (txHash) {
          await tx.payoutJob.create({
            data: {
              type: "SUBMISSION_PAYOUT",
              submissionId,
              amountUnits: FIXTURE_REWARD_UNITS,
              destinationAddress: manifest.recipients[fixture.shape].address,
              txHash,
              // Backdated out of the cap window on purpose — see BROADCAST_BACKDATE_MS.
              broadcastAt: new Date(now - BROADCAST_BACKDATE_MS),
              status: fixture.payoutStatus === "needs_reconciliation" ? "failed" : "done",
              completedAt: new Date(now - BROADCAST_BACKDATE_MS),
              lastError: fixture.payoutError,
            },
          });
        }
      }

      // ── Twelve payable references for the concurrency cases ──────────────────
      for (let i = 1; i <= PAYABLE_REFERENCE_COUNT; i++) {
        const slug = `qa-payable-${String(i).padStart(2, "0")}`;
        fixtures[slug] = await createFixtureSubmission({
          slug,
          shape: "withTrustline",
          payoutStatus: "pending",
          txHash: null,
          retryCount: 0,
          payoutError: null,
          amountUnits: PAYABLE_REWARD_UNITS,
          ledger: "reserved",
          prompt: `[${slug}] Payable reference ${i} of ${PAYABLE_REFERENCE_COUNT} for D1-TC-009 and D1-TC-019.`,
        });
      }

      // ── Cap boundary ─────────────────────────────────────────────────────────
      const capPlan = planCapFixtures(capUnits, headroomUnits);
      let capSkippedReason: string | null = null;

      if (!capPlan) {
        capSkippedReason =
          capUnits <= 0n
            ? "DAILY_PAYOUT_CAP_UNITS is 0, which disables the cap entirely — there is no boundary to position against."
            : `the configured cap (${capUnits} units) is smaller than the fixture headroom (${headroomUnits} units).`;
      } else {
        // Consume the cap down to the headroom with one settled withdrawal. The
        // status is `done` so it cannot collide with the partial unique index that
        // permits a single in-flight WITHDRAWAL per user.
        if (capPlan.seededUsageUnits > 0n) {
          const usageJob = await tx.payoutJob.create({
            data: {
              type: "WITHDRAWAL",
              userId: recipientIdByShape.withTrustline,
              amountUnits: capPlan.seededUsageUnits,
              destinationAddress: manifest.recipients.withTrustline.address,
              txHash: fixtureTxHash(runId, hashIndex++),
              broadcastAt: new Date(now - CAP_USAGE_BACKDATE_MS),
              status: "done",
              completedAt: new Date(now - CAP_USAGE_BACKDATE_MS),
            },
          });
          fixtures["qa-cap-usage"] = usageJob.id;
          seededCount += 1;
        }

        for (const preset of capPlan.presets) {
          fixtures[preset.slug] = await createFixtureSubmission({
            slug: preset.slug,
            shape: "withTrustline",
            payoutStatus: "pending",
            txHash: null,
            retryCount: 0,
            payoutError: null,
            amountUnits: preset.amountUnits,
            ledger: "reserved",
            prompt: `[${preset.slug}] ${preset.expectation} (D1-TC-017).`,
          });
        }
      }

      await tx.qaFixtureRun.create({
        data: {
          runId,
          gitSha,
          network,
          fixtures,
          seededCount,
          note: capSkippedReason ? `cap fixtures skipped: ${capSkippedReason}` : null,
        },
      });

      return {
        campaignId: campaign.id,
        fixtures,
        seededCount,
        capPlan,
        capSkippedReason,
      };
    },
    { timeout: 120_000, maxWait: 15_000 },
  );

  return {
    runId,
    gitSha,
    network,
    campaignId: result.campaignId,
    fixtures: result.fixtures,
    seededCount: result.seededCount,
    capPlan: result.capPlan,
    capSkippedReason: result.capSkippedReason,
  };
}

