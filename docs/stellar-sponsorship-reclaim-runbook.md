# Stellar sponsored-reserve reclaim runbook

Issue #29 makes the reserves the platform sponsors for contributors auditable,
and reclaims them where that is safe. #27 and #28 onboard a zero-XLM contributor
by sponsoring their USDC trustline (1 base reserve) and, for a never-funded
address, their account (2 more). Each outstanding row in `sponsored_trustlines`
is that liability on the sponsor account.

## What the chain allows

Checked on testnet on 2026-09-14, before the rules below were written. The
probe's transactions are in
`docs/superpowers/specs/2026-09-14-sponsored-reserve-reclaim-evidence.json`.

| Situation | Sponsor-only `revokeSponsorship` | What happens to the reserve |
|---|---|---|
| Owner holds no XLM | fails `op_low_reserve` | stays on the sponsor |
| Owner holds enough XLM | succeeds | moves onto the owner's XLM; account and trustline stay |
| Already revoked | fails `op_not_sponsor` | already back |
| Owner removed the trustline or merged the account | fails `op_does_not_exist` | came back on its own |

So a revocation never removes the trustline a payout needs, and the chain refuses
to strand a zero-XLM contributor. **Most onboarded contributors hold no XLM, so
most reserves cannot be revoked.** For them, reclaim records the liability, and
records the release if they ever remove the entries themselves.

What the chain does not refuse is taking reserve from an owner who holds XLM.
The eligibility rules exist for that.

## Eligibility

Every outstanding sponsorship gets exactly one disposition. The rules are checked
in this order, and the first one that matches decides.

| # | Rule | Disposition | Execute run does |
|---|---|---|---|
| 1 | Row is `pending` | `sponsorship_pending` / `sponsorship_landed` / `sponsorship_never_landed` | confirms or releases the row; never revokes it |
| 2 | An earlier revocation is unseen and unexpired | `reclaim_pending` | nothing |
| 3 | Sponsor sponsors a line to an asset other than the configured USDC | `unexpected_chain_state` | nothing |
| 4 | Nothing of this sponsorship is still sponsored | `revoked` (our revocation landed) or `released_by_owner` | sets `revokedAt` and `releasedBy` |
| 5 | Address is any user's linked wallet | `protected_linked_wallet` | nothing |
| 5 | Queued/processing withdrawal, or a `PENDING` flagged withdrawal, to the address | `protected_payout_in_flight` | nothing |
| 5 | A submission paid to the address has not settled (anything but `confirmed`, `skipped`, `abandoned`, `accrued`) | `protected_unsettled_submission` | nothing |
| 5 | The row's owner has an unpaid balance | `protected_owed_balance` | nothing |
| 5 | The trustline holds USDC or has USDC on order | `protected_holds_usdc` | nothing |
| 6 | Owner's spendable XLM is below the reserve still sponsored | `owner_cannot_cover_reserve` | nothing |
| 7 | Everything else | `eligible` (dry run) | revokes, then `revoked` |

A lookup or revocation that fails is reported `failed` with an `errorCode`, and
the run moves on. Nothing is released for that row, and the next run tries again.

Rule 1 closes the risk #27 and #28 carried: a pending row whose envelope expired
unseen is released instead of counting against its owner's cap forever. It reads
the chain first, so an envelope that landed is confirmed even if Horizon no
longer returns the transaction.

## Running it

The command signs with `STELLAR_SPONSOR_SECRET`, the sponsorship key, which
`key-custody.ts` requires is no payout signer. It reads `DATABASE_URL`. Run it
where both already live, the `web` service, so no key is copied anywhere:

```bash
railway ssh --service web -- npm run stellar:sponsorship:reclaim
```

That is a **dry run**. It prints the JSON report and writes nothing to the
ledger or the chain. Read it before executing:

- `totals.byDisposition`: how many rows got each disposition.
- `totals.lockedReserveUnits`: reserves still locked after the run. Compare it
  with the sponsor's Horizon `num_sponsoring`.
- Each entry in `sponsorships[]`: address, kind, disposition, entries still
  sponsored, reserve units, and hash or error code where there is one.

To act on it:

```bash
railway ssh --service web -- npm run stellar:sponsorship:reclaim -- execute --network=testnet
```

`--network` must name the network the environment is configured for, or the
command refuses. The command exits `2` if any sponsorship ended `failed`, and
`1` if the run could not start. Capturing the output with `| tee run.json` is
safe: the command lets the report finish writing before it exits.

**Printed versus stored.** The printed report, dry run or execute, names each
sponsorship's wallet address so you can look it up on Horizon. An execute run
also stores its report in `sponsorship_reclaim_runs`, **without addresses**. Each
stored entry is keyed by `sponsorshipId`, which joins to `sponsored_trustlines`
for as long as that row exists. The stored report holds no keys, user ids,
contact data or wallet addresses; an error `detail` is stored with any account
ID in it replaced by `[address]`. Keep a printed report only as long as the task
needs it.

Execute runs are safe to repeat. A released row is no longer outstanding, and a
row with a live revocation intent is waited on, not revoked again.

## How an execute run sends a revocation

1. The revocation is built from the sponsor's current sequence: exactly one
   `revokeTrustlineSponsorship` and/or `revokeAccountSponsorship` for this
   address, sponsor as source, no memo, fee capped at 0.01 XLM per operation,
   valid 180 s. `assertRevocationShape` checks all of that, plus exactly one
   signature (the sponsor's, valid for this network), before anything is sent.
2. Its hash is written to `reclaimTxHash` **before** broadcast. The write only
   succeeds on a row with no live intent, so two runs cannot both send one.
3. Horizon's answer settles the row:
   - Accepted: `revoked`, `releasedBy = sponsor_revoke`, and the hash is kept.
   - `op_not_sponsor` / `op_does_not_exist`: the intent is dropped and the chain
     re-read. If nothing is left sponsored, the row is `released_by_owner`.
   - `op_low_reserve`: the intent is dropped; `owner_cannot_cover_reserve`.
   - `tx_bad_seq`: the hash is looked up. If it is confirmed the row is
     `revoked`; otherwise the intent is dropped and the row is `failed` until
     the next run.
   - Another definite refusal: the intent is dropped; `failed`.
   - No answer: the intent is kept, and the next run resolves it by hash.

A sponsorship build (`GET /api/me/wallet/sponsor`) uses the same sponsor
sequence. A revocation sent while a contributor is signing makes their submit
answer `409 retry`, which the wallet flow already handles by rebuilding. Run
execute when onboarding is quiet.

## Residual risks

- **Reserve in stroops is computed at run time.** `reclaimedStroops` is reserve
  units × the base reserve when the run read it. If the network changes the base
  reserve, older runs are not restated.
- **No schedule.** Reclaim is an operator workflow and no cron runs it. The
  liability stays visible between runs through wallet health's
  `sponsorshipLiability`.
- **The chain is trusted over the ledger at rule 4.** If the configured USDC
  issuer changes, rule 3 stops those rows instead of releasing them. Re-point
  `STELLAR_USDC_ISSUER` only after a dry run shows no `unexpected_chain_state`.
- **Carried from #27:** wallet health reads drift as `null` once sponsorship
  moves to a separate `STELLAR_SPONSOR_SECRET`. Compare `lockedReserveUnits`
  with the sponsor's `num_sponsoring` by hand until that is fixed.
