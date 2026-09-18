# Open risks and follow-ups

What is not finished, what is accepted as a known limit, and what must happen before mainnet. Each item is a way the program could miss a target or the rail could fail. **They are listed here so they can be managed, not as caveats.**

*Last reviewed 18 September 2026.*

## Blocking a future deliverable

| # | Item | Blocks | Needed by | Action |
| --- | --- | --- | --- | --- |
| R-1 | **The co-signer shares a Railway account with the app** (ADR-0001). `same-workspace` refuses to sign on mainnet | #50, #51 (D4 mainnet) | Tue 29 Sep | Provision a separate account for the co-signer (control plane, members, CI, database credentials), then set its isolation level. No service code changes |
| R-2 | **Mainnet approval** naming the exact destination and amount | #51 | Tue 29 Sep, end of day | Get the approval in writing on #51. Without it, the release week cannot close |
| R-3 | **25 unique wallets.** 9 have been paid so far. Real contributors must be recruited | #49 (D4 volume proof) | Recruit in Week 3 | Build a tester cohort with the tester guide. Decide D-4 (mobile), because every desktop contributor needs the Freighter extension |
| R-4 | **Existing custodial balances.** Email accounts held balances on 15 September | #39 (D3) | Mon 21 Sep | Decide and test how that value leaves the system before withdrawal is retired |
| R-5 | **Mainnet key custody.** The first testnet account was lost because its secrets were not kept | #51 | Before `set-options` | Generate mainnet keys straight into a secrets store. Record all three first. Apply the F-01 threshold check to every service |
| R-6 | **Phones can't sign in.** SOW §3.1 promises "anyone with a phone and a Stellar wallet". Freighter-only sign-in needs the desktop extension, and WalletConnect v2 (Freighter Mobile) is not built | §3.1 key outcome, and #35's "mobile-first" | Decide D-4 before Mon 21 Sep | Either scope WalletConnect v2 into Week 3, or record the gap against §3.1 explicitly in the D3 evidence |

## Process risks

| # | Item | Why it matters | Action |
| --- | --- | --- | --- |
| P-1 | **The development stop was not held in Week 2.** Seven application PRs merged after the cut | Each one moved the build QA must test. Weeks 3–4 have no buffer to absorb this | After each Wednesday cut, nothing merges until the gate records `QA PASSED <sha>` |
| P-2 | **Promotions ran out of cycle.** `staging` was promoted five times before #31 ran | The deployed environment got ahead of any QA verdict | Promote only the QA-passed SHA, on Friday |
| P-3 | **The readiness guide names a stale SHA** (`6bc1180`) | Testers may test the wrong build | Restate it before each gate |
| P-4 | **Zero program reserve inside a week.** A failed gate spends Saturday and then the next Monday. Two failed gates push the program past Day 30 | Schedule | Flag any slip the same day. Decide at once: compress, cut scope, or use the 4–6 Oct reserve |

## Accepted known limits

| Item | Accepted because | Revisit when |
| --- | --- | --- |
| **Simulated co-signer isolation** (server, not account) | Testnet, zero value at risk | Mainnet (R-1) |
| **Seeded QA credentials** (ADR-0002) | Internal testnet QA only | Before the public release (#48). See ADR-0002's exit criteria |
| **Freighter only; no mobile wallet** (ADR-0003, D-4) | One wallet meets every acceptance item | D-4, before #35 |
| **No wallet rotation** (D-3) | Out of D2 | After the sprint |
| **Logout does not revoke the 7-day session token** | Pre-existing; not in D2 scope | When instant payouts make a session more valuable (Week 3) |
| **Most sponsored reserves cannot be reclaimed** while the owner holds no XLM | This is how the chain behaves, and reclaiming would break payouts | Ongoing. The liability is tracked and capped per contributor |
| **Cap alerts are fire-and-forget** | Ledger-based health monitoring raises the same alert | Week 4 hardening (#47) |

## Small follow-ups

* [ ] #119's CodeRabbit thread: `lib/__tests__/payout-analytics.test.ts` does not clear `POSTHOG_KEY` (a one-line fix).
* [ ] #112's CodeRabbit thread is fixed by #114 but still shows unresolved on #112.
* [ ] #28's fee-bump `tx_bad_seq` read is still unfiled.
* [ ] A server-side analytics event for a payout the worker fails *after* the API accepted it; #110 does not cover it.
* [ ] Cap and co-signer-config failures emit no analytics event, and a retried payout emits one `failed` event per attempt.
* [ ] PostHog payout events send wallet addresses (deliberately, since they are public on the ledger). Confirm the privacy notice covers this before the public release.
* [ ] Legacy cleanup: remote `codex/*` branches, the `agent-ready` / `agent-in-progress` labels, and the dead `.github/codex-dispatch` check in `single-contributor.yml`.
* [ ] The code still says `labeler` in about 67 files, where the canonical term is **contributor**. Rename gradually, as files are touched.
