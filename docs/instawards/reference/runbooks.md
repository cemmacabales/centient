# Runbooks

Operator procedures committed to the repository. Each opens on the public mirror.

| Runbook | Covers | Deliverable |
| --- | --- | --- |
| [Multisig payout account](https://github.com/artisam-centient/centient/blob/develop/docs/stellar-multisig-runbook.md) | Signer set, thresholds, provisioning, on-chain verification, key custody | D1 |
| [Multisig payout service](https://github.com/artisam-centient/centient/blob/develop/docs/stellar-multisig-payout-service.md) | Construction, co-signing, sequence-safe submission, ambiguous-outcome handling | D1 |
| [Daily payout cap](https://github.com/artisam-centient/centient/blob/develop/docs/stellar-daily-payout-cap-runbook.md) | Configuring the cap at both signers, alerts, what happens when it is reached | D1 |
| [Cold reserve and refills](https://github.com/artisam-centient/centient/blob/develop/docs/stellar-cold-reserve-runbook.md) | Refill policy (live: 20 / 24 / 5 USDC), worst-case loss, signing a refill | D1 |
| [Payout failures](https://github.com/artisam-centient/centient/blob/develop/docs/stellar-payout-failure-runbook.md) | Diagnosing and recovering a failed or unknown payout without paying twice | D1 |
| [Co-signer deployment](https://github.com/artisam-centient/centient/blob/develop/docs/cosigner-deployment.md) | Deploying the policy co-signer and its isolation settings | D1 |
| [QA fixtures](https://github.com/artisam-centient/centient/blob/develop/docs/qa-fixtures-runbook.md) | Seeding and resetting the QA environment | D1 |
| [Sponsored-reserve reclaim](https://github.com/artisam-centient/centient/blob/develop/docs/stellar-sponsorship-reclaim-runbook.md) | Dry run and execute, the disposition rules, the stored report | D2 |

## To be written

| Runbook | Issue |
| --- | --- |
| Instant-payout retries and reconciliation | #38, #40 |
| Failure-injection matrix | #46 |
| Payout API documentation | #48 |
