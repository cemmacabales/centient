# QA Fixtures Runbook — Deliverable 1

The fixtures put the database into every payout state and recipient shape the D1
test cases name, so their preconditions are met by something reproducible rather
than by hand-built rows. This is B9 on [#86](https://github.com/webnxt-2030/Centient/issues/86).

**Everything here is Stellar Testnet.** The commands refuse to run otherwise.

---

## The three commands

```bash
pnpm qa:fixtures seed      # create one run's fixtures
pnpm qa:fixtures status    # list recent runs
pnpm qa:fixtures reset     # remove the most recent un-reset run
```

Plus one network command, run only when you reach TC-006:

```bash
pnpm qa:recipients:sponsor # mint the zero-XLM sponsored recipient
```

`reset` takes an optional run id: `pnpm qa:fixtures reset m9x1k4ab12`.

### Before the first run

The fixtures attach to the admin the ordinary seed creates, rather than seeding
another credential of their own — that surface is what [#87](https://github.com/webnxt-2030/Centient/issues/87)
is open about. So `pnpm db:seed` must have run at least once, or `seed` refuses
and says so.

Required environment:

| Variable | Why |
| --- | --- |
| `STELLAR_NETWORK=testnet` | Must be set **explicitly**. Unset is a refusal, not a default. |
| `DATABASE_URL` | The database to seed. |
| `DAILY_PAYOUT_CAP_UNITS` | Optional. Decides the cap fixtures; `0` skips them. |

These commands are **not** part of `pnpm db:seed`. `SEED_ON_DEPLOY` is enabled on
`web`, so `db:seed` runs on every production deploy; a QA branch inside that path
would be one mis-set variable away from writing fixture payouts into the
environment under test, unasked, on every deploy.

---

## What one run produces

### The six payout states

Each is a `Submission`. Reference them as `submission:<id>` — the run record maps
every slug to the id it got.

| Slug | `payoutStatus` | Hash | Recipient | Cases |
| --- | --- | --- | --- | --- |
| `qa-validated` | `pending` | — | with trustline | TC-008, TC-013, TC-017 |
| `qa-non-validated` | `skipped` | — | with trustline | TC-014 |
| `qa-already-paid` | `sent` | yes | with trustline | TC-008, TC-014 |
| `qa-cap-deferred` | `pending` | — | with trustline | TC-017 |
| `qa-failed-permanent` | `failed` | — | **without** trustline | TC-012 |
| `qa-needs-reconciliation` | `needs_reconciliation` | yes | with trustline | TC-010, TC-011 |

Two of these look similar and are not. **`qa-already-paid` is refused on its
hash; `qa-non-validated` is refused on its status.** `assertLedgerAgrees` checks
for a hash *before* it reads status, so those are genuinely different code paths
— and a co-signer regression that broke one would still produce a refusal for the
other. Record which reason the refusal gave, not just that one arrived.

**`qa-failed-permanent` sits on `failed`, which is a signable status.** That is
not a mistake. `SIGNABLE_STATUSES.submission` is `["pending", "failed"]`, because
`reprocessPayoutWithNonceSafety` legitimately retries a submission whose broadcast
never produced a hash. What makes this fixture permanent is its spent retry budget
and its `REFUND` ledger row, not its status.

**`qa-needs-reconciliation` is deliberately not refunded.** The funds left the
wallet; refunding the campaign as well would be a double-spend.

### Recipient shapes

Three are pinned in `lib/qa-fixtures/recipients.testnet.json` and reused across
runs, so on-chain cross-references hold:

| Shape | State on testnet | Expect |
| --- | --- | --- |
| `withTrustline` | funded, holds the USDC trustline | payable |
| `withoutTrustline` | funded, no trustline | permanent `op_no_trust` |
| `neverCreated` | never created on-chain | permanent no-destination |

The zero-XLM sponsored shape (TC-006) is **not** pinned. That case tests the
sponsorship event itself, which happens once per address — against an
already-sponsored account it is unobservable. Mint it per run, when you are about
to run TC-006:

```bash
pnpm qa:recipients:sponsor
```

It creates the account and its USDC trustline in one CAP-33 sponsored
transaction, attaches it to the active run as a payable submission under
`qa-sponsored-zero-xlm`, and prints the sponsorship hash. The account holds
**0.0000000 XLM** — that is the property TC-006 is about.

It sponsors from `STELLAR_PLATFORM_SECRET` when one is set. Without it, it mints
an ephemeral friendbot-funded sponsor, so the shape can be produced on a machine
holding no platform secret. Running it twice against one run is refused: the
sponsorship happens once per address, so a second one needs a fresh run.

**If it refuses with an unfinished or unreconciled sponsorship.** Horizon
accepting the sponsorship is irreversible and consumes real platform reserves, so
the command writes the recipient key to the run *before* it submits. That means a
crash leaves a marker rather than silence, and the command refuses to mint a
second account against the same run — a second one would strand the first, which
holds reserves nothing points at.

| Refusal | What happened | What to do |
| --- | --- | --- |
| unfinished sponsorship for `G…` | It wrote the marker; the submit may or may not have landed | Look the account up on Horizon. Exists → reconcile it. Does not exist → the submit never landed. Either way, reset and re-seed. |
| sponsorship awaiting reconciliation (tx `…`) | Horizon accepted, but the fixture rows did not get written | The account is real. Reconcile it against that hash before minting another, then reset and re-seed. |

This is the same failure shape as D1-TC-011 — an accepted transaction whose
record did not land — and it is handled the same way: record for reconciliation,
never roll back, never silently retry.

### Twelve payable references

`qa-payable-01` … `qa-payable-12`, all pending against the trustline recipient,
for TC-009 and TC-019.

> Worth knowing: #86 justifies twelve by pointing at
> `payout-concurrency-db.test.ts`, which actually races `WORKERS = 8`. The twelve
> belongs to `payout-submitter.test.ts`. TC-009 itself only requires "two or
> more", so twelve satisfies every reading — but don't cite the wrong file.

### The cap boundary (TC-017)

`getPayoutActivitySince` sums `PayoutJob` rows with a hash whose `broadcastAt`
falls in the trailing 24 hours. The seed writes one settled withdrawal that
consumes the cap down to a **3 USDC headroom**, then three submissions:

| Slug | Amount | Expect |
| --- | --- | --- |
| `qa-cap-below` | headroom − 1 unit | allowed |
| `qa-cap-at` | exactly the headroom | allowed, exhausts the cap |
| `qa-cap-above` | headroom + 1 unit | refused |

The already-broadcast fixtures are dated **48 hours back on purpose**, outside the
window, so they don't consume the allowance the cap fixtures are positioning. If
you re-date them, the boundary amounts stop being correct.

If `DAILY_PAYOUT_CAP_UNITS` is `0` the cap is disabled entirely and these
fixtures are skipped, with the reason printed and stored on the run record.

---

## The reset contract

Three rules, and what enforces each:

**1. Never delete or rewrite a row carrying a transaction hash.**

Two fixtures must carry one, so the reset can't simply skip hashed rows. It
discriminates on the hash's *shape*: a Horizon hash is 64 hex characters, and
fixture hashes are minted as `qa-<runId>-<n>`, which can never match. A row is
removable only if its hash is absent **or** recognisably ours. Anything else —
entered by hand, written by another tool — is preserved rather than guessed at.

This is shape rather than a marker column on purpose. A marker would mean the
reset trusts the seeder's own claim about which rows are synthetic, and a row
mislabelled by a bug would be deleted despite carrying real funds.

**2. Never reuse a payout reference across runs.** Slugs are stable so you can
address a fixture by meaning; the ids behind them are fresh every run. The run
record maps one to the other.

**3. Record every reset.** `qa_fixture_runs` holds the run id, the SHA, the
network, the slug→id map, and what a reset removed or refused to remove.

### When a reset preserves something

```
PRESERVED — these rows were NOT deleted:
  submission 3830fd60-…
    hash 62f5e67eb0f3…  (real-broadcast)
```

`real-broadcast` means **funds actually moved for that reference.** Investigate
before re-seeding; do not delete the row to tidy up. The campaign is deliberately
left in place too, because deleting it would orphan the record of the payment.

`unrecognised-hash` means something wrote a hash the fixtures don't recognise.
Same rule: look before touching.

---

## Re-provisioning the pinned recipients

Only if the manifest is missing or its accounts are gone:

```bash
pnpm qa:recipients:provision
```

It generates three keypairs, friendbot-funds two, adds a USDC trustline to one,
and rewrites the manifest. **Commit the result** — the seed command reads it and
makes no network calls. It needs no platform, sponsor, or issuer secret: each
recipient signs its own trustline, and only public keys are written.

New addresses change the fixtures' destinations, so any on-chain evidence QA
already gathered refers to the old ones. Re-provision deliberately, not casually.

---

## Evidence for #80

- `pnpm qa:fixtures status` — the run record, with SHA and network.
- The `qa_fixture_runs` row — slug→id map, seeded/deleted/preserved counts.
- `lib/qa-fixtures/__tests__/fixtures-db.test.ts` — B9's exit condition as an
  executable assertion: one rehearsal produces every state and shape, and a reset
  leaves a real-hash row standing.
