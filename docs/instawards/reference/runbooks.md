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
| [Payout retries and reconciliation](https://github.com/artisam-centient/centient/blob/develop/docs/payout-reconciliation.md) | The attempt journal, retries, revival of stranded attempts, the reconciler, the zero-unreconciled report | D3 (#38, #40) |
| [Payout failure matrix](https://github.com/artisam-centient/centient/blob/develop/docs/payout-failure-matrix.md) | The four injected failures, what must and must never happen, results, and how to reproduce them | D4 (#46, #47) |
| [Payout API](https://github.com/artisam-centient/centient/blob/develop/docs/payout-api.md) | Every public route: method, auth, request and response, error codes, effect on payout state | D4 (#48) |
