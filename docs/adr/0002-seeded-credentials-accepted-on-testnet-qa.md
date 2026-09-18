# ADR-0002: Accept the seeded credentials on the testnet QA environment

- **Status:** Accepted — 2026-09-09
- **Scope:** Testnet / internal QA only. Mainnet and any external user are out of scope; see *Exit criteria*.
- **Relates to:** [#87](https://github.com/webnxt-2030/Centient/issues/87) (closed by this record), [#85](https://github.com/webnxt-2030/Centient/issues/85) (QA environment provisioning), [#13](https://github.com/webnxt-2030/Centient/issues/13) (Epic 1 evidence package), [ADR-0001](./0001-simulated-cosigner-isolation.md).

## Context

Two seeded accounts on the deployed `web` service hold passwords that are public
to anyone who can read this repository or the Railway deploy logs.

**`admin@centient.work` — role `SUPER_ADMIN`.** `prisma/seed.ts` falls back to the
literal `"GoCent!123"` when `ADMIN_SEED_PASSWORD` is unset, and it is unset on
`web`. The same value appears again in `.env.local.example`. The account fronts
`app/api/admin/health`, the status-health view, and the user table, all reachable
at the deployed build URL.

One correction to how #87 stated it: the admin branch is guarded by
`if (!existingAdmin)`, so the seeder does **not** re-apply the password on every
deploy. The literal is the value the account was *created* with and still carries;
it is not rewritten each time `SEED_ON_DEPLOY` runs.

**`demo@centient.work` — a labeler.** Its password is a repository literal and is
additionally echoed in plaintext by the seed step into every Railway deploy log,
where it persists in the log history. The account is seeded holding 5 USDC of
withdrawable balance, so it is a funded account on the payout rail under a
published password.

## Decision

Accept both as internal-QA risk. Do not rotate, do not gate the seeder, do not
strip the literals, and do not de-fund the demo account before D1 QA. #87 is
closed on this basis rather than deferred.

The environment is testnet, the audience is the internal QA pass, and the Stellar
keys in it are valueless test keys. The work #87 specified is real work, but it
is security-layer work on a box that has no external users, and QA judges
end-to-end journeys rather than the permission layer. Blocking the QA handoff on
a credential rotation buys nothing that the testnet boundary is not already
buying.

## What this accepts, stated plainly

This is a decision to live with disclosure, not a finding that the exposure is
absent. Specifically:

- **The credentials are disclosed permanently.** Rotation is cheap; un-publishing
  is not. Both passwords are in the repository's history and one is in the deploy
  log history, so the exit criteria below are a rotation *and* a treatment of both
  values as burned.
- **The admin surface is reachable by anyone who reads the repo.** `SUPER_ADMIN`
  is exactly the role the health and ops views require. Unlike the Stellar keys,
  this credential's value does not come from the network being testnet.
- **The funded demo account can move QA's own numbers.** This was raised as a
  distinct concern from the credential posture — a pre-funded, withdrawable
  account sitting on the rail QA is about to exercise can pollute the results it
  produces — and it is accepted anyway. If a QA payout figure looks wrong, this
  account is the first thing to rule out.

## Consequences

- #87 closes. Its scope is not carried into a follow-up issue; this record is the
  only place the reasoning survives.
- **#13's Epic 1 evidence package must state this**, in the same way ADR-0001's
  amendment requires the isolation level to be stated at the SHA it evaluates.
  An evidence package that describes the payout rail's key separation while
  omitting a published `SUPER_ADMIN` credential on the same deployment is not
  describing what was tested.
- The literals stay in `prisma/seed.ts` and `.env.local.example` deliberately.
  This record is what stops the next reader from "fixing" them as an oversight —
  and equally, what stops the fix from being assumed to have happened.
- Nothing here is machine-enforced. ADR-0001 could bound its scope with
  `COSIGNER_ISOLATION_LEVEL` because there was a network check to hang it on;
  this one is bounded by the exit criteria below and by nothing else in the code.

## Exit criteria

Before mainnet, and before the deployment is reachable by any user outside the
team — whichever comes first:

- rotate `admin@centient.work` to a generated value held only in the environment,
  treating `GoCent!123` as burned;
- set `ADMIN_SEED_PASSWORD` on `web` and change the `prisma/seed.ts` fallback to
  refuse rather than default outside local development;
- remove both literals from `.env.local.example`;
- stop the seed step printing any password — log the account identifier alone;
- rotate `demo@centient.work` and remove its withdrawable balance, or stop
  seeding it on any environment carrying real value;
- decide whether `SEED_ON_DEPLOY` belongs on a long-lived environment at all.

## Alternatives considered

**Do the rotation before the QA handoff.** #87's original scope, and still the
right end state — it is the exit criteria above almost verbatim. Rejected for D1
because it is a security-layer task on a testnet box with no external users, and
it does not block or unblock a single QA journey.

**Keep #87 open at reduced scope**, carrying only the funded demo account and the
password echoed into the deploy logs. Rejected in favour of closing outright: a
critical-labelled issue left open on a risk that has actually been accepted reads
as an outstanding task and gets re-triaged every week. Recording the acceptance
is more honest than parking it.

**Split the cut scope into a follow-up issue.** Rejected for the same reason.
The exit criteria above serve that purpose without adding an issue that nobody
intends to action during D1.
