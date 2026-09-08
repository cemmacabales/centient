# QA Fixtures and Reset Path Design

## Goal

Give Deliverable 1 QA one command that puts the database into every payout state
and recipient shape the test cases require, and one command that returns it to a
known baseline without ever concealing a payment that actually settled on-chain.

B9 is the blocker this closes. Seven of the twenty-eight cases in
`Centient_D1_Test_Cases.docx` — TC-004, TC-008, TC-009, TC-012, TC-014, TC-017
and TC-019 — have preconditions no one can currently satisfy without
hand-building rows and guessing at column values. Fabricating a state by hand is
not testing it; the fixture has to be produced by something that encodes what the
production code actually believes about each state.

## Placement, and why not `db:seed`

The fixtures live in `lib/qa-fixtures/` with a thin CLI in `scripts/qa-fixtures.ts`,
following the seam the repository already uses for operational tooling
(`lib/stellar/reserve-refill.ts` paired with `scripts/stellar-reserve-refill.ts`).

They are deliberately **not** added to `prisma/seed.ts`'s `main()`. `SEED_ON_DEPLOY`
is enabled on the `web` service, so `db:seed` executes on every production deploy.
A QA-only branch inside that path would be one mis-set environment variable away
from seeding fixture payouts into the environment under test, and would run
unbidden on every deploy. `db:seed` and its deploy-time behaviour are untouched by
this work. The fixture module reuses seed.ts's idioms — upsert style, explicit
console reporting, bcrypt cost 12 — without sharing its entry point.

## What each payout state actually is

The co-signer's refusal order is the specification, not the issue's prose.
`assertLedgerAgrees` in `lib/stellar/cosigner-ledger.ts` rejects in this order:
missing row, kind mismatch, **hash present**, status not signable, missing
destination, destination mismatch, missing amount, amount mismatch. Hash is
checked before status, and `SIGNABLE_STATUSES.submission` is `["pending", "failed"]`.

That pins six fixtures precisely:

| Slug | `payoutStatus` | `payoutTxHash` | Recipient shape | What it proves |
| --- | --- | --- | --- | --- |
| `qa-validated` | `pending` | null | with trustline | the signable baseline (TC-008, TC-013, TC-017) |
| `qa-non-validated` | `skipped` | null | with trustline | refusal on status, isolated from hash (TC-014) |
| `qa-already-paid` | `sent` | set | with trustline | refusal on hash, which is checked first (TC-008, TC-014) |
| `qa-cap-deferred` | `pending`, `retryCount 0` | null | with trustline | cap refusal left the debit reserved (TC-017) |
| `qa-failed-permanent` | `failed`, retries spent | null | without trustline | permanent rail error, balance refunded (TC-012) |
| `qa-needs-reconciliation` | `needs_reconciliation` | set | with trustline | terminal, no refund (TC-010/TC-011 evidence) |

`qa-failed-permanent` uses `failed`, which *is* a signable status. It is
distinguished from `qa-non-validated` by its spent retry budget and its `REFUND`
ledger row, not by signability. That is deliberate in the production code —
`reprocessPayoutWithNonceSafety` retries a submission whose broadcast never
produced a hash — and the fixtures respect it rather than papering over it.

`qa-needs-reconciliation` does not require fault injection. B4's open question is
how to reach that state through the live submit path; a fixture writes the
terminal row directly, which is a different problem and an already-solved one.

## Recipient shapes: three pinned, one minted per run

A separate one-time script provisions testnet accounts and writes
`lib/qa-fixtures/recipients.testnet.json`, which is committed. The fixture command
reads that manifest, makes no network calls, and needs no sponsor secret. Stable
addresses matter because QA cross-references on-chain evidence across runs.

Three shapes pin cleanly: funded with a USDC trustline, funded without one, and a
never-created address for the no-destination classification.

The zero-XLM sponsored shape cannot be pinned. TC-006's precondition is a
recipient that begins with effectively no spendable XLM, and its second step is to
complete the sponsorship and trustline preparation. That is a one-time event per
address — against an already-sponsored account the case is unexecutable. So the
sponsored recipient is minted fresh on each fixture run, gated behind the same
testnet check, and recorded in the run row.

TC-004 asks for a "fresh valid recipient" but its evidence requirement is
before/after balances, which a pinned address satisfies by delta. It stays pinned.

## Cap usage is a fixture, not a side effect

TC-017 needs payouts just below, exactly at, and just above the daily cap;
TC-019 needs a near-cap remaining allowance. `getPayoutActivitySince` sums
`PayoutJob` rows where `broadcastAt` is inside the trailing 24 hours and `txHash`
is not null, with no constraint on hash shape. Rolling usage is therefore itself
seedable: the fixtures write settled `PayoutJob` rows with chosen amounts and
broadcast times to place the remaining allowance at each boundary.

Three presets are produced — `below`, `at`, `above` — computed from
`getDailyPayoutCapUnits()` at seed time so the fixtures stay correct when the
configured cap changes.

The cap is a check and not a reservation, which is the residual race TC-019 exists
to document. The fixtures set up the observation; they do not change the property.

## Determinism against reference non-reuse

These two requirements conflict directly. A deterministic seeder wants stable row
ids; the reset contract forbids reusing a payout reference across runs, and a
reference *is* `submission:<id>` or `payout_job:<id>` (`PayoutReference` in
`lib/stellar/payout-envelope.ts`).

The resolution is to separate the name from the identity. Every fixture carries a
stable slug so QA addresses it by meaning, and the slug is recorded on the run row
alongside the id it resolved to on that run. The rows themselves take fresh UUIDs
every time, so no payout reference is ever reused. The run id ties a slug to the
identity it had on a given run, which is what makes an evidence trail readable
after the fact.

## The reset, and the rule that makes it safe

Reset obeys three rules. Two are structural consequences of the design above; the
first needs a real mechanism.

**Never delete or rewrite a row carrying a transaction hash.** Two fixture states
must carry a hash, so a blanket "skip anything with a hash" rule would make them
permanently un-resettable. The discriminator is the hash's shape rather than a
flag the seeder sets about itself: a Horizon transaction hash is 64 lowercase hex
characters, and fixture hashes are minted as `qa-<runId>-<n>`, which can never
match that pattern. Reset therefore deletes only rows where `payoutTxHash` is null
or fails `/^[0-9a-f]{64}$/`.

This matters more than it looks. A self-attested marker column would mean a reset
trusts the seeder's own claim about which rows are synthetic; a row mislabelled by
a bug would be deleted despite carrying real funds. Shape is checkable
independently of anything the seeder recorded, so a real broadcast is undeletable
by construction. Nothing in the codebase validates hash shape on write, so this
imposes no constraint on production behaviour.

**Never reuse a payout reference.** Free, given fresh UUIDs per run.

**Record every reset.** A new `QaFixtureRun` model records the run id, the git
SHA, the active network, seeded and deleted counts, the number of rows skipped
because they carried a real hash, the slug-to-id map, and timestamps for seed and
reset. It survives the fixture data it describes and is queryable from the
deployed environment, which is what lets QA cite it as evidence for the B9
rehearsal pass.

## Failing closed

The fixture and reset commands both refuse unless `stellarNetwork()` returns
`testnet`, the manifest's declared network matches the active one, and
`DATABASE_URL` is set. This mirrors the refusal shape `resolvePayoutCoSigner`
already uses for the public network, including treating an empty
`STELLAR_NETWORK` as unset rather than letting it slip past the check.

The provisioning script carries the same gate plus an explicit opt-in, following
the `STELLAR_ALLOW_TESTNET_KEY_GENERATION` precedent, because it mints keys.

## Testing

Unit coverage sits on the decisions rather than the plumbing: the reset predicate,
including the case that matters most — a row carrying a real 64-hex hash survives
a reset — each gate refusal, and the cap preset arithmetic against a configured
cap.

One database round-trip test through the existing `tests/helpers/db.ts` harness
asserts that a single rehearsal produces all six states and all four shapes, and
that a reset afterwards leaves the hashed rows standing while clearing the rest.
That test is B9's stated exit condition expressed as an assertion, so the exit
condition cannot silently stop being true.

## Out of scope

No production payout path changes. B10 (the CI push trigger) and B4 (the
fault-injection acceptance write-up) are separate items on the same issue and are
not addressed here.
