# Metrics

The sprint's success metrics, with running totals and how each one is counted.

## Counting rules

* **Testnet only**, and only from the deployed payout account [`GCP34RIT…4BUO`](https://stellar.expert/explorer/testnet/account/GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO). Spike and evidence runs on throwaway accounts show that a mechanism works. They are listed in the [evidence index](evidence.md) and **not counted** here.
* **Running totals and the formal proof are reported separately.** The SOW targets of 100 payouts and 25 wallets are met by the Week 4 evidence run (#49), which produces a reconciler report. The running total below shows activity so far. It is not a substitute for that report.
* Payments to Centient's own accounts, such as a hot-to-cold funding transfer, are excluded.

## Results

The ten success metrics from [SOW §6.3](../statement-of-work.md), in the SOW's order.

| SOW §6.3 metric | Target | Now | Status |
| --- | --- | --- | --- |
| Successful USDC reward settlements on testnet | ≥ 100 | **37** from the deployed payout account, every one two-signature and fee-bumped. The formal count is the reconciler run in Week 4 | Week 4 |
| No single-key payout path (payout account multisig threshold ≥ 2), verifiable on-chain | Yes | 2 / 2 / 2, three signers of weight 1; guarded in CI and at the deployment boundary | ✓ |
| Contributors receive USDC with no XLM of their own (sponsored trustline + fee-bump) | Yes | Never-funded address sponsored in [`b1ef0d3a…`](https://stellar.expert/explorer/testnet/tx/b1ef0d3aa2d3f74f7b86c3cbff840205718e76164b70e3774b5263a3051a435b); every payout fee-bumped | ✓ |
| Unique Stellar wallet addresses onboarded | ≥ 25 | **9** distinct addresses paid | Week 4 |
| Successful mainnet config-flip smoke payout | ≥ 1 | — (needs the co-signer on its own account first) | Week 4 |
| Automated test suites green in CI (payments, identity, end-to-end) | Yes | Payments ✓ · identity ✓ (inside `build`) · end-to-end not built yet | Week 3 |
| Unreconciled payouts | 0 | — | Week 4 |
| Public testnet URL live & accessible | Yes | [centient.work](https://centient.work) | ✓ |
| Demo video published | Yes | — | Week 4 |
| Public GitHub repository released | Yes — already public | [github.com/cemmacabales/centient](https://github.com/cemmacabales/centient) | ✓ |

*Last updated 18 September 2026. Figures come from Horizon: every USDC `payment` sent by the payout account from its first payout (8 September) to 17 September.*

## What the running total contains

All 37 payments succeeded. Every one carries **two signatures** and is wrapped in a **fee bump**, so none reached the network with a single key. 19 went to a single address, so the count of distinct wallets tells more than the count of payments. The instant path, where validation itself triggers the payout, is built in Week 3. The formal count comes from the reconciler run that follows it.

The honest reading: the rail has proven its security properties on every payment it has made, but its **reach** is still small. Reaching 25 distinct wallets depends on recruiting real contributors in Weeks 3–4. → [Open risks](risks.md)

## How to reproduce

```bash
# Every USDC payment out of the payout account, with signature count.
# The issuer is the deployment's STELLAR_USDC_ISSUER: Circle's testnet USDC.
# Filtering on it excludes any other asset that is also named "USDC".
issuer="${STELLAR_USDC_ISSUER:-GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5}"
curl -s "https://horizon-testnet.stellar.org/accounts/GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO/payments?limit=200&join=transactions" \
  | jq --arg issuer "$issuer" '[._embedded.records[]
         | select(.type=="payment" and .asset_code=="USDC" and .asset_issuer==$issuer
                  and .from=="GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO")
         | {to, amount, sigs: (.transaction.signatures|length), hash: .transaction_hash}]'
```
