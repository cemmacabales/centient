# Payout rail

How a USDC reward moves from Centient to a contributor, and why no single key or server can move it alone. Built in [Deliverable 1](../deliverables/d1.md).

## The accounts

```
                ┌────────────────────────────┐
                │  Cold reserve  (2-of-3)    │   bulk USDC; its signers are
                │  no deployed service holds │   not held by any deployed
                │  a cold seed               │   service
                └─────────────┬──────────────┘
                              │ refill: multisig-approved,
                              │ restores the float to exactly the target
                              ▼
                ┌────────────────────────────┐
                │  Payout account (2-of-3)   │   the hot wallet; bounded float
                │  master · ops · policy     │   thresholds 2 / 2 / 2
                │  each weight 1             │
                └─────────────┬──────────────┘
                              │ USDC payment, 2 signatures,
                              │ wrapped in a Centient fee bump
                              ▼
                ┌────────────────────────────┐
                │  Contributor's own wallet  │   holds no XLM, pays no fee
                └────────────────────────────┘
```

| Account | Role | Thresholds |
| --- | --- | --- |
| [`GCP34RIT…4BUO`](https://stellar.expert/explorer/testnet/account/GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO) | Payout account (hot wallet), deployed since 8 September | 2 / 2 / 2, three signers of weight 1 |
| [`GC5UOKLU…R4A6`](https://stellar.expert/explorer/testnet/account/GC5UOKLU6J2EROZYYP2I23ZEF4YF42TGGRNQMMTGOJGJ7NOCH3TTR4A6) | Cold reserve since 11 September (replacing `GDPGRS4P…`) | 2 / 2 / 2, three signers of weight 1 |

## One payout, step by step

```
 validated submission
        │
        ▼
 ① web checks its own daily cap      ─── signer 1's cap
        │
        ▼
 ② custody guard                     ─── web must hold signer weight below the threshold (F-01)
        │
        ▼
 ③ web builds the USDC payment       ─── amount in base units (1e-7 USDC), never floating point
        │                               ─── built inside the sequence lock, so payouts cannot collide
        ▼
 ④ web signs (weight 1)  ──► co-signer, over HMAC, stage "payment"
        │                        ─── re-derives amount + destination from the TASK LEDGER
        │                        ─── checks its OWN daily cap, independently
        │                        ─── signs only on an exact match
        ▼
 ⑤ assert: two distinct verified signatures on the payment
        │
        ▼
 ⑥ fee bump, paid by the payout account in XLM
        │  web signs  ──► co-signer signs again, stage "fee_bump"
        ▼
 ⑦ assert: two distinct verified signatures on the fee bump
        │                               ─── otherwise nothing is broadcast
        ▼
 ⑧ envelope hash recorded → Horizon submit → tuple persisted (txHash, amount, broadcastAt)
                                          → cap alert evaluated
```

## The guarantees, and what enforces each

| Guarantee | Enforced by | Where |
| --- | --- | --- |
| No key can pay alone | The Stellar network: threshold 2, each key weight 1 | On-chain |
| No *deployment* can pay alone | `assertCustodyBelowThreshold` refuses at the payout boundary | [`lib/stellar/key-custody.ts`](https://github.com/artisam-centient/centient/blob/develop/lib/stellar/key-custody.ts) |
| No *code path* can broadcast a single-signed payout | Structural scan plus a boundary signature check, pinned in both directions | [`no-single-key-payout.test.ts`](https://github.com/artisam-centient/centient/blob/develop/lib/stellar/__tests__/no-single-key-payout.test.ts) |
| The second signer does not trust the request | The co-signer re-derives from the task ledger through a read-only database role | [`services/cosigner`](https://github.com/artisam-centient/centient/tree/develop/services/cosigner) |
| Neither signer alone can lift the cap | Separate cap checks in `web` and in the co-signer | [`lib/payout-cap.ts`](https://github.com/artisam-centient/centient/blob/develop/lib/payout-cap.ts) |
| A compromised hot wallet loses at most the float | Refills restore *exactly* the target, and nothing else deposits into the hot wallet | [Cold reserve runbook](https://github.com/artisam-centient/centient/blob/develop/docs/stellar-cold-reserve-runbook.md) |
| An ambiguous submit never pays twice | Resolved only on on-chain proof, never refunded, never blindly resubmitted | [`lib/payout-service.ts`](https://github.com/artisam-centient/centient/blob/develop/lib/payout-service.ts) |
| Mainnet cannot run on simulated isolation | `COSIGNER_ISOLATION_LEVEL=same-workspace` fails closed on `public` | [`lib/stellar/cosigner-isolation.ts`](https://github.com/artisam-centient/centient/blob/develop/lib/stellar/cosigner-isolation.ts) |

## Services

| Service | Holds | Runs from |
| --- | --- | --- |
| `web` | One payout signer (weight 1), a dedicated sponsor key (not a payout signer) | `staging` branch → [beta.centient.work](https://beta.centient.work) |
| `cosigner` | The policy signer (weight 1), the policy secret, read-only ledger access | Its own Railway project in the same workspace (ADR-0001) |

The app refuses to boot if it can see both `COSIGNER_URL` and the policy secret, so the boundary is enforced at startup instead of assumed.

## Monitoring

Wallet health probes both assets (USDC and XLM) against configurable thresholds. Low-balance and anomaly alerts use cooldown and deduplication. The admin health page shows balances, sponsorship liability and sponsored-reserve drift.

The fee bump's fee comes from the payout account, so the payout account must keep an XLM balance as well as its USDC float. That is why health monitoring watches both assets.
