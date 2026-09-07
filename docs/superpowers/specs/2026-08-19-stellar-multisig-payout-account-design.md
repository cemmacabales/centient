# Native Stellar 2-of-3 Multisig Payout Account — Design

**Issue:** #2 · Deliverable 1 · Week 1 (security-first) · Blocks #3, #4, #5
**Date:** 2026-08-19
**Network:** Stellar **testnet**

## Why

Everything downstream depends on the payout (hot) account being a **native
Stellar multisig** so that no single key can move contributor funds. The
multisig path must be proven on-chain before any feature work begins.

## Goal

Provision a testnet payout account, configure native **2-of-3** multisig via a
single `setOptions` transaction, prove the configuration on-chain, and commit a
repeatable setup script, a read-only verifier, and a runbook.

## Signer topology (decided)

| Key                       | Role                          | Weight |
| ------------------------- | ----------------------------- | ------ |
| Master (payout account)   | provisioner / co-signer       | 1      |
| Ops signer                | operational co-signer         | 1      |
| Policy signer             | independent policy co-signer  | 1      |

Thresholds: **low = 2, med = 2, high = 2**.

Any 2 of the 3 keys sign a payment; no single key — the master included —
reaches the payment threshold. The configuration survives loss of any one key.

## Definition of Done (from the issue)

- ✅ Payout account **med/high threshold ≥ 2**, confirmed on stellar.expert (testnet).
- ✅ Signer list shows **≥ 2 independent signers**; **master key weight below the
  payment threshold** (master alone cannot pay).
- ✅ `set-options` transaction hash recorded and verifiable on-chain.
- ✅ Runbook committed to the repo.

## Components

### `lib/stellar/multisig.ts` — shared, network-free core

Pure helpers so the scripts and unit tests share one source of truth:

- `TARGET_MULTISIG` — the desired shape: `{ masterWeight: 1, low: 2, med: 2,
  high: 2, cosignerWeight: 1 }`.
- `buildSetOptionsTx({ account, masterKey, opsPublic, policyPublic })` — builds
  the unsigned `setOptions` transaction (add ops signer w=1, add policy signer
  w=1, `masterWeight=1`, `low/med/high=2`).
- `evaluateMultisig(accountRecord, { opsPublic, policyPublic })` — given a
  Horizon account record, returns `{ satisfiesDod, matchesTarget, reasons[] }`:
  - `satisfiesDod`: med ≥ 2 **and** high ≥ 2 **and** ≥ 2 non-master signers
    **and** master weight < med threshold. Drives the verifier.
  - `matchesTarget`: config already equals `TARGET_MULTISIG` exactly. Drives
    the setup script's idempotency (skip submit when already configured).

Depends on: `@stellar/stellar-sdk`, `lib/stellar/config.ts`
(`networkPassphrase`, `server`, `explorerUrl`).

### `scripts/stellar-multisig-setup.mjs` — idempotent configurator

1. Load master keypair from `STELLAR_PLATFORM_SECRET`. If absent, generate a
   fresh testnet keypair and print it (store in secrets, never commit).
2. Ensure the master account exists (friendbot-fund on testnet if not),
   mirroring `scripts/stellar-testnet-setup.mjs`.
3. Resolve signer **public** keys from `STELLAR_OPS_SIGNER_PUBLIC` /
   `STELLAR_POLICY_SIGNER_PUBLIC`. If absent, generate fresh testnet keypairs
   and print their secrets **once** with instructions to store them in a secrets
   manager.
4. Load the account; if `matchesTarget`, print `already configured` and exit 0
   without submitting (idempotent).
5. Otherwise build the `setOptions` tx via `buildSetOptionsTx`, sign with the
   master key, submit, and print the tx hash + stellar.expert link.

### `scripts/stellar-multisig-verify.mjs` — read-only on-chain assertion

Loads the account from Horizon, runs `evaluateMultisig`, prints the signer set +
thresholds and the stellar.expert account link, and exits non-zero if
`satisfiesDod` is false. Re-runnable in CI; this is the "verify on-chain via
Horizon" deliverable.

### `docs/stellar-multisig-runbook.md` — the committed runbook

Signer set + threshold table, key-custody note (keys injected at runtime from a
secrets store, out of the repo), exact commands to run setup + verify, how to
read the configuration on stellar.expert, and a recovery note (any 2 of the 3
keys can re-run `setOptions`).

### Env additions

`.env.local` doc block + example: `STELLAR_OPS_SIGNER_PUBLIC`,
`STELLAR_POLICY_SIGNER_PUBLIC` (G… **public** keys only — secrets live in the
secrets store, never in the repo).

## Testing

- **Unit** (`lib/stellar/__tests__/multisig.test.ts`, vitest, no network):
  `evaluateMultisig` against fixture account records — unconfigured single-key
  account (fails DoD), correctly configured 2-of-3 (passes DoD, matches target),
  and edge cases (master weight = threshold → fails; only 1 cosigner → fails).
- **Live proof:** run setup + verify against testnet with a friendbot-funded
  throwaway master and two generated signers; capture the real `setOptions` tx
  hash + stellar.expert link.

## Out of scope (YAGNI)

- Collecting 2 signatures in `client.ts`'s submit path (issue #3).
- Mainnet keys and secrets-manager integration code (runbook documents the
  handoff).
- Any changes to withdrawal / wallet flows.
