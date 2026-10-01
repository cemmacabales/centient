# Metrics

The sprint's success metrics, with running totals and how each one is counted.

## Counting rules

* **Testnet only**, and only from the deployed payout account [`GCP34RIT…4BUO`](https://stellar.expert/explorer/testnet/account/GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO). Spike and evidence runs on throwaway accounts show that a mechanism works. They are listed in the [evidence index](evidence.md) and **not counted** here.
* **Running totals and the formal proof are reported separately.** The SOW targets of 100 payouts and 25 wallets are met by the Week 4 evidence run (#49), which produces a reconciler report. The running total below shows activity so far. It is not a substitute for that report.
* Payments to Centient's own accounts, such as a hot-to-cold funding transfer, are excluded.

## Results

The ten success metrics from SOW §6.3, in the SOW's order.

| SOW §6.3 metric | Target | Now | Status |
| --- | --- | --- | --- |
| Successful USDC reward settlements on testnet | ≥ 100 | Formally **122** reconciled by the Week 4 volume proof ([#49](https://github.com/webnxt-2030/Centient/issues/49): 22–28 Sep, [report](https://github.com/artisam-centient/centient/blob/develop/docs/superpowers/specs/2026-09-28-d4-volume-proof.md)), every one two-signature and fee-bumped, 0 unreconciled. The wider running total is **127** to 24 Sep | ✓ |
| No single-key payout path (payout account multisig threshold ≥ 2), verifiable on-chain | Yes | 2 / 2 / 2, three signers of weight 1; guarded in CI and at the deployment boundary | ✓ |
| Contributors receive USDC with no XLM of their own (sponsored trustline + fee-bump) | Yes | Never-funded address sponsored in [`b1ef0d3a…`](https://stellar.expert/explorer/testnet/tx/b1ef0d3aa2d3f74f7b86c3cbff840205718e76164b70e3774b5263a3051a435b); every payout fee-bumped | ✓ |
| Unique Stellar wallet addresses onboarded | ≥ 25 | **25** unique wallets in the instant-payout window, counted by the Week 4 volume proof ([#49](https://github.com/webnxt-2030/Centient/issues/49)). (The payout account has paid 35 distinct addresses in all, but that wider figure includes D1 proof accounts and typed withdrawal destinations) | ✓ |
| Successful mainnet config-flip smoke payout | ≥ 1 | Out of scope: the sprint is testnet only (D-7) | — |
| Automated test suites green in CI (payments, identity, end-to-end) | Yes | Payments ✓ · identity ✓ · end-to-end ✓, all inside `build` and `payments-lane`. There is no separate end-to-end job | ✓ |
| Unreconciled payouts | 0 | **0**. The Week 4 volume proof repeated the check over 122 payouts — 0 unreconciled, 0 duplicate ([#49 report](https://github.com/artisam-centient/centient/blob/develop/docs/superpowers/specs/2026-09-28-d4-volume-proof.md)), matching the earlier D3 window ([report](https://github.com/artisam-centient/centient/blob/develop/docs/superpowers/specs/2026-09-24-d3-reconcile-report.md)) | ✓ |
| Public testnet URL live & accessible | Yes | [beta.centient.work](https://beta.centient.work) | ✓ |
| Demo video published | Yes | [D4 demo video](https://drive.google.com/drive/folders/11SiPEsUuHDKGgJcfm3yWfejjQuOElUD9): 3:58, captioned, recorded live on beta.centient.work | ✓ |
| Public GitHub repository released | Yes — already public | [github.com/artisam-centient/centient](https://github.com/artisam-centient/centient) | ✓ |

*Running-total figures below come from Horizon: every USDC `payment` sent by the payout account from its first payout (8 September) to 24 September 07:50 UTC. The three formerly Week-4-deferred metrics (settlements, wallets, unreconciled) are now settled by the volume proof ([#49](https://github.com/webnxt-2030/Centient/issues/49), run 28 September). Last updated 1 October 2026.*

## What the running total contains

All 127 payments succeeded. Every one carries **two signatures** and is wrapped in a **fee bump**, so none reached the network with a single key, and none went to Centient's own accounts.

| Period (UTC) | Payments | What drove them |
| --- | ---: | --- |
| 8–17 September | 37 | Before instant payout: D1 proofs and withdrawals. 19 went to one address |
| 18–20 September | 10 | Testers, between the D2 and D3 gates |
| 21–24 September | 80 | Mostly the instant path, 0.25 USDC per validated answer, during D3 QA |

The payout count passes 100 on the running total, but that running total is not itself the formal proof: the 35 addresses are payout destinations, not wallets that completed sign-in → rank → earn. The formal counts come from the Week 4 evidence run ([#49](https://github.com/webnxt-2030/Centient/issues/49), 28 September), which reconciled **122 settlements across 25 unique wallets, 0 duplicate, 0 unreconciled** over the instant-payout window — see the [D4 volume proof](https://github.com/artisam-centient/centient/blob/develop/docs/superpowers/specs/2026-09-28-d4-volume-proof.md). → [Open risks](risks.md)

## How to reproduce

```bash
# Every USDC payment out of the payout account, with signature count.
# The first page holds 200 records; follow _links.next (order=asc) for the rest.
# The issuer is the deployment's STELLAR_USDC_ISSUER: Circle's testnet USDC.
# Filtering on it excludes any other asset that is also named "USDC".
issuer="${STELLAR_USDC_ISSUER:-GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5}"
curl -s "https://horizon-testnet.stellar.org/accounts/GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO/payments?limit=200&join=transactions" \
  | jq --arg issuer "$issuer" '[._embedded.records[]
         | select(.type=="payment" and .asset_code=="USDC" and .asset_issuer==$issuer
                  and .from=="GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO")
         | {to, amount, sigs: (.transaction.signatures|length), hash: .transaction_hash}]'
```
