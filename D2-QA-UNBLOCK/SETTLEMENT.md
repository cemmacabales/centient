# D2 QA — Settlement of the 11 Blocked + 1 Failed Cases (rev. 2)

2026-09-18 · Developer-side settlement against the D2 Test Strategy (Final-v2) · Staging `https://centient.work` (Testnet) · Deployed `staging` @ `8f660cc632f1c868a41618434a1c169dc0edabcc` (CI green there: [build](https://github.com/webnxt-2030/Centient/actions/runs/35189732179/job/105099431092), [payments-lane](https://github.com/webnxt-2030/Centient/actions/runs/35189732179/job/105099431190), [verify-commit-identities](https://github.com/webnxt-2030/Centient/actions/runs/35189732309/job/105099431860))

**SHA note.** QA's other 28 cases ran on `b52eb13`. `b52eb13 → 8f660cc` (PRs #119/#120) touches only payout analytics (`lib/payout.ts`, `lib/payout-analytics.ts`). No auth, sponsorship or reclaim code changed, so the results below and QA's results describe the same D2 code. QA should still record `8f660cc` as the build for these rows.

## Why these were blocked, and what changed

The repro doc's classes A and B come down to one missing piece: TS §15 says the **developer** prepares the environment, and §8/§17 say readiness is "a developer-prepared entry condition, never an assumed QA capability". QA was right not to invent preparation methods or touch the sponsor key. The developer has now prepared each state. Where a state needs the sponsor key or the staging DB (which QA must not hold, per the F-01 custody posture), the developer also ran the key-holding step and recorded redacted evidence for QA to review and record (TS §4 "evidence-based verification").

| TC | Was | Now | Basis |
|---|---|---|---|
| 023 | FAIL | **PASS (re-baselined)**, TS amendment below | Header-absent path unreachable by design; deployed behaviour is stricter than the residual |
| 024 | Blocked A | **Executed — matches expected, 4/4 steps** | Fixture rows placed on staging |
| 026 | Blocked A | **Executed — matches expected** | F5 held for a few seconds, sponsor restored |
| 029 | Blocked A | **Executed — matches expected** | Horizon-timeout class injected at the Horizon boundary |
| 030 | Blocked A | **Executed — matches expected** | Sponsor sequence advanced between build and submit |
| 031 | Blocked B | **Executed — matches expected** | Reclaim execute fired with a signed envelope in flight |
| 032 | Blocked B | **Executed — matches expected** | CLI run with staging env (sponsor key + DB) |
| 033 | Blocked A | **Executed — matches expected**, one TS wording fix | Protected-class fixtures onboarded on-chain |
| 034 | Blocked C | **Executed — matches expected** | Follows TC-033's run |
| 038 | Blocked D | **Unblocked: F4 provisioned for QA to run in the browser** | Developer-provisioned wallet-free email account |
| 005 (step 3.3) | Blocked D | **Unblocked: QA runs step 3.3 in the browser** (server half verified) | Reported signer overridden in the verify request; real server refusal, real UI |
| 020 | Blocked A→D | **N/A: state doesn't exist in the deployed build** (owner decision, 2026-09-18) | Dead branch, covered by lane of record; P3 finding; follow-up after D2 |

**What QA does next**

1. **Record from evidence** (developer-operated, all match expected): TC-024, 026, 029, 030, 031, 032, 033, 034, with build `8f660cc`.
2. **Flip TC-023 to PASS** with the amended step 2 expectation (TSA-01).
3. **Run in the browser:** TC-005 step 3.3 (console override below) and TC-038 (F4 below).
4. **Mark TC-020 N/A** with the lane-of-record evidence, and log the P3 finding (TSA-03).

Evidence lives in `D2-QA-UNBLOCK/evidence/<tc>/`. Every file was scanned: no seeds, no session cookies. Stellar public keys and hashes are included, as the TS allows. The TS changes these results need are recorded separately in *Centient-D2-Test-Strategy-Amendment-v3.pdf*.

---

## D2-TC-023 — FAIL → PASS on deployed behaviour (test-design correction)

**New evidence (E023-3.1-spoofed-x-real-ip.json).** 20 challenges sent with `x-real-ip: 198.51.100.10`, then a 21st with a *different* claimed IP, `198.51.100.20`. That 21st request still answered **429**.

**What that run does and does not prove.** It proves a client cannot *choose* its own bucket by changing the header. It does **not**, on its own, prove what happens when the header is *absent*, because every request in the run carried one — and the absent-header branch is precisely what TSA-01 speaks to. That half rests on the lane-of-record test (`route.test.ts › skips the per-IP throttle without a proxy-supplied IP`) rather than on this live run. `kit/tc023.ts` now sends a final request with the header omitted, so a re-run closes the gap directly. The client's `x-real-ip` never reaches the app: Railway's proxy overwrites it on every request. Two consequences:

1. In QA's step 1, the `203.0.113.77` header had no effect either. All 21 requests counted against QA's real IP. The 429 was still correct.
2. The step 2 expectation ("no IP throttle when the header is absent") describes a code branch (`challenge/route.ts:43`) that no request from outside can reach. That branch is proven in the build lane of record: `route.test.ts › skips the per-IP throttle without a proxy-supplied IP` passed at `8f660cc` ([build log](https://github.com/webnxt-2030/Centient/actions/runs/35189732179/job/105099431092)).

**Against the TS.** §10 lists "No IP-level challenge throttle when x-real-ip is absent" as a **P3 residual**. On the deployment that residual never occurs, because every request carries a proxy-supplied IP and both throttles always apply. Observed behaviour is *stricter* than the strategy's model, so nothing fails unsafe (§14). The mismatch is in the TC's expected result, not in the product.

**QA records:** PASS. Step 1 is as observed. Step 2's expected result is amended to: "Through the deployed proxy the IP throttle always applies (the proxy supplies `x-real-ip`; a client value is ignored — E023-3.1); the header-absent branch is verified in the build lane." Record the §10 P3 residual as *not reachable on the Railway deployment*.

## D2-TC-024 — Per-user cap (2) and one outstanding per address: all four steps match expected

**Prepared state.** 4 fixture wallets signed in through the real challenge/verify routes. 5 `pending` rows written to `sponsored_trustlines` with `expiresAt` one hour in the past, so they count as outstanding but can never land. The rows were deleted afterwards. (E024-1)

| Step | Expected | Observed |
|---|---|---|
| 1 · U1 holds 2 pending, GET for its new wallet | 429 `sponsorship_cap_reached` | **429 `sponsorship_cap_reached`** |
| 2 · one row → `failed`, GET again | envelope offered | **200 `needed:true`, account+trustline XDR** |
| 3 · U1b's own wallet holds one of its 2 pending rows | own row doesn't count | **200 `needed:true`** |
| 4 · U3 bound to the address U2 holds a sponsorship for | no envelope | **409 `address_in_use`** |

No offered XDR was signed. One note for the record: while an own pending row is still *live* (before `expiresAt`), step 3 answers 409 `submission_pending` instead. That is #27's intended "don't ask for a second signature" guard, not a cap refusal. My first attempt hit this by accident (a timezone slip in the fixture), and it behaved correctly.

## D2-TC-026 — Sponsor cannot cover reserves + fee: matches expected

**F5.** In one sponsor-signed transaction, 9,977.3 XLM was parked in a developer-held account. That left **1.19999 XLM spendable against 1.5 XLM + fee needed**. The case ran, and the funds were merged straight back in the next transaction. (E026-2)

- GET as fresh F1 → **503 `sponsorship_unavailable`**, `xdrOffered:false`, **0 intent rows**, F1 **404 on-chain**, so no signature was requested and nothing is half-created.
- Sponsor before 9,999.99913 XLM → during 22.69999 → after **9,999.99911 XLM** (the difference is two base fees). Park tx `35acf648…3f1d`, restore tx `b96a9d4d…87ba`. The window lasted a few seconds: park, one GET, merge back.
- Recovery (outside the TC): the same GET then answered 200 with an envelope.

## D2-TC-029 — Timed-out submit answers 202 pending: matches expected

**Horizon-timeout class.** Timing out Horizon for the shared `web` service would break onboarding for live testers and needs a redeploy. Instead, the deployed route code (worktree at `8f660cc`) ran in-process against the staging DB. Its `STELLAR_HORIZON_URL` pointed at a local proxy that forwards every Horizon call to testnet, except `POST /transactions`, which gets Horizon's own `504 Timeout` problem response. Sign-in used the real deployed endpoints. (E029-1)

**Scope of this evidence.** This is **commit-level in-process integration evidence, not deployed-route evidence.** It proves the route code at `8f660cc` behaves as described against the staging database. It does **not** establish that the deployed `web` service ran that same code, with the same environment variables, or that Railway's own egress to Horizon behaves like the local proxy. Those three properties remain unverified for this case, and the lane of record plus the deployment SHA are what carry them.

- Submit → **202 `{established:false, pending:true}`**, row `pending`.
- 5 polls, of which **4 fall inside the 180 s envelope window and the 5th is 27.7 s past expiry** (expiry `02:48:50.000Z`, poll `02:49:17.722Z`). Resubmitting the same envelope gave **202 every time**, in-window and after. The `pollsDuringWindow: 5` field inside `E029-1` over-counts by one: the script tested the loop boundary before a 30 s sleep, so the last poll landed late and was still counted. The raw file is left exactly as the run produced it; `kit/tc029.ts` now tags each poll and reports the two counts separately. Building another gave **409 `submission_pending`** while the envelope was live (the contributor is never asked to sign twice), and a fresh envelope only once it had expired. F1 was **404 on-chain** throughout.
- After expiry, with Horizon answering again: resubmit → 502 `submit_failed`, row **released to `failed`**, F1 still 404. No partial account or trustline.

## D2-TC-030 — `tx_bad_seq` inside the bump: matches expected

After F1's envelope was built and signed, the sponsor's sequence was advanced by a sponsor-signed `bumpSequence` (tx `b576cc29…1f89`). (E030-2)

- Submit → **409 `retry`**; row **`failed` (released)**; F1 **404**; sponsor `num_sponsoring` **41 → 41 (no leaked reserve)**.
- Retry (rebuild, re-sign, resubmit) → **200 `established`**; F1 XLM **0.0000000**, USDC trustline present; one `confirmed` row.

## D2-TC-032 — Reclaim dry run writes nothing: matches expected

This is the class B blocker. The CLI needs to run "wherever the sponsorship key already lives". The developer ran `npm run stellar:sponsorship:reclaim` at `8f660cc` with the staging `web` env (sponsor key + staging DB via its public proxy). (E032-3/4/5)

- Before and after are identical: sponsor sequence `…590239`, `num_sponsoring` 68, 31 rows, 0 stored runs, every fixture row unchanged.
- Per-sponsorship disposition produced for all 28 outstanding rows (table under TC-033).

## D2-TC-033 — Execute revokes only eligible entries: matches expected, one wording fix

**Fixtures (E033-2).** 8 zero-XLM accounts were onboarded through the deployed sponsorship path. Every fixture except P1 was then unlinked so its own class applies:

| Fixture | Protection placed | Dry run | Execute |
|---|---|---|---|
| P1 linked wallet | still bound | `protected_linked_wallet` | untouched |
| P2 flagged withdrawal | `flagged_withdrawals` PENDING | `protected_payout_in_flight` | untouched |
| P3 unsettled submission | `payoutStatus needs_reconciliation`, amount 0 (no cron acts on it) | `protected_unsettled_submission` | untouched |
| P4 owed balance | `pendingBalanceUnits = 1` | `protected_owed_balance` | untouched |
| P5 USDC on trustline | buy offer → USDC buying liabilities | `protected_holds_usdc` | untouched |
| O1 cannot absorb | 0 own XLM | `owner_cannot_cover_reserve` | skipped |
| E1, E2 | 5 own XLM, nothing else | `eligible` | **`revoked`** |

All 20 non-fixture sponsorships (the real testers') were `protected_linked_wallet` and untouched. The execute run `7214598a…` reclaimed 30,000,000 stroops (2 × 3 units). E1/E2 **keep their USDC trustline**. `num_sponsoring` ended at **65 = ledger liability 65**. (E033-3, E033-4)

**Wording fix for the TS/TC.** The TS (§7 step 14, §10, D2-S10) and TC-033 name the skip reason `owner_cannot_absorb_reserve`. The shipped code, and the #29 evidence JSON (19/19), name it **`owner_cannot_cover_reserve`**. The behaviour matches; only the string differs. Record this as a P3 documentation correction (§14) and amend the TS under §17.

**Not exercised:** "a failing row is recorded and the run continues". No row failed, and forcing a failure would need fault injection into the chain read. That behaviour is covered by the #29 lane tests. Record it as covered by automation, not observed live.

**Cleanup done:** the P2/P3/P4 protection rows were removed after the runs, so the fixtures stop showing in the admin review queue. Orphan fixture users were deleted.

## D2-TC-031 — Reclaim execute concurrent with onboarding → 409 retry: matches expected

A fresh contributor's envelope was built and signed at sponsor sequence `…590239`. The TC-033 execute run then fired and advanced the sequence to `…590241`. Submitting the in-flight envelope afterwards → **409 `retry`**. The wallet flow's retry (rebuild, re-sign, resubmit) → **200 `established`**, XLM 0, trustline present, one `failed` + one `confirmed` row. (E031-2)

## D2-TC-034 — Report redaction and idempotent second run: matches expected

- **Step 1:** the stored `sponsorship_reclaim_runs` row (`id, network, sponsor, startedAt, finishedAt, reclaimedStroops, report`) contains **0 contributor wallet addresses, 0 user ids, 0 seeds**. The only account id stored is the platform sponsor's public key, in the `sponsor` column, by design.
- **Step 2:** second `execute` → sponsor sequence **`…590242` before and after (nothing sent)**, 0 stroops reclaimed.
- **Step 3:** `num_sponsoring` **65 = ledger `sponsorshipLiability` 65**. (E034-2, E034-3)

## D2-TC-038 — Email takeover: F4 provisioned, QA to execute

**F4 for QA (testnet fixture, like `demo@`):** `qa-d2-f4@centient.work`. It is verified, has **no wallet**, and was created by a developer DB write because registration is retired (410). **The password is not recorded here** — `kit/tc038.ts` provisions the account and prints the credential to the operator's console; re-run it to issue a fresh one and hand it to QA out of band.

The developer checked the path on a *separate* fixture so QA's stays unused (E038-2): wallet sign-in with A created a wallet-only account; the email session had `wallet:null`; `POST /api/me/wallet` → **200 `linked:true`**; A is now held by the email account only, and the wallet-only account is gone; a lowercased A → **400 `invalid_address`**.

**QA runs it as written:** (1) In Freighter, sign in on centient.work with QA's idle `f1-tc038` (`GDMPIF7…CTPI`); this creates the unused wallet-only account. (2) Log out. (3) Sign in with F4 and check that `GET /api/auth/me` shows `wallet:null`. (4) Claim A from the account sheet, i.e. `POST /api/me/wallet`. Expected: #109 takeover, one identity for A.

## D2-TC-005 step 3.3 — Wrong-account: QA to run in the browser

Freighter's own guard keeps Confirm disabled for a mismatched account, so the wrong-account condition can't come from the wallet itself. The same screen has a second, real trigger. After signing, the sign-in sends `/api/auth/wallet/verify` a `signerAddress` field (the account Freighter reports as signer). If it doesn't match the challenge address, the server refuses with **401 `wrong_signer`**, and the UI maps `wrong_signer`/`wrong_address` to its wrong-account state (`wallet-sign-in.ts:40,109`). The UI looks up `fetch` at call time (`wallet-sign-in.ts:34`), so an override in the DevTools console changes the request the real UI sends.

**Server half verified by the developer (E005-4):** a proof for A with `signerAddress` = B → **401 `wrong_signer`, no session cookie**. The same challenge, proved again with the real signer → **200, session issued**. The refused proof left the challenge live (#109).

**QA steps (step 3.3):**

1. Open `https://centient.work` logged out, with Freighter account 1 selected.
2. In the DevTools console, paste this, filling in the full address of Freighter account 2 (`GDMO…34GC`):

```js
const OTHER = "<account 2 full G… address>";
const realFetch = window.fetch;
window.fetch = (url, init) => {
  if (String(url).includes("/api/auth/wallet/verify") && init?.body) {
    const b = JSON.parse(init.body); b.signerAddress = OTHER; init = { ...init, body: JSON.stringify(b) };
  }
  return realFetch(url, init);
};
```

3. Click **Connect Freighter** and sign normally with account 1.
4. **Expected:** one visible wrong-account state with one retry action; no session (the Network tab shows verify → 401 `wrong_signer`).
5. Reload (this removes the override), sign in normally → a session is issued.

**QA records:** TC-005 PASS if step 3.3 matches. In the Note, write: "wrong-account condition produced by overriding the reported signer in the verify request, since Freighter's guard prevents it; the server refusal and UI state are real."

## D2-TC-020 — Unsupported capability: N/A (owner decision, 2026-09-18)

The only producer of the `unsupported` state is `wallet.ts:164`, which fires when `signMessage` is not a function. `signMessage` is always exported by the `@stellar/freighter-api` v6 bundled in the app, whatever extension version the user has. An old extension surfaces as the generic `failed` state instead, and no "unsupported account" state exists in code. Showing the screen would mean editing the app's JavaScript, which would test a modified app, not the build under test.

**QA records:** **N/A — not reachable in the deployed build.** Evidence: the lane of record at `8f660cc` covers the branch and its copy (`wallet.test.ts › a Freighter build without signMessage is unsupported`; `wallet-sign-in.test.ts` / `wallet-claim.test.ts` map `unsupported` to one state; `WALLET_SIGN_IN_MESSAGES` has actionable copy for every failure — [build run](https://github.com/webnxt-2030/Centient/actions/runs/35189732179/job/105099431092)). Also log a **P3 finding** (§14): the `unsupported` branch is dead in this build. **Follow-up after the D2 gate** (a code change now would invalidate the pass, §5): either map a real "method not supported" error from Freighter to `unsupported`, or remove the dead branch.

---

## TS amendments to record (§17 change control)

1. **§7 step 2 / §10 P3 / D2-S05 / TC-023:** the "no IP throttle without `x-real-ip`" residual cannot be reached through the Railway proxy; a client-supplied `x-real-ip` is ignored (E023-3.1).
2. **§7 step 14 / §10 / D2-S10 / TC-033:** `owner_cannot_absorb_reserve` → `owner_cannot_cover_reserve`.
3. **D2-S14 / TC-005 / TC-020:** the wrong-account state is exercised by overriding the reported signer in the verify request (Freighter's guard prevents a real mismatch); the unsupported state doesn't exist in the deployed build, so TC-020 is N/A with the lane of record as evidence, plus a P3 finding and a post-D2 follow-up.
4. **§8 environment access:** staging readiness is verifiable by the developer through Railway (`web` variables + the Postgres public proxy). Key-holding steps are developer-operated with evidence handed to QA; QA still never holds `STELLAR_SPONSOR_SECRET`.

## Operational notes

- Short effects on shared staging: the sponsor was below the reserve for a few seconds (TC-026), and there were 3 extra sponsor transactions (bumpSequence and two revocations). The sponsor was restored to 9,999.99911 XLM.
- Fixtures left on staging: the TC-024/026/029/030/031/033 fixture accounts (wallet-only users, no email) and QA's F4. These are harmless; the kit can reset them.
- Re-running: `kit/` holds every script. Run them from a worktree at the deployed SHA with `node stg.mjs npx tsx <script>`. This needs Railway CLI access, so it is the developer's job.
