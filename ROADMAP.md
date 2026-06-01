# Centient (t2p) — Roadmap & Session Log

Living document. Two sections:

1. **Roadmap** — what needs to ship, in what order, and why. Derived from the
   GitHub issues + PRs as of 2026-06-01, anchored on the master roadmap in #110.
2. **Session log** — append-only record of completed work sessions. One block
   per PR-open or PR-merge event.

> **Handover note:** the legacy per-task `HANDOVER.md` pattern is deprecated.
> New session notes go here. Existing HANDOVER.md files (#168, #155) are kept
> for historical reference only.

---

## Part 1 — Roadmap

### 0. Conventions

- **Statuses** mirror the GitHub `agent-ready` / `needs-clarification` / open labels.
- **Phases** follow the CTO analysis in #110: P1 production-readiness, P2 customer
  surface, P3 quality moat, P4 marketplace. Items in earlier phases are blockers
  for later ones; do not skip phases.
- **Worktree rule** (per `auto-dev.md`): every code change happens in
  `../work/issue-{N}` or `../work/pr-{N}-review`. Never in the main checkout.
- **Merge rule**: agents open PRs, humans merge.
- **Dependency shorthand**: `→ #N` means "blocked on #N landing first".

### 1. In-flight PRs to land first

Smallest, fastest wins. 90% done, unblock the customer surface.

| PR | Closes | Title | Review blockers |
|----|--------|-------|-----------------|
| #172 | #155 | Platform gold set (b) + seed Centient customer | 2: empty `GOLD_TASK_RATIO` silently disables gold; missing trailing newline in `lib/constants.ts` |
| #164 | #154 | Customer dashboard + self-serve export | 5: stray `pr_body.md`; h1 conflicts with Playwright in #149; dupes #159; aggregate `totalTarget` ignores per-task overrides; unused `campaignId` in `assertExportAllowed`; duplicate import; trailing newline |

#### 1.1 Land PR #172
- Worktree: `../work/pr-172-review`
- `lib/constants.ts`: replace `Number(raw ?? "0.1")` with `Number(raw?.trim() || "0.1")`
- `lib/constants.ts`: trailing newline
- Update `docs/features.md` (gold-set behavior)
- Push, request re-review, stop. Do not merge.

#### 1.2 Land PR #164
- Worktree: `../work/pr-164-review`
- Delete `pr_body.md` from repo root
- Resolve h1 vs Playwright (#149): pick "Dashboard" → also update `tests/campaigns.spec.ts`; OR revert to "Campaigns"
- Rebase onto develop after #159 merges (overlap on `AdminNav.tsx` + wallets RBAC)
- `app/admin/(protected)/campaigns/page.tsx`: thread `totalTarget` through `CampaignWithProgress`, use it in aggregate
- `lib/admin-auth.ts`: drop unused `campaignId` param or annotate forward-looking intent
- `app/api/admin/campaigns/[id]/export/route.ts`: merge two `lib/admin-auth` import lines
- Trailing newline on new route file
- Push, request re-review, stop. Do not merge.

### 2. Decision threads (open before coding)

Cluster the `needs-clarification` issues into mega-threads so the answers are
coherent and reusable.

#### 2.1 Mega-thread: "Payout safety" (covers #97, #99)
- Post a single comment on each of #97 and #99, cross-linking
- Decisions to capture: nonce serialization mechanism, retry backoff + abandoned
  status threshold, balance-alert thresholds and channel, payout status lifecycle
  (`pending → sent → confirmed`), idempotency for `payReward`
- Output: short design note in `docs/payout-safety.md` and updated bodies

#### 2.2 Mega-thread: "Campaign config semantics" (covers #100, #103)
- Post a single comment on each of #100 and #103, cross-linking
- Decisions to capture: `Campaign.rewardWei` defaulting + override precedence
  (task → campaign → env), `responseTarget` enforcement semantics, consensus
  result shape returned to customer, pay-every-reviewer-full vs split
- Output: short design note in `docs/campaign-config.md` and updated bodies

(Items #101 and #45 stay as single-issue clarifications — they don't cluster.)

### 3. P1 — Production-readiness (after PRs land)

The "stop losing money, stop losing data" phase from #110.

| # | Issue | Status | Title | Why now | Worktree |
|---|-------|--------|-------|---------|----------|
| #98 | agent-ready | Move rate-limits out of in-memory Map | Blocks horizontal scaling; S8 security gap | `../work/issue-98` |
| #102 | agent-ready | Integration tests for `/api/submit` | 8+ branches around money with zero coverage; R10 | `../work/issue-102` |
| #97 | needs-clarification | Hot-wallet monitoring, nonce safety, balance alerting | S5 security; depends on 2.1 | `../work/issue-97` |
| #99 | needs-clarification | Payout retry job for failed/stuck submissions | S4 security; depends on 2.1 and #97 | `../work/issue-99` |
| #103 | needs-clarification | Per-campaign reward (move off env var) | Depends on 2.2 and #155 landing | `../work/issue-103` |
| #101 | needs-clarification | Error tracking + product analytics + ops dashboard | R9 + observability precondition for P2 | `../work/issue-101` |

#### 3.1 #98 — Rate-limits → Postgres
- New unlogged `RateLimitBucket` table
- `lib/rate-limit.ts` with `check(key, windowMs, max)` + `record(key)`
- Replace call sites: `app/api/submit/route.ts` (15s/wallet) and `app/api/admin/login/route.ts` (5/10min)
- Update `docs/features.md`

#### 3.2 #102 — Vitest harness for `/api/submit`
- Add Vitest + `npm test` script
- PGlite for in-process test DB
- Mock `lib/payout.ts` `payReward`
- Cover: invalid body/wallet/choice/reason, banned, duplicate, gold pass, gold fail, left-bias, payout success, payout failure
- Wire `.github/workflows/ci.yml`

#### 3.3 #97 — Hot-wallet monitoring + nonce safety
- Postgres-advisory-lock around `payReward` (no new infra)
- `GET /api/health/wallet` returning `{ cusd, celo, lastTxAt }`
- Cron + alert on threshold breach
- Flip `payoutStatus: sent → confirmed` after `waitForTx`

#### 3.4 #99 — Payout retry job
- Cron on `payoutStatus IN ("failed","pending") AND createdAt < now() - 1min`
- Re-attempt `payReward` with backoff
- Abandoned status after N attempts
- Surface stuck-row count on admin Wallets/Tasks dashboard
- Idempotency: gate `submissionCount`/`totalEarnedWei` increment on `payoutStatus === "sent"`

#### 3.5 #103 — Per-campaign reward
- Add `Campaign.rewardWei BigInt` (fallback to env)
- Add optional `Task.rewardWei BigInt?`
- Resolution chain: task → campaign → env
- `GET /api/task` surfaces per-task reward
- `TaskCard` shows actual reward, not hardcoded badge

#### 3.6 #101 — Error tracking + analytics + ops dashboard
- Sentry or PostHog error capture
- Product analytics: page view, task viewed, choice, submit, payout confirmed
- `/admin/ops`: 24h submission volume, 24h payout volume, hot-wallet balances, gold-pass rate, error rate
- Hash wallet addresses before any third-party analytics send

### 4. P2 — Customer surface (revenue unlock)

Starts once P1 durable infra (#98, #102, #97, #99) is in develop.

| # | Issue | Title | Depends on |
|---|-------|-------|------------|
| #157 | enhancement | Async task upload: CSV ingestion via background queue | #98, #99, #148 (queue choice) |
| #156 | enhancement | Super Admin: manage users + profiles, customers + campaigns, system health | #134 (audit log), #97 (health view), #113 (customers) |
| #103 (carryover) | needs-clarification | Per-campaign reward | #2.2, #155 |

Note: the customer signup + campaign-create flow described in #110 R1 is
already substantively delivered by the #155/#154 PRs once they merge. The
remaining P2 work is operational polish, not greenfield.

#### 4.1 #157 — Async CSV upload
- `POST /api/admin/campaigns/[id]/upload` returns `202` with a job id
- DB-backed `IngestJob` table drained by a worker (share infra with #99)
- `GET /api/admin/campaigns/[id]/upload/[jobId]` for polling
- Idempotent on `(campaignId, prompt)`

#### 4.2 #156 — Super Admin surface
Decompose into sub-issues before coding:
- Promote `/admin/wallets` to `/admin/users` with demographics, ban/unban actions
- Per-user profile page: submissions + payout history + gold-check record
- Operator view of any customer's campaigns with rename/delete/pause
- System-health view: pool, payout queue, hot-wallet (depends on #97)

### 5. P3 — Quality moat (charge premium rates)

| # | Issue | Title | Depends on |
|---|-------|-------|------------|
| #100 | needs-clarification | Multi-reviewer consensus (enforce `Task.responseTarget`) | #2.2, #103 |
| #148 | documentation → implementation | Task distribution: multi-tenant queues + fair priority | #155, #100 |
| #152 | (no label) | Tech spec: architecture docs + decks | independent |

#### 5.1 #100 — Multi-reviewer consensus
- `GET /api/task` excludes `count(submissions) >= responseTarget`
- Per-campaign + per-task `responseTarget` config
- `GET /api/admin/campaigns/:id/results` returns per-task consensus
- Pay every reviewer the full reward; customer pays N× (priced in)

#### 5.2 #148 — Multi-tenant distribution
- Per-campaign `status: draft | active | paused`
- Two-round scheduler: campaign selection weighted by tier (Sample / Starter / Pro)
  + task type gold vs regular; gold appears ≥2× more often than regular
- `Task.responseCount` tracked; pause/resume retains state
- SUPER_ADMIN tier dropdown on customer profile

#### 5.3 #152 — `docs/architecture.md` + decks
- D2–D5 as Mermaid in one Markdown file (C4 context/container/component,
  sequence for the 4 core flows, ERD, deployment)
- D6 Slidev technical deck → PDF in `docs/decks/technical/`
- D7 pitch deck → PDF in `docs/decks/pitch/`
- Cite current develop SHA at top
- Link from `README.md`

### 6. P4 — Marketplace (Phase 4 in #110, not yet broken out)

Triggered after at least one paying customer exists. Out of scope to pre-plan
in detail; revisit after P2 ships.

### 7. Auth (parallel track)

| # | Issue | Title | Status |
|---|-------|-------|--------|
| #45 | needs-clarification | Metamask + Celo fallback when not in MiniPay | product decision needed (spec §17/§2) |

Single clarification thread, not a cluster. Decide before coding.

### 8. Documentation deliverables (parallel worktrees, no code deps)

| # | Title |
|---|-------|
| #152 | `docs/architecture.md` + decks (P3, listed above) |
| #135 | Playwright integration testing report |
| #115 | Admin full test (24 cases) |
| #117 | Super-Admin customer management test cases |
| #88 | Admin quality & abuse guard test cases |
| #91 | Admin dashboard metrics test |
| #69 | Dataset research |

### 9. Master order of operations

1. Land PR #172 (#155) — release platform gold set + Centient customer
2. Land PR #164 (#154) — release customer dashboard + self-serve export
3. Open clarification mega-threads for #97/#99 and #100/#103
4. P1 code in parallel worktrees: #98, #102 (agent-ready, no clarifications)
5. P1 code after clarifications: #97, #99, #103, #101
6. P2 code: #157, #156
7. P3 code: #100, #148, #152
8. Auth clarification + code: #45
9. P4: re-plan after first paying customer

### 10. Do not do

- Never auto-merge. Humans merge.
- Never work in the main checkout. Always in `../work/{pr|issue}-{N}`.
- Never reuse a worktree across two issues.
- Never silently upgrade scope (e.g. #155 picked up question_bank.csv — that
  belongs in #150/#160/#161, not #155).
- Never commit plaintext credentials to PR descriptions or `.env.local.example`
  (per the #172 review thread).

---

## Part 2 — Session log

> Append-only. Newest entries at the top. One block per PR-open or PR-merge
> event. Triggered by the agent at session end (per `auto-dev.md` step 5).
> Optional CI hook in `.github/workflows/roadmap-log.yml` is a future addition.

<!--
### 2026-06-01 — PR (closes #156) — Super Admin: manage users + profiles, customers + campaigns, and system health
- **Status:** opened (not pushed)
- **Branch:** `feat/super-admin-manage-users-profiles-customers-campaigns-and-system-health`
- **Files touched:**
  - `lib/admin-auth.ts` — `hasRole()` helper makes SUPER_ADMIN a strict superset of CUSTOMER in both guards (per HANDOVER).
  - `prisma/schema.prisma` + `prisma/migrations/20260601000000_issue_156_super_admin_surface/migration.sql` — `Campaign.pausedAt`, `User.bannedAt`, `User.bannedReason`; backfill `bannedAt = createdAt` for any user already flagged.
  - `lib/admin-data.ts` — `getUserRows`, `getUserProfile`, `getHealthSnapshot`, `evaluateBanRule` (pure ban threshold), `isStuckPending` (5-minute threshold).
  - `app/api/admin/users/route.ts` (GET list), `app/api/admin/users/[walletAddress]/route.ts` (GET profile, PATCH ban/unban), `app/api/admin/health/route.ts` (GET snapshot).
  - `app/api/admin/campaigns/[id]/route.ts` — PATCH now accepts `paused: boolean` and emits `campaign.pause` / `campaign.resume` audit rows.
  - `app/api/submit/route.ts` — auto-ban path now uses `evaluateBanRule`, stamps `bannedAt` + `bannedReason`.
  - `app/api/admin/customers/[id]/verify/route.ts` and `…/resend-verification/route.ts` — backfilled `auditLog` calls.
  - `app/api/admin/campaigns/[id]/export/route.ts` — backfilled `auditLog` (was emitting only from the global `/api/admin/export`).
  - `app/admin/(protected)/users/page.tsx` + `components/admin/UserTable.tsx` — real users table (demographics chips, gold accuracy, status filter, search, ban/unban buttons).
  - `app/admin/(protected)/users/[walletAddress]/page.tsx` + `components/admin/UserProfileView.tsx` — per-user profile.
  - `app/admin/(protected)/status-health/page.tsx` — pool + payout + hot-wallet dashboard with stuck-pending alert.
  - `app/admin/(protected)/campaigns/page.tsx`, `…/campaigns/[id]/page.tsx`, `components/admin/CampaignList.tsx`, `components/admin/CampaignDetail.tsx` — SUPER_ADMIN view of any customer's campaign; pause toggle; owner email + paused chip.
  - `components/admin/AdminNav.tsx` — adds Users and Status tabs for SUPER_ADMIN; removes the duplicated `TABS_CUSTOMER` block that snuck in via the develop merge.
  - `components/__tests__/admin-data.test.ts` — 8 new node:test cases (ban rule + stuck-pending).
  - `package.json` — adds `npm test` and `npm run typecheck` scripts.
  - `docs/features.md` — added the #156 entry to the Admin section.
- **Decisions made:**
  - `Campaign.paused` is a single `pausedAt DateTime?` rather than a status enum (matches the field name in the existing schema, no extra migration for the enum later).
  - Ban API is `PATCH /api/admin/users/[wallet]` with `action: "ban" | "unban"` and an optional `reason` that goes into the audit log + `bannedReason` column.
  - `evaluateBanRule` and `isStuckPending` are exported pure functions so `/api/submit` and the admin pages share one source of truth (and so they can be tested without DB).
  - `requireRoleForRoute("CUSTOMER")` now accepts SUPER_ADMIN instead of rewriting the call sites to a hierarchy-aware helper. Strict-superset is the safer default.
- **Open follow-ups:**
  - The campaign "pause" does not yet gate `/api/task` (issue #100 / #148 territory — task distribution hasn't landed). For now the toggle is operator-visible and audited, but tasks keep flowing until the distribution layer is wired.
  - `/admin/ops` is still on the roadmap (#101). `getHealthSnapshot` is the data seam.
  - No integration test harness yet (#102). The new pure helpers have unit coverage; the routes do not.
- **Docs updated:** `docs/features.md`, `ROADMAP.md`.
-->
