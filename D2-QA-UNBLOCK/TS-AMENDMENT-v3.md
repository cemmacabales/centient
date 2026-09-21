# D2 Test Strategy — Amendment (Final-v3)

2026-09-18 · Amends *D2 Test Strategy — Wallet-Native Contributor Onboarding, Final-v2 (2026-09-16)* under §17 change control · Epic #21 · Gate #31 · Build of record for the affected rows: `staging` @ `8f660cc632f1c868a41618434a1c169dc0edabcc` (Testnet)

**Read with Final-v2.** This document changes only the passages listed below; everything else in Final-v2 stands as written. Each amendment is backed by an execution on staging, and its evidence is in *Centient-D2-QA-Unblock-Settlement.pdf* (rev. 2), under `D2-QA-UNBLOCK/evidence/<tc>/`.

**Why an amendment and not a re-issue.** None of the four changes the strategy's risk ranking, scope, gate chain or exit criteria. Three bring the text into line with how the deployed build actually behaves; the fourth records how environment readiness is met. No P0/P1 risk is downgraded (§10 red line), and no residual risk is turned into a stronger release claim (§17 red line).

## Summary

| ID | Sev | Sections amended | Change |
|---|---|---|---|
| TSA-01 | P3 | §6 boundary row, §7 step 2, §8 test-data classes, §10 P3 row, §17 control-layer row, D2-S05, Appendix A | The "no IP throttle without `x-real-ip`" behaviour can't be reached through the Railway proxy; restate it as a code branch verified in the lane of record |
| TSA-02 | P3 | §7 step 14, §10 reclaim row, D2-S10, TC-033 | Skip reason `owner_cannot_absorb_reserve` → `owner_cannot_cover_reserve` (the shipped string) |
| TSA-03 | P3 | §7 steps 1/4, §11 #24 and #26 rows, D2-S14, §10/§17 residuals, TC-005, TC-020 | Wrong-account is exercised by overriding the reported signer; unsupported doesn't exist in the deployed build → TC-020 N/A + P3 finding + post-D2 follow-up |
| TSA-04 | P2 | §8 access table + Addendum, §13 entry criterion 5, §15 roles, §17 local-access row | Environment readiness and key-holding steps are developer-operated through Railway, with redacted evidence handed to QA; QA never holds `STELLAR_SPONSOR_SECRET` |

---

## TSA-01 — Proxy-supplied `x-real-ip`: the header-absent branch can't be reached on the deployment

**Finding.** Railway's proxy sets `x-real-ip` on every inbound request and overwrites any value the client sends. Proof (E023-3.1): 20 challenges claiming IP `198.51.100.10`, then a 21st claiming `198.51.100.20` → still **429**. A client can neither remove nor change the header, so the app's "skip the per-IP throttle without a proxy-supplied IP" branch (`app/api/auth/wallet/challenge/route.ts:43`) never runs for outside traffic.

**Evidence boundary.** E023-3.1 as recorded proves only the *changed*-header half: every request in it supplied an `x-real-ip`. The *omitted*-header half is carried by the lane-of-record test named below, not by that run. `kit/tc023.ts` has since been extended to send a header-less request, so re-running it evidences both halves live. The branch is verified in the build lane: `route.test.ts › skips the per-IP throttle without a proxy-supplied IP, rather than pooling every caller` passed at `8f660cc`.

**§7 step 2** — replace "no IP throttle when `x-real-ip` is absent (the address throttle still applies)" with:
> On the Railway deployment the proxy supplies `x-real-ip` for every request and a client value is ignored, so both throttles always apply. Without a proxy-supplied IP (non-proxied deployments only) the per-IP throttle is skipped and the address throttle still applies — verified in the build lane, not reachable from outside staging.

**§6 Boundary row and §8 test-data classes** — replace "no IP throttle without `x-real-ip`" / "issuance without `x-real-ip`" with "a client-supplied `x-real-ip` does not escape the IP throttle (proxy-owned header)".

**D2-S05** — replace the second clause with:
> A client-supplied or removed `x-real-ip` does not change the IP bucket: the proxy supplies it, so the 21st request from one IP inside a minute is 429. The header-absent branch is verified in the build lane.

**§10 P3 row and §17 control-layer row** — keep the risk, add its status:
> Status 2026-09-18: not reachable on the Railway deployment (proxy-owned header, E023-3.1). It remains a residual only for a deployment that is not behind a header-setting proxy.

**Appendix A** — boundary item: "429 at the 5/min-per-address and 20/min-per-IP limits, including with a spoofed `x-real-ip`". Residual-risks item: record the missing-IP-throttle residual as "not reachable on the deployment".

**TC-023 effect.** Step 2's expected result becomes: "Through the deployed proxy the IP throttle still applies with the header removed or spoofed; the header-absent branch is verified in the build lane." Result: **PASS**.

## TSA-02 — Reclaim skip reason: `owner_cannot_cover_reserve`

**Finding.** The strategy names the reclaim skip reason `owner_cannot_absorb_reserve`. The code at `8f660cc` (`lib/sponsorship-reclaim.ts`), the #29 evidence JSON (19/19) and the staging execute run `7214598a…` all use **`owner_cannot_cover_reserve`**. The behaviour is identical; only the string in the strategy is wrong.

**§7 step 14 (rule 6), §10 "Reclaim touches a protected contributor" row, D2-S10, TC-033 expected result** — replace every `owner_cannot_absorb_reserve` with `owner_cannot_cover_reserve`.

**TC-033 effect.** The string mismatch is not a failure. Result: matches expected (O1 → `owner_cannot_cover_reserve`, E033-3).

## TSA-03 — Wrong-account and unsupported wallet states

**Findings.**

1. *Wrong-account.* Freighter keeps Confirm disabled when the selected account doesn't match the requested address, so a real wrong-account signature never leaves the wallet. The UI's wrong-account state has a second, real trigger: verify refusing `wrong_signer` or `wrong_address` (`lib/stellar/wallet-sign-in.ts:40,109`). The sign-in sends `signerAddress` to verify, and `fetch` is looked up at call time (`wallet-sign-in.ts:34`), so overriding the reported signer from the DevTools console makes the real server refuse and the real UI render the state. Server half verified (E005-4): a mismatched `signerAddress` → 401 `wrong_signer`, no session; the real signer then signs in with the same challenge.
2. *Unsupported.* The only producer of the `unsupported` state is `lib/stellar/wallet.ts:164` (`signMessage` not a function). The `@stellar/freighter-api` v6 bundled in the app always exports `signMessage`, whatever extension version is installed; an old extension surfaces as `failed`. No "unsupported account" state exists in code. Reaching the screen would mean modifying the build under test.

**§7 step 1 and step 4 invariant** — add:
> Wrong-account is exercised by overriding the reported signer in the verify request (the wallet's own guard prevents a real mismatch). The `unsupported` state is not reachable in the deployed build (see P3 finding below); its copy and mapping are verified in the build lane.

**§11 #24 and #26 rows** — manual QA focus: replace "unsupported" with "unsupported (lane of record only — not reachable in the deployed build)", and add "wrong-account via reported-signer override" to #26.

**D2-S14** — replace "unsupported account or capability → one clear visible state" with:
> A proof refused as `wrong_signer`/`wrong_address` → one wrong-account state with one retry action, and no session. The unsupported-capability state is verified in the build lane only; it is not reachable in the deployed build.

**§10 and §17 — new P3 row:**

| Risk | Sev | Why it matters | Treatment |
|---|---|---|---|
| Dead `unsupported` wallet branch (`wallet.ts:164`) | P3 | A user on a Freighter build that can't sign messages sees the generic "failed" message instead of the "update Freighter" guidance | Recorded finding. Follow-up after the D2 gate (a code change now would invalidate the pass, §5): map a real "method not supported" error from Freighter to `unsupported`, or remove the branch |

**TC effects.**
- **TC-005:** step 3.3 is executed with the reported-signer override; the TC Note records the method. Result per QA's run.
- **TC-020:** **N/A — not reachable in the deployed build** (owner decision, 2026-09-18). Evidence: lane of record at `8f660cc` (`wallet.test.ts › a Freighter build without signMessage is unsupported`; `wallet-sign-in.test.ts` / `wallet-claim.test.ts` map `unsupported` to one state; `WALLET_SIGN_IN_MESSAGES` has actionable copy for every failure). This counts toward exit criterion 3 (§13) as a documented N/A, not a pass.

## TSA-04 — Environment readiness and key-holding steps are developer-operated

**Finding.** Final-v2 records correctly that the QA workspace holds none of the entry criterion 5 variables. It then leaves every case whose precondition needs the sponsor key, the staging DB or a fault state without a named way to satisfy it. That left 9 cases blocked. The deployment itself is reachable by the developer: the `web` service variables via the Railway CLI, and the staging DB via the Postgres service's public TCP proxy (`DATABASE_PUBLIC_URL`; the `web` service's `DATABASE_URL` is internal-only).

**§8 access table and Addendum** — add a column "Reachable by the developer?": **Yes, via Railway** for every row. Keep "Accessible locally? — No" for QA as written.

**§13 entry criterion 5** — append:
> …verified by the developer against the deployed `web` service; a developer-prepared state is placed immediately before the case that needs it and removed after.

**§15 roles** — Developer row, append:
> Prepares each developer-prepared state (§8/§15) on staging, and operates any step that needs `STELLAR_SPONSOR_SECRET` or the staging DB (sponsor-signed transactions, the reclaim CLI, fault injection), handing QA redacted evidence for each. QA reviews that evidence and records the verdict (§4 evidence-based verification). QA never holds the sponsor key or DB credentials (F-01 custody posture).

Extend the recorded tension (implementer = QA runner):
> Developer-operated steps are evidence-producing only; the verdict per row is QA's, and the gate verdict remains the `QA PASSED <full-sha>` comment (D-5).

**§17 local environment access row** — append:
> Fault classes that would disrupt the shared staging service (e.g. a Horizon timeout) are injected at the Horizon boundary for one process running the deployed code at the build SHA against the staging DB, never by reconfiguring or redeploying `web`. Brief sponsor-state changes (e.g. F5 insolvency) are reversed straight away and recorded with their transaction hashes.

**Effect.** TC-024, 026, 029, 030, 031, 032, 033 and 034 are executed under this arrangement; all match expected (settlement rev. 2). TC-038's F4 is developer-provisioned for QA to run.

---

## Recorded facts (no text change)

- **Build under test.** Final-v2 names `242de94` / `7564b5c`. QA's pass ran on `b52eb13` (and `184cd77` develop); the rows settled here ran on `8f660cc`. `b52eb13 → 8f660cc` (PRs #119/#120) changes only payout analytics (`lib/payout.ts`, `lib/payout-analytics.ts`, `.env.local.example`, package files) — no wallet, auth, sponsorship or reclaim path. #31's Build-under-test fields must name the SHA each row ran on.
- **CI at `8f660cc`:** [build](https://github.com/webnxt-2030/Centient/actions/runs/35189732179/job/105099431092), [payments-lane](https://github.com/webnxt-2030/Centient/actions/runs/35189732179/job/105099431190), [verify-commit-identities](https://github.com/webnxt-2030/Centient/actions/runs/35189732309/job/105099431860) — all green.

## Approval

Amendment decided by the owner (cemmacabales), 2026-09-18, under §17 change control. It takes effect for the #31 record from this date; rows already executed under Final-v2 keep their results except where an effect is stated above.

END OF AMENDMENT
