# Infrastructure Request: Independent Payout Co-Signer

## Executive summary

Centient's payout wallet is configured so that no single signing key can move
funds. Every payout needs two independent signatures: one from the existing
payout service and one from a policy co-signer.

To preserve that protection, the policy co-signer cannot run inside the same
Railway service, use the same deployment permissions, or store its private key
beside the payout service's key. If both keys are available to one service, a
single service compromise can produce both signatures and the multisig control
becomes ineffective.

We are therefore requesting one small, company-owned Railway workspace/project
for the policy co-signer. This is a security boundary, not a scaling request.
The existing application remains where it is today.

## Why the current Railway service is insufficient

The current service owns the first payout signature. A second process inside
that same service would still share the same runtime boundary, deployment
permissions, logs, and secret configuration. An attacker or accidental deploy
with access to that service could potentially reach both private keys.

That would violate the central requirement of the payout design:

> Compromising any one key or server cannot move funds.

It would also fail the acceptance criteria in
[GitHub issue #8](https://github.com/webnxt-2030/Centient/issues/8), which require
the co-signer to use isolated infrastructure, a separate deployment pipeline,
and a separate secret store.

Application-level separation is not enough. The separation must exist at the
runtime and secret-management boundary.

## Minimum infrastructure requested

Provision one company-owned Railway workspace/project named for the policy
co-signer, with the following boundaries:

1. Run only the policy co-signer; do not deploy the web application or payout
   worker there.
2. Store only the policy signing key in that project's service-scoped secrets.
   The existing Railway service receives only the corresponding public key.
3. Use a deployment pipeline scoped to the co-signer project. A deployment of
   the main application must not automatically redeploy the co-signer.
4. Restrict project membership and secret-management access to the minimum
   company personnel required to operate the signer.
5. Give the co-signer a read-only database credential so it can independently
   re-derive payout eligibility, amount, and destination from the task ledger.
6. Allow outbound access to the existing database, Stellar Horizon, and the
   configured alert destination. It does not need a separate database.

The stronger option is a separate company Railway workspace/account with a
different operational owner. If that is not currently available, a separate
project with restricted membership and service-scoped secrets is the minimum
practical boundary. The limitation should be recorded as an accepted risk until
full account-level separation is available.

## What the co-signer does

For every signing request, the co-signer uses the payout reference to read the
ledger itself. It does not trust the amount, destination, or validation status
claimed by the payout service. It signs only after confirming all of the
following:

- the referenced payout exists and remains eligible;
- the task or withdrawal ledger supports the payment;
- the destination matches the ledger;
- the amount matches exactly, using integer USDC units;
- the envelope contains the expected network, asset, source, and single payment;
- the independent daily-cap policy passes once issue #9 is implemented.

Any mismatch is rejected and alerted. The payout remains unsigned and no funds
move.

## Cost-conscious scope

This request is for one low-traffic Node.js service, not another copy of the
application stack. It requires no new database and no persistent disk. Resource
limits and a monthly usage budget can be set at the smallest practical level,
then adjusted only after observed payout volume justifies it.

The service can initially be enabled for testnet evidence and production
readiness. This keeps spending measurable while preserving the required
security architecture.

## If the request is not approved

The repository already fails closed when an independent co-signer is not
configured. That behavior must remain: Centient must never fall back to a
single-signature payout.

The approved SOW fallback is a native 2-of-3 multisig with the second signature
applied from isolated infrastructure under a manual runbook. A company-controlled
GitHub Actions runner or an approved offline operator machine can provide that
second signature without placing the policy key in Railway. This is safe from a
key-separation perspective, but it makes payouts asynchronous, introduces
operator or pipeline delay, and does not provide the intended always-on automated
service.

Without either the requested isolated project or the approved isolated fallback:

- issue #8 must remain blocked and open;
- issue #9 cannot complete its independent second cap check;
- issue #12 cannot prove that the full payment lane has no single-key path; and
- issue #13 cannot complete the final Epic 1 evidence package and QA gate.

## Work that can continue while approval is pending

The infrastructure decision does not block all remaining Epic 1 work:

- **Issue #11 is ready now.** Dual-asset wallet-health monitoring depends on
  issues #7 and #10, both of which are closed. This is the recommended next
  implementation issue.
- **Issue #15 is ready now.** Its announcement covers issues #5 and #6, both of
  which are closed. It is communications work rather than implementation.
- **Issue #9 is blocked by #8.** Its second daily-cap gate belongs in the
  independent co-signer.
- **Issue #12 is blocked by #8 and #9.** It is the payments-lane proof and CI
  gate.
- **Issue #13 remains the final gate.** It depends on the unfinished security
  and testing work and should not start as a completion exercise yet.

## Decision requested

Please approve one of these company-controlled paths:

1. **Preferred:** provision a separate Railway workspace/project for the
   automated policy co-signer, with isolated deployment permissions and secrets.
2. **Interim fallback:** authorize the documented isolated signing runbook using
   GitHub Actions or an approved offline operator machine, accepting delayed
   payouts until the dedicated project is available.

No option should place the policy signing key in the existing Railway service.
