# ADR-0001: Simulate the co-signer's isolated infrastructure on one Railway workspace

- **Status:** Accepted — 2026-09-08, **amended the same day** (see *Amendment*)
- **Scope:** MVP / testnet only. Mainnet is explicitly out of scope; see *Exit criteria*.
- **Relates to:** [#8](https://github.com/webnxt-2030/Centient/issues/8) (independent policy co-signer), [#9](https://github.com/webnxt-2030/Centient/issues/9) (second daily-cap gate), [#12](https://github.com/webnxt-2030/Centient/issues/12) (payments-lane proof), SOW §3.8.

## Context

The payout account is a 2-of-3 native multisig. Every payout needs two signatures:
one from the payout service, and one from a policy co-signer that re-derives the
payout from Centient's own task ledger rather than trusting the request it is
handed. SOW §3.8 states the requirement as:

> Compromising any one key or server cannot move funds.

Issue #8's acceptance criteria originally read that as **a separate cloud
account**, with its own deploy pipeline and its own secret store. This branch
opened as a boss-facing request to provision exactly that: a second
company-owned Railway workspace or account for the co-signer.

That request is withdrawn. Centient is pre-mainnet and the entire payout rail is
still on testnet, so the cost of a second billing account and a second
operational owner is not yet justified by the value at risk — which is currently
zero real funds. What *is* justified is building the co-signer with its real
shape now, so that promoting it to genuinely isolated infrastructure later is a
deployment change rather than a rewrite.

## Decision

Deploy the policy co-signer as its **own Railway project inside the existing
workspace**, and simulate the account boundary with every other boundary Railway
and Postgres can actually enforce.

> **Amended 2026-09-08 — the deployed topology is a separate *service*, not a
> separate project.** Provisioning found that the maintainer's account cannot
> create projects in the workspace where Centient runs. See *Amendment: same
> project* at the end of this record for what changed, what it costs, and what
> is unchanged. The reasoning below is retained as written because it is what the
> exit criteria are still aimed at.

Railway's hierarchy is Workspace → Project → Environment → Service. Two of those
boundaries are real without a second account:

| Boundary | Available in one workspace | What it enforces |
| --- | --- | --- |
| Separate **service** | yes | own container, own variables, own deploy trigger |
| Separate **project** | yes | the above, plus its own member list |
| Separate **account** | no | the control plane — this is what we are giving up |

A separate project loses Railway private networking, which is project-scoped.
That is acceptable and arguably more faithful: the co-signer seam already
specifies an authenticated transport, so the request goes over HTTPS with its own
authentication rather than over an implicitly trusted network.

The repository already runs several Railway services off one repo with distinct
start commands (`pnpm worker`, `pnpm reconciler`, `pnpm payout`). The co-signer
is the same shape.

### Implementation

1. **Its own service.** `pnpm cosign` runs a small HTTP server exposing
   `POST /cosign`, deployed to the co-signer's own Railway project.
2. **Authenticated transport.** HMAC-SHA256 over the raw request body, bound to a
   timestamp and nonce with a replay window, compared in constant time. The shared
   secret exists in both services; the *signing key* exists in only one.
3. **Independent re-derivation over a read-only credential.** The co-signer holds
   its own database URL for a Postgres role granted `SELECT` on `Submission`,
   `PayoutJob`, and `User` and nothing else. It reads the row named by the
   request's `PayoutReference` and independently confirms validation state,
   destination, and exact `amountUnits`. It never trusts the presented values.
4. **Shared envelope verification.** The envelope checks in
   `lib/stellar/payout-cosigner.ts` — asset, destination, exact amount,
   single-payment shape — move to a shared module so the deployed service and the
   local development signer run byte-identical logic.
5. **Its own cap gate (#9).** The co-signer sums broadcast payouts over its
   read-only connection against `COSIGNER_DAILY_CAP_UNITS`, configured separately
   from the application's `DAILY_PAYOUT_CAP_UNITS`. Two independently configured
   caps, checked by two processes.
6. **Client seam.** `resolvePayoutCoSigner` gains a remote implementation selected
   by `COSIGNER_URL`. The existing gated local signer remains for development. The
   fail-closed behaviour is unchanged: no configured co-signer still throws rather
   than degrading to one signature.
7. **The boundary is asserted, not assumed.** If the application process observes
   both `COSIGNER_URL` and `STELLAR_POLICY_SIGNER_SECRET`, it refuses to start.
   This is what makes the simulated boundary testable rather than aspirational,
   and it mirrors the existing `STELLAR_ALLOW_LOCAL_COSIGNER` refusal.
8. **Deploy separation.** Railway watch paths scope the co-signer's redeploys to
   its own source path, with a CODEOWNERS entry on that path so a change to the
   signer cannot ride along in an unrelated review.

## What this does and does not buy

**Enforced by this decision.** Separate process and container; separate
environment-variable scope; separate deploy trigger; separate database
credential that cannot write; separate member list; and every application-layer
refusal path the real service would have. An attacker holding the application
container still cannot forge a payout — the worst a compromised co-signer can do
is refuse to sign, because the detached signature is verified against our own
envelope hash before it is merged.

**Not enforced, and accepted as risk.** One Railway account and one control
plane: workspace-owner credentials reach both projects' variables. One Git
repository and one CI system: a sufficiently malicious commit can change both
sides. One database instance: the read-only role narrows this but does not remove
it.

In SOW §3.8's terms, this satisfies *server* but not *account*. That gap is the
whole reason the scope below is testnet-only.

## Enforcement

The scope limit is machine-checked rather than documented and forgotten. A
`COSIGNER_ISOLATION_LEVEL` setting takes `same-workspace` or `separate-account`,
and `same-workspace` is **refused when `STELLAR_NETWORK` is `public`**.

Testnet and MVP proceed today. Mainnet fails closed until the real boundary
exists, and the code is what says so.

## Exit criteria

Before any mainnet payout:

- provision the co-signer in a separate company-owned Railway account with its
  own operational owner;
- move the policy signing key into that account's secret store;
- set `COSIGNER_ISOLATION_LEVEL=separate-account`;
- confirm the payout account's signer set and weights are unchanged (#5 runbook).

Only the first two are infrastructure work. Nothing in the service's code needs
to change, which is the point of building it this way now.

## Consequences

- #8 is unblocked and implementable against this topology.
- #9 is unblocked: its second cap gate is item 5 above.
- #12 can prove the lane has no single-key path, subject to the residual risks
  named above being recorded in its evidence package rather than omitted.
- #13's final Epic 1 evidence must state the isolation level in force at the SHA
  it evaluates.
- The originally requested second Railway account is deferred, not cancelled. It
  becomes a mainnet-readiness item rather than a Week 1 blocker.

## Alternatives considered

**Provision the separate account now.** The correct end state, and still the exit
criterion. Rejected for the MVP because it blocks Epic 1 on an external approval
while the value at risk is zero.

**Second service in the same project.** Simpler, and keeps Railway private
networking. Rejected because project-level membership is the only access-control
boundary available inside a workspace, and giving that up leaves the simulation
noticeably thinner for no real saving.

**The SOW's manual fallback** — a 2-of-3 with the second signature applied from
isolated infrastructure under a runbook. Safe on key separation, but it makes
payouts asynchronous and operator-gated, and it does not exercise the automated
service that #8 actually asks for. It remains the documented contingency if the
co-signer service cannot be stood up.

## Amendment: same project (2026-09-08)

**What forced it.** `centient-work` lives in the Railway workspace "mh's
Projects". The maintainer's account cannot create projects in that workspace —
`railway init` there is refused outright. The decision above assumed a second
project was available; it is not, for this account.

**What was deployed instead.** A `cosigner` service inside the existing
`centient-work` project — the option this record explicitly considered and
rejected under *Alternatives considered*.

**What is unchanged.** Its own container, its own service-scoped variables (so
the policy signing key still exists in exactly one place and the application
still refuses to start holding both), its own deploy trigger through watch
paths, and its own read-only database credential. Every application-layer
refusal — ledger re-derivation, envelope verification, the independent cap, the
fail-closed boot — is untouched. An attacker holding the application container
still cannot forge a payout.

**What it costs.** The separate member list, which is the specific reason this
record chose a project over a service. Anyone with access to `centient-work` can
now read both services' variables, so the boundary protects against a
*compromised application*, not against a *compromised Railway account or
collaborator*. That is a smaller claim than the one made above, and #12's
evidence package must state it rather than cite the original wording.

**What it buys back.** Private networking, which is scoped to a project. The
co-signer reaches Postgres over the internal host and the application reaches
the co-signer over the private domain, so neither the read-only credential nor
the signing request leaves Railway's network — both of which the separate-project
topology would have pushed onto the public internet.

**On the isolation level.** `COSIGNER_ISOLATION_LEVEL=same-workspace` remains the
configured value and still fails closed on the public network, which is the
property that matters. It now *understates* the coupling rather than describing
it, and that is the honest reading: the label bounds where this may run, it does
not certify what was built.

**Exit criteria are unchanged and now have a first step.** Obtaining
project-creation access in the company workspace restores the topology this
record describes; the separate account remains the mainnet requirement. Neither
needs a service-code change.
