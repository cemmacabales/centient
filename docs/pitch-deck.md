# Centient — Pitch Deck Guide

> **Companion to [`docs/pitch-deck-v3.pptx`](./pitch-deck-v3.pptx).** This is the presenter's guide: the per-slide narrative, the three headline themes (Stellar-ecosystem impact, ecosystem-integration plan, and go-to-market), and a Q&A guide for judges and investors.
>
> **Deck version:** v3 (2026) — Stellar edition. **Tagline:** *Train AI, cent by cent.* · **Domain:** `centient.work`
>
> **One-liner:** Centient pays people in USDC on Stellar to teach AI what "better" looks like — a contributor connects a wallet, compares two AI responses, picks the better one, writes a one-line reason, and earns a micro-reward (default 0.05 USDC). AI labs fund campaigns of these comparison tasks.
>
> Source of record for the ecosystem/market claims: **GitHub issue #334** (fully referenced). Deck structure follows **issue #152**. Point-in-time figures are indicative — confirm against #334's verification caveats before external use.

---

## What changed in v3

v3 rebuilds the deck around three themes that are now first-class (and are the reason this guide exists):

1. **Impact on the Stellar ecosystem** (slide 6) — Centient as a real, non-speculative payment flow on Stellar.
2. **Integrating existing Stellar solutions** (slide 7) — a phased NOW / NEXT / LATER roadmap across SEPs, anchors, the Stellar Disbursement Platform, sponsored reserves, and Soroban.
3. **Go-to-market at three levels** (slides 10–11) — Philippines → APAC → Global, plus the supply/demand growth engine.

It also reflects the **Celo → Stellar migration** being complete (`@stellar/stellar-sdk`, Freighter, StrKey addresses, USDC-on-Stellar), and the **accumulate-then-withdraw** payout model.

---

## Deck at a glance

| # | Slide | Purpose |
|---|-------|---------|
| 1 | Title | Hook: *Train AI, cent by cent.* — paid AI labeling on Stellar |
| 2 | The problem | Preference data is the moat; workers are underpaid; rails exclude them |
| 3 | The solution | The connect → compare → reason → get-paid loop; quality built-in |
| 4 | Why now | Three curves crossing: neutral-data demand, Stellar's cash-out rail, viable micropayments |
| 5 | Product | Two-sided marketplace, both sides already built |
| 6 | **Impact on the Stellar ecosystem** | Wallet activations, USDC velocity, anchor off-ramp volume, inclusion |
| 7 | **Integrating the Stellar ecosystem** | Sponsored reserves, SEPs, anchors, SDP, Soroban — phased |
| 8 | Market | ~26–28% CAGR; the lane no competitor owns |
| 9 | Business model | Campaign take-rate, quality tiers, enterprise API, SCF funding |
| 10 | **Go-to-market (levels)** | Philippines → APAC → Global |
| 11 | **Go-to-market (engine)** | Supply loop, demand loop, the flywheel |
| 12 | Where we are | Product shipped; distribution + integration next |
| 13 | The ask | Capital, Stellar partnership, design-partner labs |
| 14 | Appendix | Sources & verification note |

---

## Per-slide presenter guide

Condensed talking points (full versions are in each slide's speaker notes inside the pptx).

**1 · Title.** Open with the one-liner and the tagline. Frame the deck: problem → product → **Stellar impact → Stellar integration → market/model → GTM from PH out to global.**

**2 · The problem.** Three problems, one gap. (a) Human preference/RLHF data is a paid moat — labs pay **$1–$10 per datapoint** because it can't be synthesized. (b) The people producing it are paid worst and last — a live ethics story (Kenya <$2/hr, $0.01/task ghost work, a top firm's ~24% wage cut in late 2025). (c) Payment rails are the binding constraint — you can't economically pay someone 5 cents across borders on cards/wires. **The gap: fast, transparent, low-fee dollar payments to the global crowd for AI feedback.**

**3 · The solution.** The labeler loop is deliberately simple (connect · compare A/B · one-line reason · get paid) because our users are first-time crypto users in emerging markets. Key mechanic: **accumulate-then-withdraw** — earnings accrue to an off-chain USDC balance and settle on-chain once at withdrawal, so on-chain volume tracks cash-outs and someone can label before funding a wallet. **Quality is the product**: ~10% hidden gold tasks, inter-annotator agreement, reason-spam/Jaccard checks, left-bias guards, prepaid campaign budgets, and every payout verifiable on-ledger.

**4 · Why now.** Three curves cross in 2026. (1) Post the Meta–Scale deal, labs want **neutral, non-conflicted** suppliers (the wedge growing Prolific and Mercor). (2) **Stellar already owns the emerging-market cash-out rail** — MoneyGram + Circle have moved **>$4.2B** in USDC across **~500k** cash points. (3) Micropayments finally pencil out at **~$0.00001/tx**. "We're not betting these happen — they've happened."

**5 · Product.** A two-sided marketplace where **both sides already exist**. Supply: the labeler app. Demand: a full admin/campaign console (fund USDC campaigns, CSV bulk-upload, progress, dataset export with train/test split). Production-grade stack today (Next.js 16, Prisma/Postgres, Stellar SDK + Freighter, payout worker + reconciler, quality/anti-fraud, observability). **The engineering is done; we're raising for distribution and ecosystem integration.**

**6 · Impact on the Stellar ecosystem** *(headline theme).* Centient routes a genuinely new, **non-speculative** flow onto Stellar across four dimensions: **USDC velocity** (thousands of real micro-payments), **new wallet activations** in underbanked markets (SDF's core inclusion metric), **anchor off-ramp volume** (USDC → local cash), and **zero-XLM onboarding** (sponsored reserves + fee-bump). Positioning: a lighthouse use case at the AI-plus-payments intersection and a strong Stellar Community Fund story — "real dollars to real people, not subsidized speculation."

**7 · Integrating the Stellar ecosystem** *(headline theme).* Message: **we consume existing ecosystem solutions rather than reinventing them.** See the roadmap table below.

**8 · Market.** ~**26–28% CAGR**; a human preference point costs **$1–$10** vs **<$0.01** for AI feedback, and labs keep paying. Competitors: Scale (absorbed by Meta), Surge/Mercor (scarce experts at $85–200/hr), Prolific (closest analog, ~43% take, not crypto-native), Appen (commodity work collapsing). **Centient's lane** — high-volume preference micro-tasks, paid in real USDC, to an emerging-market crowd reachable because Stellar solved cash-out, with transparency as the ethics wedge — is unoccupied.

**9 · Business model.** Two-sided **take-rate** (peers take 35–43%): customers fund USDC campaigns, we skim a platform fee per approved answer — revenue scales with GMV, not headcount. Climb the value chain with **quality tiers** (single-review → consensus → expert-verified) and an **Enterprise API** (programmatic jobs, USDC auto-funding, future agent buyers via x402). Non-dilutive fuel: **SCF Build/Integration** (up to $150K XLM) and the **Matching Fund** (up to $500K). **No speculative token** — being paid in real USDC is the trust moat.

**10 · Go-to-market (levels)** *(headline theme).* Staged across three levels — see the GTM table below. Throughline: **each phase reuses the same Stellar cash-out infrastructure, so expansion is localization, not a rebuild.**

**11 · Go-to-market (engine).** Supply loop (USDC referral bounties + community/ambassador seeding + zero-XLM signup + reputation-gated pay), demand loop (design-partner labs → self-serve console → Enterprise API; neutrality/ethical-sourcing as the sales wedge). **The flywheel:** more labelers → faster, better data → more funded campaigns → bigger USDC payouts + word-of-mouth + anchor cash-out → more labelers. **Every turn also grows Stellar wallet activations, USDC velocity, and anchor volume — our growth and the ecosystem's are the same motion.**

**12 · Where we are.** Honest status: hard engineering done; migration to Stellar complete; **now** = sponsored-trustline onboarding, SEP-24 cash-out, SDP evaluation, and the Philippines labeler pilot with design-partner labs. Proof points we'll report = the same metrics that make the SCF case (activated wallets, WAL, submissions/day, gold pass-rate, USDC paid out, anchor cash-out volume).

**13 · The ask.** (a) **Capital** — fund the PH pilot → APAC expansion and the SEP-24/SDP/sponsored-trustline integrations. (b) **Stellar partnership** — SCF Build/Integration award, anchor introductions (Coins.ph, MoneyGram, Yellow Card), SDF technical support. (c) **Design-partner AI labs** — early customers for preference and multilingual data. Close: "Our growth is Stellar's growth. Train AI, cent by cent."

**14 · Appendix.** Everything is sourced (issue #334 for ecosystem/market; README/whitepaper/features.md/spec.md for product; issue #152 for structure). Point-in-time numbers are indicative and flagged.

---

## Theme 1 — Impact on the Stellar ecosystem

| Dimension | What Centient contributes | Why it matters to SDF |
|---|---|---|
| **USDC velocity** | Thousands of real micro-payments for work done | Stablecoin *utility*, not speculation |
| **Wallet activations** | Every labeler = a net-new activated Stellar wallet in an emerging market | SDF's headline financial-inclusion metric |
| **Anchor off-ramp volume** | Withdrawals convert USDC → PHP/NGN/local cash | Drives volume through MoneyGram + regional anchors |
| **Zero-XLM onboarding** | Sponsored reserves + fee-bump so first-time users need no XLM | Removes the trustline dead-end; keeps users in self-custody |
| **Lighthouse narrative** | Stellar at the AI + payments intersection | Quotable, fundable, PR-ready inclusion story |

## Theme 2 — Stellar ecosystem-integration roadmap

| Phase | Integration | What it does |
|---|---|---|
| **NOW — foundation** | **Sponsored reserves (CAP-33) + fee-bump (CAP-15)** | Zero-XLM onboarding: Centient pays account reserve, USDC trustline, and fees |
| | **SEP-10 web auth + SEP-1 stellar.toml** | Standard, audited account-ownership + discovery |
| | **SEP-53 message signing** | Replace the custom login-nonce with the finalized standard |
| **NEXT — cash-out & payouts** | **SEP-24 anchor cash-out** | In-app USDC → local fiat via MoneyGram, Coins.ph, Yellow Card |
| | **Stellar Disbursement Platform (SDP)** | SDF's open-source bulk-payout engine for the withdrawal leg (retries, custody, reporting) |
| | **SEP-38 quotes** | Show "you'll receive ₱X" before withdrawal |
| **LATER — differentiate** | **Soroban** | On-chain campaign escrow, staking/slashing, proof-of-contribution |
| | **Passkey smart wallets** | Seedless, biometric onboarding once the stack is audited/production-ready |
| | **Path payments / DEX** | Optional "receive your preferred asset" at cash-out |
| **Deliberately NOT** | Running our own anchor · issuing a speculative token | Both add risk and undercut the "paid in real USDC" trust |

## Theme 3 — Go-to-market (Philippines → APAC → Global)

| Level | Why here | Cash-out rail | Motion |
|---|---|---|---|
| **Phase 1 · Philippines** *(beachhead)* | English-fluent, gig/BPO culture, high crypto adoption | Coins.ph + MoneyGram (instant USDC → PHP) | Seed via student orgs, freelancer & crypto communities; lock in design-partner labs; prove quality + unit economics |
| **Phase 2 · APAC** *(expand)* | Indonesia, Vietnam, India, Bangladesh — mobile-first, huge crowds, rising stablecoin demand | Regional anchors | Localize; native/low-resource-language preference data as premium demand; ambassador chapters (SCF Instawards) |
| **Phase 3 · Global** *(scale)* | Africa + LatAm | Yellow Card, ClickPesa; Vibrant, MoneyGram | Enterprise API + neutrality positioning; expertise routing (medical, legal, code, multilingual); funded by revenue + SCF Build/Growth |

**Growth engine:** supply loop (referral bounties + community seeding + zero-XLM signup + reputation-gated pay) × demand loop (design-partner labs → self-serve console → Enterprise API) → a flywheel that compounds both revenue **and** Stellar ecosystem metrics.

---

## Q&A guide — anticipated questions from judges & investors

Grouped by theme. Answers are talking points, not scripts — adapt to the room.

### A. Product, data quality & moat

**Q1. What exactly is the data you produce, and why is it valuable?**
Human preference data: for a given prompt, which of two AI responses is better, plus a short written reason. This is the core signal for RLHF and model evaluation. Labs pay **$1–$10 per human preference datapoint** versus **<$0.01** for AI-generated feedback, and they keep paying because human judgment can't be synthesized away. Our "pick-the-better-response + reason" loop *is* that high-value data.

**Q2. How do you guarantee quality when your labelers are an anonymous global crowd?**
Quality is engineered in, not bolted on: ~10% hidden **gold-standard** tasks with known answers score every labeler continuously; **inter-annotator agreement** (consensus) validates items; **reason-spam and near-duplicate (Jaccard)** checks and a **left/right-bias guard** catch low-effort work; and a layered **anti-fraud pipeline** (identity/shared-wallet gates, withdrawal eligibility, tiered cooldown bans) deters gaming. Low-quality work is withheld from payout. Multi-reviewer consensus and a reviewer **reputation score** are on the near-term roadmap.

**Q3. Can't the labs just use AI feedback (RLAIF) or synthetic data instead?**
For instruction/SFT data, synthetic has largely won. But for **preference data and evaluation**, frontier labs still treat human judgment as a competitive moat — that's why Surge, Mercor, and Prolific are growing, not shrinking. We sell the part that stays human.

**Q4. What stops a competitor (or an AI lab) from copying this?**
Three compounding moats: (1) a **quality/reputation system** that takes real volume to train; (2) an **emerging-market crowd reachable only because Stellar solved cash-out** — a US-only competitor can't replicate the MoneyGram/anchor corridor; (3) a **neutrality + transparency** position that lab-owned suppliers (post-Scale/Meta) structurally can't claim. The engineering is table stakes; the crowd + trust + rails are the moat.

**Q5. Is the product real or a mockup?**
Real and production-grade. Both sides of the marketplace are built — the labeler app and a full admin/campaign console (fund campaigns, CSV upload, progress, dataset export). Stack: Next.js 16, Prisma/Postgres, `@stellar/stellar-sdk` + Freighter, an accumulate-then-withdraw ledger, a background payout worker + reconciler, and observability (Sentry/PostHog). See the repo README's architecture and sequence diagrams.

### B. Market & competition

**Q6. How big is the market, really?**
The AI data-labeling market is estimated at **~$1.1B–$4.1B (2025)** growing **~26–28% CAGR**, but those figures mostly track *tooling* — actual human-data services spend is larger (the private leaders alone exceed the "market" as defined). We're honest that the absolute base is soft; the growth direction and the per-datapoint economics are what matter.

**Q7. Who are your competitors and where do you fit?**
Scale (absorbed by Meta; rivals now win neutral work), Surge and Mercor ($10–30B-range, but scarce experts at $85–200/hr to tiny pools), Prolific (closest analog to our loop but ~43% take and not crypto-native), Appen (the cautionary tale of collapsing commodity work), and crypto-native players like Sapien (token-based). **We occupy the unoccupied intersection:** high-volume preference micro-tasks, paid in real USDC, to an emerging-market crowd, transparently.

**Q8. Sapien and other web3 data projects exist — how are you different?**
They pay in volatile governance/utility tokens and lean on token speculation. We pay in **real USDC, instantly, verifiably** — that is our single biggest trust advantage with both labelers and labs, and it's why we deliberately will **not** launch a speculative token.

**Q9. Isn't cheap crowd labeling exactly what's collapsing (see Appen)?**
Commodity, low-skill labeling is being squeezed. We avoid that trap two ways: quality **tiers** that climb toward consensus/expert-verified data, and **expertise routing** (medical, legal, code, multilingual) that captures the high-margin frontier demand. The written-reason field also produces defensible reasoning/critique data.

### C. Business model & unit economics

**Q10. How do you make money?**
A two-sided marketplace **take-rate**: customers prepay USDC campaigns and we skim a platform fee on every approved answer, so revenue scales with gross labeling volume rather than headcount. Peers take **35–43%** (Mercor ~35%, Prolific ~43%), which anchors our pricing power. Quality tiers and an Enterprise API expand ARPU over time.

**Q11. What are the unit economics of a single task?**
Reward is configurable (default 0.05 USDC to the labeler); the customer is charged reward + platform fee, debited from a prepaid campaign balance so **payouts can never exceed funded budget**. On-chain cost is negligible (~$0.00001/tx), and because of **accumulate-then-withdraw** we pay one on-chain transaction per cash-out, not per task — keeping fees economical even at cent-level rewards.

**Q12. Where does non-dilutive or ecosystem funding come from?**
The **Stellar Community Fund** Build/Integration track (up to **$150K in XLM**) explicitly rewards integrating existing ecosystem products — which is exactly our SDP + sponsored-trustline roadmap. The **Matching Fund** can match a priced round up to **$500K**. Regional **Instawards** (~$15K) seed ambassador-led activation in target markets.

**Q13. What's the take-rate today and will it hold under competition?**
We benchmark to the 35–43% peer range and expect to price by quality tier. Downward pressure on commodity take-rates is real, which is exactly why we climb toward consensus/expert data where willingness-to-pay is higher and the take-rate holds.

### D. Stellar, technical & integration

**Q14. Why Stellar and not Ethereum, Solana, or Base?**
Two decisive reasons: (1) **cost** — Stellar's ~$0.00001 base fee makes cent-level payouts viable where L1/L2 gas does not; (2) **cash-out** — Stellar uniquely owns the emerging-market off-ramp via MoneyGram + Circle + regional anchors (~500k cash points, >$4.2B USDC moved). USDC is issued natively on Stellar. Our users need to turn earnings into local cash, and only Stellar delivers that end-to-end today.

**Q15. What Stellar features are you actually integrating, and when?**
Phased. **Now:** zero-XLM onboarding via **sponsored reserves (CAP-33)** + **fee-bump (CAP-15)**, and standards-based auth (**SEP-10**, **SEP-1**, **SEP-53**). **Next:** **SEP-24** anchor cash-out and adopting the **Stellar Disbursement Platform** for the payout leg, with **SEP-38** quotes. **Later:** **Soroban** for campaign escrow/reputation and **passkey** wallets. Full analysis with citations is in GitHub issue #334.

**Q16. The trustline/reserve requirement means a new user needs XLM to receive USDC — how do you solve onboarding?**
This is the single biggest friction and we solve it natively: **sponsored reserves** let Centient pay the account reserve and USDC trustline so the user holds **zero XLM**, and **fee-bump** covers their transaction fees. The result is a first-time labeler who can receive and later withdraw USDC with no XLM and no crypto knowledge — while remaining in self-custody. The cost is bounded and reclaimable.

**Q17. Why build your own payout worker instead of using the Stellar Disbursement Platform from day one?**
We built a hot-wallet worker to ship; SDP is the maturity path. We're evaluating adopting SDP (direct-to-wallet mode) for the withdrawal leg to inherit retries, sequence-safety, custody controls, and reporting for free. The one gate is a **throughput test** — SDP is batch-oriented, so we confirm it fits our high-frequency micro-payout cadence; if not, we adopt its patterns in our worker.

**Q18. Are you running an anchor or issuing a token?**
No to both, deliberately. Running an anchor means money-transmitter licensing and per-country banking — orthogonal to our business; we integrate **existing** anchors instead. And a speculative token would undercut the "paid in real USDC" trust that differentiates us. Both are documented as explicit non-goals.

**Q19. What's your custody / security model for the payout wallet?**
Today: a funded hot wallet signs USDC payments server-side (the secret is never exposed to clients), guarded by a per-day payout cap, sequence-number serialization, trustline-aware payment logic, and a reconciler that confirms on-chain outcomes. Adopting SDP (optionally Circle-backed custody) further reduces hot-wallet key risk and adds segregation-of-duties approvals.

### E. Go-to-market & traction

**Q20. Why the Philippines first?**
It's the ideal beachhead: high English proficiency, deep gig/BPO culture, strong crypto adoption, and — critically — **Coins.ph and MoneyGram give instant USDC → peso cash-out**. We can seed labeler supply through student, freelancer, and crypto communities and prove quality + unit economics in one market before spending on expansion.

**Q21. How do you scale from the Philippines to APAC and globally without starting over each time?**
Every phase **reuses the same Stellar cash-out infrastructure**, so expansion is a localization exercise (language, local anchor, community seeding), not a rebuild. APAC adds premium **native/low-resource-language** demand; the global phase extends the identical playbook to Africa (Yellow Card, ClickPesa) and LatAm (Vibrant, MoneyGram), with an Enterprise API + neutrality positioning on the demand side.

**Q22. How do you acquire labelers cost-effectively and avoid Sybil/fraud farms?**
Supply grows via small **USDC referral bounties** and community/ambassador seeding on top of near-frictionless zero-XLM signup, with **reputation-gated higher pay** as the retention hook. CAC is tied to *verified, productive* users. Fraud is contained by gold-task scoring, **shared-wallet** and **banned-identity** gates, withdrawal-eligibility thresholds (min submissions, gold rate, account age), and a flagged-withdrawal review queue.

**Q23. What traction do you have, and what metrics will you report?**
The product is fully built and migrated to Stellar; we're standing up the **Philippines labeler pilot** with design-partner labs. The metrics we drive and report are deliberately the same ones that make the SCF/partnership case: **activated wallets, weekly active labelers, submissions/day, gold pass-rate, USDC paid out, and anchor cash-out volume.** (Live pilot numbers are inserted as they come in.)

**Q24. This depends on the AI labs actually buying — what's the demand-side proof?**
Demand is validated by the incumbents' growth (Surge, Mercor, Prolific all scaling on human-preference data) and by a specific 2026 tailwind: after the Meta–Scale consolidation, labs actively seek **neutral, non-conflicted** suppliers — the exact position we occupy. We land design-partner labs first, convert them to the self-serve console, then expand into the Enterprise API for recurring volume.

### F. Risks & the ask

**Q25. What's the single biggest risk, and how do you mitigate it?**
Two-sided cold-start (need labelers to attract labs and vice versa). Mitigation: seed the supply side cheaply in one market (PH) where cash-out already works, and use **prepaid campaigns from a few design-partner labs** to guarantee paid work exists from day one — so neither side waits on the other.

**Q26. What are you asking for?**
Three things: **capital** to fund the PH pilot → APAC expansion and the SEP-24 / SDP / sponsored-trustline integrations; a **Stellar partnership** (SCF Build/Integration award, anchor introductions, SDF technical support); and **design-partner AI labs** who value neutral, transparent, ethically-sourced human feedback. Our growth is Stellar's growth.

---

## Sources & caveats

- **Ecosystem, integration & market research:** GitHub issue #334 (fully referenced, with a verification-caveats section).
- **Product & architecture:** repo `README.md` (system + sequence diagrams), `docs/whitepaper.md`, `docs/features.md`, `spec.md`.
- **Deck structure:** GitHub issue #152.
- **Honesty note:** point-in-time figures (market size, anchor coverage, tool versions, dollar volumes) are indicative and move fast — confirm against issue #334 before external use. Prior deck versions live in the team Drive; v3 follows the established brand and pitch structure.
