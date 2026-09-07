# Payout Account Multisig Runbook (native Stellar 2-of-3)

**Issue:** [#2](https://github.com/cemmacabales/centient/issues/2) · Deliverable 1 · Week 1 · Blocks #3, #4, #5

The payout (hot) account is a **native Stellar multisig**: no single key can move
contributor funds. Payments require **2 of 3** signatures. This runbook is the
source of truth for the signer set, thresholds, and the `set-options` procedure.

## Signer set & thresholds

| Key                       | Role                          | Weight |
| ------------------------- | ----------------------------- | ------ |
| Master (payout account)   | provisioner / co-signer       | 1      |
| Ops signer                | operational co-signer         | 1      |
| Policy signer             | independent policy co-signer  | 1      |

Thresholds: **low = 2, med = 2, high = 2**.

Because every signer has weight 1 and the payment (med/high) threshold is 2, any
**2 of the 3** keys can authorize a payment and **no single key — the master
included — can**. The account survives loss of any one key: the remaining two
can still sign (and can co-sign a new `set-options` to rotate the lost key — see
[Recovery / rotation](#recovery--rotation)).

## Key custody

- **Only public keys (`G…`) live in the repo / env** (`STELLAR_OPS_SIGNER_PUBLIC`,
  `STELLAR_POLICY_SIGNER_PUBLIC`). The master is referenced by
  `STELLAR_PLATFORM_SECRET`.
- **Signer secrets (`S…`) are never committed.** They are held in the secrets
  store and injected at runtime at signing time (payout flow, issue #3).
- The ops and policy signers are **independent** — held by different parties /
  stores so that compromising one does not yield two signatures.

## Configure (`set-options`)

Idempotent — safe to re-run; it no-ops once the account already matches the target.

```bash
# Testnet, generating throwaway keys (prints secrets once — store them):
STELLAR_NETWORK=testnet pnpm stellar:multisig:setup

# Initial setup with pre-provisioned keys (from the secrets store):
STELLAR_NETWORK=testnet \
STELLAR_PLATFORM_SECRET=S… \
STELLAR_OPS_SIGNER_PUBLIC=G… \
STELLAR_POLICY_SIGNER_PUBLIC=G… \
  pnpm stellar:multisig:setup
```

> **Setup is for the *initial* configuration only.** It signs with the master key
> alone, which works only while the account is still single-key (the master can
> meet the pre-config high threshold). Once the 2-of-3 is in place, changing the
> signer set is a 2-signature operation — see [Recovery / rotation](#recovery--rotation).

The script applies one `setOptions` transaction: add ops signer (w=1), add policy
signer (w=1), set `masterWeight=1`, set `low/med/high=2`. It prints the tx hash
and a stellar.expert link. The transaction shape lives in
`lib/stellar/multisig.ts` (`buildSetOptionsTx`) and is unit-tested.

On mainnet (`STELLAR_NETWORK=public`) the master account must already be funded;
the script will not friendbot-fund it.

## Verify on-chain

```bash
STELLAR_NETWORK=testnet \
STELLAR_PLATFORM_ACCOUNT=G… \
STELLAR_OPS_SIGNER_PUBLIC=G… \
STELLAR_POLICY_SIGNER_PUBLIC=G… \
  pnpm stellar:multisig:verify
```

Loads the account from Horizon and asserts the Definition of Done — med/high ≥ 2,
≥ 2 independent signers, master weight below the payment threshold — exiting
non-zero on any failure. Re-runnable in CI.

You can also read it directly:

- **stellar.expert** → account page → *Signers* and *Thresholds* panels.
- **Horizon**: `GET https://horizon-testnet.stellar.org/accounts/<G…>` →
  inspect `thresholds` and `signers`.

## Recovery / rotation

Rotating a signer changes the account via `setOptions`, which is a
**high-threshold** operation — so on the configured account it requires
**2 of the 3** signatures, exactly like a payment. The single-master
`stellar:multisig:setup` script **cannot** perform a rotation: it signs with the
master key only (weight 1 < threshold 2), so submitting a real change would fail
with `tx_bad_auth`. (Re-running it against an already-configured account just
prints `already configured` and no-ops.)

To rotate a lost/compromised key:

1. Build one `setOptions` transaction that adds the replacement signer (weight 1)
   and sets the outgoing signer's weight to 0.
2. Have **any 2 of the 3** current keys sign it (e.g. the surviving master plus
   one co-signer), collecting signatures the same way as a payout (issue #3).
3. Submit, then run `pnpm stellar:multisig:verify` to assert the new signer set.

## Testnet proof (Definition of Done)

Configured on **testnet** on 2026-09-07:

| Item | Value |
| ---- | ----- |
| Payout account | [`GC5UOKLU6J2EROZYYP2I23ZEF4YF42TGGRNQMMTGOJGJ7NOCH3TTR4A6`](https://stellar.expert/explorer/testnet/account/GC5UOKLU6J2EROZYYP2I23ZEF4YF42TGGRNQMMTGOJGJ7NOCH3TTR4A6) |
| `set-options` tx | [`8a16d6236cbb0aa1887eba35f6b4b04e41e289532df06b1d13413551e8fc1ad5`](https://stellar.expert/explorer/testnet/tx/8a16d6236cbb0aa1887eba35f6b4b04e41e289532df06b1d13413551e8fc1ad5) |
| Thresholds | low=2, med=2, high=2 |
| Signers | master (w=1) + ops (w=1) + policy (w=1) — 2-of-3 |

Horizon confirmation, as printed by `pnpm stellar:multisig:verify`:

```json
"thresholds": { "low_threshold": 2, "med_threshold": 2, "high_threshold": 2 }
"signers": [
  { "weight": 1, "key": "GC5UOKLU6J2EROZYYP2I23ZEF4YF42TGGRNQMMTGOJGJ7NOCH3TTR4A6" },  // master
  { "weight": 1, "key": "GDNL2OG7XGBHTPNW4WQAT7AVLXYFHAP76DVYFMSKIZLP47KYMOLS27V3" },  // ops
  { "weight": 1, "key": "GB6NBHA5ML3DOAQXBSDRNYVJUE6B3VPEP2BH5ZXPL5D6YZV5DJC6IWLI" }   // policy
]
```

> These are **throwaway testnet keys**. Provision fresh keys held in the secrets
> store for any account that will hold real value.

### Superseded proof

The first proof, configured 2026-08-19 on account
[`GAFGVTR2TMPQZWWYUNIAOTFTIFPRUODUD4LB5M2IRA6ORLE4CCPXS7OK`](https://stellar.expert/explorer/testnet/account/GAFGVTR2TMPQZWWYUNIAOTFTIFPRUODUD4LB5M2IRA6ORLE4CCPXS7OK)
(`set-options` tx `6446ef5b30d3df9f1e12cebf0afb369e895c4d94b4402b07fd300732c92ae142`),
is still correctly configured on-chain and still verifies. It was replaced
because its three signer **secrets** were not retained, so nothing downstream can
produce the two signatures a payment needs — the account proves the topology but
cannot be operated. Treat it as a historical artifact; the account above is the
one the payout rail uses.

**Custody lesson:** a multisig proof is only useful if the signing material
survives with it. Whoever provisions the mainnet account records all three keys
in the secrets store *before* the `set-options` transaction is submitted.
