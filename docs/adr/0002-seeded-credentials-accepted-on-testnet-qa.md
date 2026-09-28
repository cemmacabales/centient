# ADR-0002: Accept the seeded credentials on the testnet QA environment

- **Status:** Accepted — 2026-09-09, **amended 2026-09-28** (see *Amendment: exit criteria met in code for the public testnet release* and *Amendment: live rotation out of scope*)
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

## Amendment: exit criteria met in code for the public testnet release (2026-09-28)

The second trigger in *Exit criteria* has arrived. Deliverable 4 (#48) opens
`beta.centient.work` to outside reviewers, so the deployment is about to be reachable by
users outside the team. Mainnet stays out of scope under D-7. This amendment records
which criteria the code now meets and which remain owner actions on the live environment.
The acceptance above covered internal QA only, and it ends when this lands.

**Done in code (the D4 public-release PR):**

- **The admin fallback refuses.** `prisma/seed.ts` resolves the admin password through
  `lib/seed-credentials.ts`. `ADMIN_SEED_PASSWORD` wins wherever it is set. The
  repository default is used only on *local development*, meaning a loopback
  `DATABASE_URL` with no `RAILWAY_ENVIRONMENT_ID` or `RAILWAY_PROJECT_ID`. Anywhere else
  the seed throws before it creates the account. The error names the account, not the
  default. A deploy that seeds a fresh database without the variable now fails its
  pre-deploy step rather than publishing a known `SUPER_ADMIN` login.
- **The demo account is no longer seeded outside local development.** This is the
  "stop seeding it" branch of the criterion. The `demo@centient.work` upsert resets the
  password on every run, so on a deployed environment each deploy would re-publish a
  known login. `#39` had already stopped seeding it a balance. Locally it still falls
  back to its default, and `DEMO_LABELER_PASSWORD` overrides it.
- **No password is printed.** The seed logs account identifiers only. The demo line used
  to echo its password into every Railway deploy log. `scripts/setup-env.mjs` no longer
  prints passwords either.
- **The literals are gone from `.env.local.example`.** This covers both
  `ADMIN_SEED_PASSWORD` and `INTERNAL_CUSTOMER_PASSWORD`. The README's top-of-file
  "demo accounts" block, which paired both passwords with the live admin login URL, is
  removed. The local-login table now says the defaults are local-only and burned.
  `docs/features.md` no longer quotes the admin literal.

The two literals remain in `prisma/seed.ts` as `LOCAL_ADMIN_PASSWORD` and
`LOCAL_DEMO_PASSWORD`, and in the README's local table. That is deliberate. They are
already public and treated as burned, and the only place that can use them is a
loopback database.

**Owner actions on the live environment.** The code cannot do these. They are **out of
scope** for the sprint; see *Amendment: live rotation out of scope* below:

1. **Rotate `admin@centient.work`** on `web` to a generated value held only in the
   environment. The seeder never rewrites an existing row, so rotation means updating
   `admin_users.password_hash` directly.
2. **Set `ADMIN_SEED_PASSWORD` on `web`** to that value, so a rebuilt database cannot
   fall back.
3. **Rotate `demo@centient.work` on `web` and remove any balance it still holds.** The
   seed no longer touches the existing row, so the old password stays valid until you
   change it. Alternatively, delete the row if nothing references it.
4. **Turn `SEED_ON_DEPLOY` off on staging (`web`).** Decided 2026-09-28: a long-lived
   environment is seeded as a deliberate one-off run, with the password variables set,
   not on every deploy.

**Still accepted, and why.** The repository history and the Railway deploy-log history
keep both old values permanently. The rotation above makes them useless. It does not
remove them.

## Amendment: live rotation out of scope (2026-09-28)

The owner put the four live actions above out of scope for the sprint. The Statement of
Work does not ask for them. Its security commitments cover the payout keys, which are
injected at runtime and never committed, and the multisig and daily-cap controls on the
payout rail, not the operator login.

- **Done:** everything in the code amendment above. A fresh or rebuilt database cannot be
  seeded with a published password, the demo account is not seeded outside local
  development, and no password is printed.
- **Not done:** `admin@centient.work` and `demo@centient.work` keep the passwords they were
  created with, and `SEED_ON_DEPLOY` stays on. With the code above, a seed on an existing
  database leaves both accounts untouched.
- **What this accepts:** `beta.centient.work` is now reachable by outside reviewers, and
  the `SUPER_ADMIN` login's password is in this repository's history. That login can
  write, not just read. It can ban and unban wallets, edit tasks, retry payouts, and
  create, fund and edit campaigns. Money is not at risk, because the network is testnet
  (D-7) and every payout still needs the co-signer and passes the daily cap. The risk is
  integrity: anyone holding the password can change the data that the #49 volume proof and
  the #53 gate measure. The demo account holds no balance.
- **Revisit** before any mainnet work, or at once if #49 or #53 shows admin activity that
  the team did not make.
