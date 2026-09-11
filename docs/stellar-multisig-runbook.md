# Payout Account Multisig Runbook (native Stellar 2-of-3)

**Issue:** [#5](https://github.com/webnxt-2030/Centient/issues/5) · Deliverable 1 · Week 1 · Blocks #6, #7, #8

The payout (hot) account is a **native Stellar multisig**: no single key can move
contributor funds. Payments require **2 of 3** signatures. This runbook is the
source of truth for the signer set, thresholds, and the `set-options` procedure.

> **Deployed account, as of 2026-09-09.** The payout rail on the deployed build
> (`bbaf4266684e799e84212e6059751b1d1099f3c8`) uses
> [`GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO`](https://stellar.expert/explorer/testnet/account/GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO) —
> thresholds 2/2/2, three weight-1 signers, `set-options`
> [`e966c0a5…30fd`](https://stellar.expert/explorer/testnet/tx/e966c0a5c27cbe0253f2812d158b38f8e91513de48254923f9ecb6f4c19630fd),
> and a two-signature 1 USDC payout
> [`5083dd72…8206`](https://stellar.expert/explorer/testnet/tx/5083dd72a16bfa749c6b302c293e931939acd70cc52f63586443921d60698206).
> **Every account, signer and transaction recorded further down this document
> belongs to an earlier account and is historical.** It is correct, still
> verifies on-chain, and is retained as evidence of the work — but it is not the
> account under test. Verify the deployed account above.

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

# Initial setup with pre-provisioned keys (see "Key custody" below for where they live):
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

## Testnet proof — historical (Definition of Done, 2026-09-07)

> **Historical.** This proof records the account the rail used on
> 2026-09-07. The deployed build uses the account named in the notice at
> the top of this document. Both are correctly configured 2-of-3
> accounts on testnet, which is exactly why the distinction matters: a
> threshold check against this account would pass while saying nothing
> about the build under test.

Configured on **testnet** on 2026-09-07:

| Item | Value |
| ---- | ----- |
| Payout account | [`GC5UOKLU6J2EROZYYP2I23ZEF4YF42TGGRNQMMTGOJGJ7NOCH3TTR4A6`](https://stellar.expert/explorer/testnet/account/GC5UOKLU6J2EROZYYP2I23ZEF4YF42TGGRNQMMTGOJGJ7NOCH3TTR4A6) |
| `set-options` tx | [`8a16d6236cbb0aa1887eba35f6b4b04e41e289532df06b1d13413551e8fc1ad5`](https://stellar.expert/explorer/testnet/tx/8a16d6236cbb0aa1887eba35f6b4b04e41e289532df06b1d13413551e8fc1ad5) |
| Thresholds | low=2, med=2, high=2 |
| Signers | master (w=1) + ops (w=1) + policy (w=1) — 2-of-3 |

Horizon confirmation, as printed by `pnpm stellar:multisig:verify` — copy-pasteable
as valid JSON, with the signer roles listed beneath rather than as comments:

```json
{
  "thresholds": { "low_threshold": 2, "med_threshold": 2, "high_threshold": 2 },
  "signers": [
    { "weight": 1, "key": "GC5UOKLU6J2EROZYYP2I23ZEF4YF42TGGRNQMMTGOJGJ7NOCH3TTR4A6" },
    { "weight": 1, "key": "GDNL2OG7XGBHTPNW4WQAT7AVLXYFHAP76DVYFMSKIZLP47KYMOLS27V3" },
    { "weight": 1, "key": "GB6NBHA5ML3DOAQXBSDRNYVJUE6B3VPEP2BH5ZXPL5D6YZV5DJC6IWLI" }
  ]
}
```

- `GC5UOKLU…H3TTR4A6` — master
- `GDNL2OG7…MOLS27V3` — ops co-signer
- `GB6NBHA5…DJC6IWLI` — policy co-signer

> These are **throwaway testnet keys**. Provision fresh keys held in the secrets
> store for any account that will hold real value.

### Earlier superseded proof

The first proof, configured 2026-08-19 on account
[`GAFGVTR2TMPQZWWYUNIAOTFTIFPRUODUD4LB5M2IRA6ORLE4CCPXS7OK`](https://stellar.expert/explorer/testnet/account/GAFGVTR2TMPQZWWYUNIAOTFTIFPRUODUD4LB5M2IRA6ORLE4CCPXS7OK)
(`set-options` tx [`6446ef5b30d3df9f1e12cebf0afb369e895c4d94b4402b07fd300732c92ae142`](https://stellar.expert/explorer/testnet/tx/6446ef5b30d3df9f1e12cebf0afb369e895c4d94b4402b07fd300732c92ae142)),
is still correctly configured on-chain and still verifies. It was replaced
because its three signer **secrets** were not retained, so nothing downstream can
produce the two signatures a payment needs — the account proves the topology but
cannot be operated. Treat it as a historical artifact; the account above is the
one the payout rail uses.

**Custody lesson:** a multisig proof is only useful if the signing material
survives with it. Whoever provisions the mainnet account records all three keys
in the shared secrets store *before* the `set-options` transaction is submitted.

## Key custody — state of the historical account

There is **no secrets-store integration today.** Every script and the payout
service read plain environment variables (`STELLAR_PLATFORM_SECRET`,
`STELLAR_OPS_SIGNER_SECRET`, `STELLAR_POLICY_SIGNER_SECRET`); nothing fetches a
key from a vault at runtime. On testnet the three secrets for the account above
exist only in the gitignored `.env.local` of the machine that provisioned it.

That is enough to develop and run the #6 spike and the #7 payout service
locally, and it is *not* enough for any other checkout, teammate, or CI runner —
for them the account is as inoperable as the superseded one. Before anything
beyond local work depends on this account:

1. Copy all three secrets into the shared secrets store (owner: whoever holds
   the provisioning machine; tracked in #73).
2. Wire the deployment to inject **only** `STELLAR_PLATFORM_SECRET` and
   `STELLAR_OPS_SIGNER_SECRET` from that store. The policy signer's seed is
   never placed in the application deployment: its only consumer is the
   independent co-signer service (#8), which runs on separate infrastructure
   with its own key store. `STELLAR_POLICY_SIGNER_SECRET` in an application
   environment is a testnet-only affordance for local proofs and is refused
   on the public network, so until #8 exists production payouts fail closed —
   the payout service throws before building anything rather than degrading
   to a single signature.

If the secrets are lost first, re-run `pnpm stellar:multisig:setup`, take a new
proof, and update this section again.
