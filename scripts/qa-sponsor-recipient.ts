// Mint the fourth recipient shape: a zero-XLM account created and given its USDC
// trustline in one sponsored CAP-33 transaction, then attached to the active
// fixture run as a payable submission.
//
// Why this is a separate command rather than part of `seed`. D1-TC-006 tests the
// sponsorship event, and an account can be created-and-sponsored exactly once. A
// pinned address would already have been through it, leaving nothing to observe,
// so this shape cannot live in the committed manifest with the other three. It is
// also the only fixture that touches the network, and keeping it out of `seed`
// leaves that command offline, deterministic, and secret-free.
//
// The sponsor pays the recipient's base reserve and the network fee. It uses
// `STELLAR_PLATFORM_SECRET` when set — the account QA is actually exercising —
// and otherwise mints an ephemeral friendbot-funded sponsor, so the fixture can
// be produced on a machine holding no platform secret at all.
//
// ON THE WRITE ORDER. Horizon accepting the sponsorship is irreversible and
// consumes real platform reserves, while every database write after it can still
// fail. If the hash were only recorded afterwards, a crash in between would leave
// a sponsored account on-chain with no record of it — and the next run, seeing no
// sponsored fixture, would mint a second one and strand the first. That is the
// same shape as the post-broadcast persistence failure the payout rail guards
// against in D1-TC-011, so it is handled the same way: the intent is persisted
// before the submit, and a failure after the submit is recorded for
// reconciliation rather than rolled back or retried.
import "dotenv/config";
import { Horizon, Keypair } from "@stellar/stellar-sdk";
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { horizonUrl, usdcAsset, UNITS_PER_USDC } from "../lib/stellar/config";
import { buildSponsoredRecipientTx } from "../lib/stellar/sponsored-recipient";
import { friendbotFund } from "../lib/qa-fixtures/friendbot";
import { assertFixturePreconditions, QaFixtureGateError } from "../lib/qa-fixtures/gate";

const SPONSORED_SLUG = "qa-sponsored-zero-xlm";
/** Recipient key written before the submit, cleared once the run records the result. */
const PENDING_KEY = `${SPONSORED_SLUG}:pending`;
/** Set when Horizon accepted but the run could not be updated. */
const RECONCILE_KEY = `${SPONSORED_SLUG}:needsReconciliation`;

function log(message: string): void {
  console.log(`[qa-sponsor] ${message}`);
}

async function resolveSponsor(): Promise<Keypair> {
  const secret = process.env.STELLAR_PLATFORM_SECRET?.trim();
  if (secret) {
    log("sponsoring from STELLAR_PLATFORM_SECRET");
    return Keypair.fromSecret(secret);
  }
  const ephemeral = Keypair.random();
  log(`no STELLAR_PLATFORM_SECRET — minting an ephemeral testnet sponsor ${ephemeral.publicKey()}`);
  await friendbotFund(ephemeral.publicKey(), { onRetry: (m) => log(`  ${m}`) });
  return ephemeral;
}

async function main(): Promise<void> {
  assertFixturePreconditions();

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const prisma = new PrismaClient({ adapter });

  try {
    const run = await prisma.qaFixtureRun.findFirst({
      where: { resetAt: null },
      orderBy: { seededAt: "desc" },
    });
    if (!run) {
      throw new Error("no active fixture run — run `pnpm qa:fixtures seed` first.");
    }

    const fixtures = (run.fixtures ?? {}) as Record<string, string>;
    const campaignId = fixtures["campaign"];
    if (!campaignId) throw new Error(`run ${run.runId} records no campaign.`);

    if (fixtures[RECONCILE_KEY]) {
      throw new Error(
        `run ${run.runId} has a sponsorship awaiting reconciliation ` +
          `(tx ${fixtures[RECONCILE_KEY]}, recipient ${fixtures[PENDING_KEY] ?? "unrecorded"}). ` +
          "Horizon accepted it but the run could not be updated. Reconcile that account " +
          "before minting another, then reset and re-seed.",
      );
    }
    if (fixtures[PENDING_KEY]) {
      // Refusing here is the point: minting a second account would strand the
      // first, which holds platform reserves nothing now points at.
      throw new Error(
        `run ${run.runId} has an unfinished sponsorship for ${fixtures[PENDING_KEY]}. ` +
          "Check whether that account exists on Horizon: if it does, reconcile it; if it " +
          "does not, the submit never landed. Either way, reset and re-seed rather than " +
          "minting a second account against this run.",
      );
    }
    if (fixtures[SPONSORED_SLUG]) {
      throw new Error(
        `run ${run.runId} already has a sponsored recipient (${fixtures[SPONSORED_SLUG]}). ` +
          "Reset and re-seed for a fresh sponsorship — the event happens once per address.",
      );
    }

    const asset = usdcAsset();
    const server = new Horizon.Server(horizonUrl());
    const recipient = Keypair.random();
    const sponsor = await resolveSponsor();

    log(`recipient ${recipient.publicKey()}`);

    const sponsorAccount = await server.loadAccount(sponsor.publicKey());
    const tx = buildSponsoredRecipientTx({
      sponsorAccount,
      recipientPublicKey: recipient.publicKey(),
      asset,
    });
    // The sponsor owns the sequence and the fee; the recipient signs because its
    // own trustline and the end-sponsorship operation are sourced from it.
    tx.sign(sponsor, recipient);

    // Persisted BEFORE the irreversible step, so a crash leaves a marker naming
    // the account to look for rather than silence.
    await prisma.qaFixtureRun.update({
      where: { runId: run.runId },
      data: {
        fixtures: {
          ...fixtures,
          [PENDING_KEY]: recipient.publicKey(),
          [`${SPONSORED_SLUG}:sponsor`]: sponsor.publicKey(),
        },
      },
    });

    const submitted = await server.submitTransaction(tx);
    log(`sponsored account created in ${submitted.hash}`);

    try {
      const balances = (await server.loadAccount(recipient.publicKey())).balances;
      const xlm = balances.find((b) => b.asset_type === "native")?.balance ?? "0";
      log(`recipient XLM balance: ${xlm} (zero is the point — D1-TC-006)`);

      const user = await prisma.user.create({
        data: {
          walletAddress: recipient.publicKey(),
          email: `qa-sponsored-${recipient.publicKey().slice(1, 9).toLowerCase()}@centient.work`,
          isVerified: true,
          onboardingCompleted: true,
          submissionCount: 100,
          goldCorrect: 40,
          goldAttempted: 45,
        },
      });

      const task = await prisma.task.create({
        data: {
          campaignId,
          prompt: `[${SPONSORED_SLUG}] Zero-XLM sponsored recipient, created and trustlined in ${submitted.hash}.`,
          responseA: "Fixture response A.",
          responseB: "Fixture response B.",
          category: "qa-fixture",
          rewardUnits: UNITS_PER_USDC,
          responseTarget: 1,
        },
      });

      // Payable, like `qa-validated`: the case is about the recipient's shape,
      // not about a different payout state.
      const submission = await prisma.submission.create({
        data: {
          userId: user.id,
          taskId: task.id,
          walletAddress: recipient.publicKey(),
          choice: "A",
          reason: `QA D1 fixture ${SPONSORED_SLUG} — see docs/qa-fixtures-runbook.md`,
          payoutAmountUnits: UNITS_PER_USDC,
          payoutStatus: "pending",
        },
      });

      await prisma.balanceLedger.create({
        data: {
          campaignId,
          type: "DEBIT_REWARD",
          amountUnits: UNITS_PER_USDC,
          submissionId: submission.id,
          note: `QA fixture ${SPONSORED_SLUG}`,
        },
      });

      const settled = { ...fixtures };
      delete settled[PENDING_KEY];
      await prisma.qaFixtureRun.update({
        where: { runId: run.runId },
        data: {
          fixtures: {
            ...settled,
            [SPONSORED_SLUG]: submission.id,
            [`${SPONSORED_SLUG}:sponsor`]: sponsor.publicKey(),
            "recipient:sponsoredZeroXlm": recipient.publicKey(),
            [`${SPONSORED_SLUG}:txHash`]: submitted.hash,
          },
          seededCount: run.seededCount + 1,
        },
      });

      console.log(`\nAttached to run ${run.runId}`);
      console.log(`  slug        ${SPONSORED_SLUG}`);
      console.log(`  reference   submission:${submission.id}`);
      console.log(`  recipient   ${recipient.publicKey()}`);
      console.log(`  sponsorship ${submitted.hash}`);
      console.log(`  XLM held    ${xlm}\n`);
    } catch (error) {
      // Horizon already accepted. Rolling back is impossible and re-running must
      // not mint a second account, so the run is marked for reconciliation and
      // the failure is reported rather than swallowed.
      await prisma.qaFixtureRun
        .update({
          where: { runId: run.runId },
          data: {
            fixtures: {
              ...fixtures,
              [PENDING_KEY]: recipient.publicKey(),
              [RECONCILE_KEY]: submitted.hash,
              [`${SPONSORED_SLUG}:sponsor`]: sponsor.publicKey(),
            },
            note: `sponsorship ${submitted.hash} landed on-chain but the fixture rows did not`,
          },
        })
        .catch(() => {
          // Even the marker failed. Say so loudly — this is the only remaining
          // record that the account exists.
          console.error(
            `[qa-sponsor] COULD NOT RECORD: sponsorship ${submitted.hash} created ` +
              `${recipient.publicKey()} on-chain, and neither the fixture rows nor the ` +
              "reconciliation marker could be written. Record this by hand.",
          );
        });
      throw error;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  if (error instanceof QaFixtureGateError) {
    console.error(`\n${error.message}\n`);
    process.exit(3);
  }
  console.error(`\n[qa-sponsor] ${(error as Error).message}\n`);
  process.exit(1);
});
