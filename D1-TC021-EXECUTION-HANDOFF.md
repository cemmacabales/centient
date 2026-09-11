# D1 TC-021 Testnet Refill Execution Handoff

## Objective

Complete D1 test case TC-021 legitimately on Stellar Testnet: execute one cold-reserve refill through the existing two-custodian ceremony, verify the settled transaction and resulting balances, then update the final QA workbook and PDF from `PENDING` to `PASS`.

Do not simulate the transaction, directly top up the hot wallet, or mark TC-021 complete without public settlement evidence.

## Current state

- The final QA record currently contains 27 `PASS` cases and one `PENDING` case: D1 TC-021.
- Final workbook: `/Users/cemmacabales/centient/outputs/f01-final/CentientD1REVISED-FINAL.xlsx`
- Final PDF: `/Users/cemmacabales/centient/output/pdf/Centient-D1-F01-Final-QA-Record.pdf`
- Source handoff: `/Users/cemmacabales/centient/CODEX-HANDOFF-F01.md`
- Deployed staging candidate commit: `263be4cd5ab06103d965044c6a8bd3c40678f308`
- Latest observed Testnet balances at the earlier check:
  - Hot: `17.9900001 USDC`
  - Cold: `26.9000000 USDC`
  - Computed refill: `17.0099999 USDC`
  - Projected cold balance: `9.8900001 USDC`
- Policy values at that check: trigger `30 USDC`, target `35 USDC`, minimum cold balance `5 USDC`.

These balances are only a historical snapshot. Re-read live Testnet state immediately before preparing and submitting.

### Expired transaction warning

An earlier unsigned transaction with SHA-256 `446e320e9976c113faee794618040a654d88f9de588488c5af0bbdb8fdcc6ba0` expired at `2026-09-11T08:33:47Z`. It is unusable. Do not sign or submit it. Prepare a fresh transaction after checking live balances.

## Fixed Testnet identifiers

- Network: Stellar Testnet
- Hot account: `GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO`
- Cold account: `GDPGRS4P6UZZK23CKKELGLJAYTCAWPV4C7TH6Q322SF735A5H6U5XK5G`
- USDC issuer: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`
- Cold thresholds: low/medium/high = `2/2/2`
- Authorized cold signers, each weight 1:
  - `GAOTECDRSB5HHAJAMOOMUYTDOR5HTFNSSETEDNWJDXDFRBZVQMOOXD6V`
  - `GDERX2QG4LY4SK6VHBX5VRKE2PFDB25ZCD3OLUM4RDVAY43EOXBRZ4BC`

The refill requires two distinct valid signatures. Never copy, print, log, commit, or transmit either secret seed outside its custodian's isolated signing environment. Do not add a cold seed to Railway or any deployed service.

## Relevant implementation

- `scripts/stellar-reserve-refill.ts`
- `lib/stellar/reserve-refill.ts`
- `docs/stellar-cold-reserve-runbook.md`
- `lib/stellar/__tests__/reserve-refill.test.ts`
- `app/api/cron/reserve-refill/__tests__/route.test.ts`

The HTTP route is deliberately planning-only. The authorized flow is `status` -> `prepare` -> custodian A `sign` -> custodian B `sign` -> keyless `submit`. A prepared XDR expires after 15 minutes.

## Railway target

- Project: `centient-work` (`82afbc8d-0496-410e-a6bd-13671ca71cb4`)
- Environment: `production` (`573f206e-d597-4048-9a60-5dd7e80c8c77`), which is the deployed staging candidate
- Web service: `abc55a71-1cd3-4cef-949c-08ce92c2fc34`
- Cosigner service: `50e55c46-df49-431c-a10f-1b3c56672b96`

Set the CLI telemetry prefix for Railway calls:

```bash
export RAILWAY_CALLER=skill:use-railway@1.4.0
export RAILWAY_AGENT_SESSION=railway-skill-centient-tc021-20260911
```

The deployed `NEXT_PUBLIC_EXPLORER_URL` currently points to Celo Sepolia. That stale display setting does not affect Horizon submission, but it can produce a wrong explorer link in CLI output. Build the evidence link from the settled Stellar Testnet transaction hash using the canonical Stellar explorer; do not copy the stale link.

## Execution procedure

### 1. Establish a fresh baseline

Work from current `develop` on a new `codex/` branch if any repository changes are required. Install dependencies, read the runbook, and run the focused tests:

```bash
npm ci
npx vitest run lib/stellar/__tests__/reserve-refill.test.ts app/api/cron/reserve-refill/__tests__/route.test.ts
```

Expected baseline: all 90 focused tests pass.

Read live Testnet status through the deployed web-service configuration:

```bash
railway run \
  --project 82afbc8d-0496-410e-a6bd-13671ca71cb4 \
  --environment 573f206e-d597-4048-9a60-5dd7e80c8c77 \
  --service abc55a71-1cd3-4cef-949c-08ce92c2fc34 \
  --no-local -- \
  node node_modules/tsx/dist/cli.mjs scripts/stellar-reserve-refill.ts status
```

Confirm the network and account identifiers above, the live hot and cold USDC balances, the current trigger/target/minimum policy, and that a refill is still required. Stop if any invariant differs unexpectedly.

### 2. Prepare immediately before the ceremony

Run the same Railway command with `prepare` instead of `status`. Record the exact amount-units and unsigned XDR in a private, short-lived transfer package. Record its creation time and expiry. Do not commit the package or paste it into a PR, issue, chat, or public log.

Re-run `status` just before the signing window. If the hot balance or policy changed, discard the prepared XDR and prepare again.

### 3. Collect two isolated custodian signatures

Custodian A signs in the first isolated environment using signer A's secret supplied by that environment's secret manager:

```bash
STELLAR_RESERVE_REFILL_AMOUNT_UNITS='<exact-prepared-units>' \
STELLAR_RESERVE_REFILL_XDR='<unsigned-xdr>' \
STELLAR_COLD_SIGNER_SECRET='<injected-custodian-a-secret>' \
npm run stellar:reserve:refill -- sign
```

Transfer only the resulting partially signed XDR and the exact amount to custodian B. Custodian B repeats `sign` in a separate isolated environment using signer B's secret. Verify the two signer public keys are distinct and match the configured signer list.

Do not handle both seeds in one process, host, shell history, clipboard, or operator-controlled file. A convenience wizard may exist locally at `tmp/d1-tc021/custodian-sign-wizard.sh`, but it is ignored by Git and is not authoritative; inspect it before use and rely on the runbook and CLI validation.

### 4. Submit without a signing secret

Before submission, confirm the XDR has not expired and the live policy still permits the exact prepared refill. Submit the twice-signed XDR from an environment where `STELLAR_COLD_SIGNER_SECRET` is absent:

```bash
env -u STELLAR_COLD_SIGNER_SECRET \
  STELLAR_RESERVE_REFILL_AMOUNT_UNITS='<exact-prepared-units>' \
  STELLAR_RESERVE_REFILL_XDR='<twice-signed-xdr>' \
  npm run stellar:reserve:refill -- submit
```

If submission fails or the transaction expires, do not reuse it. Return to the live-status check and prepare a new transaction.

## Settlement verification

Immediately after submission, capture public evidence and independently verify all of the following:

1. The transaction succeeded on Stellar Testnet and has a public transaction hash.
2. The envelope contains two distinct valid signatures authorized on the cold account.
3. It contains exactly one intended USDC payment from the configured cold account to the configured hot account for the prepared amount.
4. The hot USDC balance reaches the current `35 USDC` target.
5. The cold USDC balance remains at or above the current `5 USDC` minimum.
6. No secret, signed XDR, or private approval material appears in logs or version control.

If a payout or policy change during the ceremony prevents the hot balance from reaching the current target, do not mark TC-021 `PASS`. Reconcile the live state and execute a fresh authorized ceremony if still required.

## QA artifact update

Only after all settlement checks pass:

1. Update the TC-021 row in the final workbook with `PASS`, the UTC execution timestamp, the public Stellar Testnet transaction hash/link, the exact amount and before/after balances, and a concise note that two configured custodian signatures were verified.
2. Confirm the workbook tally is 28 `PASS`, zero `PENDING`, and zero failed cases.
3. Regenerate the final PDF from the updated workbook/source of truth.
4. Render and visually inspect the modified workbook sheets and every PDF page. Confirm TC-021, summary totals, wrapping, pagination, and links are legible and consistent.
5. Preserve the existing final artifact names unless the repository's established workflow requires a versioned replacement.

Do not include the signed XDR or either secret seed in the workbook, PDF, commit, or PR.

## Version-control requirements

- Start from `develop`; use a `codex/` branch.
- Commit only intended handoff/artifact changes. Leave unrelated files such as `graphify-out/` untouched.
- Author and committer must be `cemmacabales <carlmacabales31@gmail.com>`.
- Do not add co-author or automated-tool attribution.
- Push only to `https://github.com/cemmacabales/centient` and open a PR targeting upstream `develop`.
- Do not merge without explicit authorization.

## Completion criteria

TC-021 is complete only when there is a settled public Stellar Testnet transaction satisfying every invariant above, the hot and cold balances meet current policy, the workbook and PDF show 28/28 passing cases with consistent evidence, focused tests and artifact validation pass, and the changes are committed and proposed to `develop` without exposing approval material.
