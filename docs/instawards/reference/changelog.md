# Full changelog

Every pull request merged since the sprint began on 7 September 2026, generated from GitHub. Dates are Asia/Manila. Commit links open the merge commit on the public mirror, and PR and issue numbers refer to the private development repository.

| Target | Meaning |
| --- | --- |
| `develop` | Integration. Every implementation PR lands here |
| `staging` | Promotion. What [centient.work](https://centient.work) serves |
| `main` | Released deliverables |


## Week 1

| Date (Manila) | Change | Issues | PR | Into | Commit |
| --- | --- | --- | --- | --- | --- |
| 09-07 10:50 | chore: remove the agent-ready Codex dispatch automation | — | #61 | `develop` | [`5307875`](https://github.com/cemmacabales/centient/commit/5307875c71b04bc5b38aa60fbb6dfb31b7c2518a) |
| 09-07 11:09 | docs: re-provision the testnet multisig proof on an operable account | — | #62 | `develop` | [`c8eded2`](https://github.com/cemmacabales/centient/commit/c8eded2179a52aeeb5e1e2b589bf94c94aed491f) |
| 09-07 12:42 | feat(stellar): prove multisig USDC fee-bump payout (#6) | #6 | #64 | `develop` | [`dca64c6`](https://github.com/cemmacabales/centient/commit/dca64c6a0cb9ca2257197f160225305d47bf4560) |
| 09-07 18:48 | feat(stellar): add multisig cold-reserve refills (#10) | #10 | #65 | `develop` | [`7b9d2eb`](https://github.com/cemmacabales/centient/commit/7b9d2ebacc291f8dbb79ad273fa5d4f7b85ecb17) |
| 09-07 22:11 | feat(payout): multisig payout service with sequence-safe submission (#7) | #7 | #66 | `develop` | [`8ad80c3`](https://github.com/cemmacabales/centient/commit/8ad80c328685be0abc4d2b6b930c8e582b08eb2c) |
| 09-07 22:40 | fix(payout): close the ambiguous-submit window and raise docstring coverage (#7) | — | #69 | `develop` | [`3bc6920`](https://github.com/cemmacabales/centient/commit/3bc6920e44879ce47f243c5f768024d8b1c40ef5) |
| 09-07 23:12 | fix(payout): resolve an ambiguous submit only on proof, and never refund one (#7) | — | #70 | `develop` | [`5f4b58c`](https://github.com/cemmacabales/centient/commit/5f4b58c4d0ca9491b7b4d2f3248f09378cc6ddfe) |
| 09-08 11:02 | Dual-asset wallet health monitoring | #11 | #72 | `develop` | [`6fee0a9`](https://github.com/cemmacabales/centient/commit/6fee0a972f844c7f403698f4b8f4cf2f830aae1d) |
| 09-08 12:31 | fix(payouts): close the submission double-pay window and the #5/#7/#10/#11 spec-review gaps (#73) | #73 | #74 | `develop` | [`b96c89d`](https://github.com/cemmacabales/centient/commit/b96c89d5ae07ae919709d85236b1b972588d134e) |
| 09-08 13:54 | feat(cosigner): independent policy co-signer that re-derives payouts from the task ledger (#8) | #8 | #75 | `develop` | [`2bdd6a0`](https://github.com/cemmacabales/centient/commit/2bdd6a0c4b77b933b6fdcfa97ab29f7dd7da2939) |
| 09-08 14:13 | docs(adr): record the simulated co-signer isolation decision for #8 | #8 | #71 | `develop` | [`7efc104`](https://github.com/cemmacabales/centient/commit/7efc104bda28bd7bdfac4974a78bf6ff67a5e380) |
| 09-08 14:13 | fix(cosigner): adapt to the same-project topology and add the setup wizard | — | #76 | `develop` | [`85b0fb2`](https://github.com/cemmacabales/centient/commit/85b0fb2c24971cbe70d05a72ffd897a0d0a48824) |
| 09-08 17:11 | feat: enforce independent daily payout caps | #9 | #78 | `develop` | [`3862ac3`](https://github.com/cemmacabales/centient/commit/3862ac37bb8dbfeebdc6fa2460bb8546b0ff83b4) |
| 09-08 19:06 | test(payout): payments-lane proof — no single-key path, zero double-pays, named CI lane | #12 | #79 | `develop` | [`7437678`](https://github.com/cemmacabales/centient/commit/743767823156a5dbe434b376a0a8beb9c2726634) |
| 09-08 23:26 | ci: exempt merge commits from the commit-identity rule | — | #83 | `develop` | [`3fd157f`](https://github.com/cemmacabales/centient/commit/3fd157fd995e70e7d2468465b16b7c6e46aff69d) |
| 09-09 07:27 | [E1-13b] QA fixtures, reset path, CI at the deployed SHA, and the TC-010/011 evidence decision | #86 | #88 | `develop` | [`0187170`](https://github.com/cemmacabales/centient/commit/0187170a02376062185e872d11775d5da5961f4c) |
| 09-09 18:23 | docs(qa): refresh the Deliverable 1 QA readiness guide onto bbaf426 | — | #89 | `develop` | [`650c624`](https://github.com/cemmacabales/centient/commit/650c62435b193e0a6ad3f6e72a9f34dd6fc40bb0) |
| 09-09 18:53 | chore(release): promote develop to staging — Deliverable 1 payout rail | — | #84 | `staging` | [`6ea51e0`](https://github.com/cemmacabales/centient/commit/6ea51e0ef6f3dd467b7eebf34bf80fdf67fff921) |
| 09-11 14:14 | fix(payout): enforce deployment-level signer custody | — | #93 | `develop` | [`8067123`](https://github.com/cemmacabales/centient/commit/80671230d95891d1bb5a22536298bf3303c2d5e4) |
| 09-11 14:27 | chore(release): promote develop to staging - F-01 custody fix | — | #94 | `staging` | [`263be4c`](https://github.com/cemmacabales/centient/commit/263be4cd5ab06103d965044c6a8bd3c40678f308) |
| 09-11 17:36 | docs(reserve): restate the deployed policy as 20/24/5 after the TC-021 refill | — | #95 | `develop` | [`a1137f9`](https://github.com/cemmacabales/centient/commit/a1137f977713b02b907e16f267da76bebfbf3349) |
| 09-11 17:40 | chore(release): promote develop to staging — reserve policy restated as 20/24/5 | — | #96 | `staging` | [`20f0ac0`](https://github.com/cemmacabales/centient/commit/20f0ac0e8392f0bd27c5c3126fcdc4ee02a2884c) |

## Week 2

| Date (Manila) | Change | Issues | PR | Into | Commit |
| --- | --- | --- | --- | --- | --- |
| 09-14 09:51 | chore(release): promote staging to main — Deliverable 1 payout rail | — | #92 | `main` | — |
| 09-14 11:10 | docs(adr): land ADR-0002 — seeded testnet QA credentials accepted | — | #97 | `develop` | [`00cb858`](https://github.com/cemmacabales/centient/commit/00cb8583ec5f6476982e2deab5674cc5e24b0005) |
| 09-14 13:00 | [E2-1] Freighter-only wallet signing spike: descope Albedo, add the testnet proof harness | #24 | #98 | `develop` | [`34d5094`](https://github.com/cemmacabales/centient/commit/34d5094f4ab15fc851112ec839f7f38797e43046) |
| 09-14 14:52 | [E2-2] Wallet signed-challenge sign-in with expiry and replay protection | #25 | #99 | `develop` | [`b13d7b0`](https://github.com/cemmacabales/centient/commit/b13d7b0710f02d24787b3b83400e84753754dd8a) |
| 09-14 16:57 | [E2-3] Freighter wallet-connect and passwordless contributor sign-in | #26 | #100 | `develop` | [`5a92716`](https://github.com/cemmacabales/centient/commit/5a92716839a121b277e9702f7f6bbc0d8d4aa762) |
| 09-14 18:03 | [E2-4] Sponsored account creation for brand-new zero-XLM addresses | #27 | #101 | `develop` | [`3e791a0`](https://github.com/cemmacabales/centient/commit/3e791a0ba16ef22821d4a5cec7b1695eb4684b97) |
| 09-14 19:18 | [E2-5] Sponsored USDC trustline and fee bump for zero-XLM contributors | #28 | #103 | `develop` | [`fca1191`](https://github.com/cemmacabales/centient/commit/fca1191549e762df069ad0f22278bf31f4bb69d8) |
| 09-14 19:18 | ci: cancel superseded PR runs, scope the contributor check, and assert the heartbeat's own writes | — | #102 | `develop` | [`97dbb3c`](https://github.com/cemmacabales/centient/commit/97dbb3c6915a2a19fef419e23be04d3887c90ba8) |
| 09-14 23:11 | feat(reclaim): track and safely reclaim eligible sponsored Stellar reserves (#29) | #29 | #104 | `develop` | [`b83a358`](https://github.com/cemmacabales/centient/commit/b83a358eee56701f7ec67a495941ec78e9b41ca4) |
| 09-15 14:57 | [E2-7] First-connect onboarding: wallet identity is the USDC payout destination | #29, #30 | #107 | `develop` | [`9de7591`](https://github.com/cemmacabales/centient/commit/9de759185bb8882d48eed04ce4d64f4e85120a2f) |
| 09-15 14:57 | fix(reclaim): redact addresses from a stored report's error details | — | #106 | `develop` | [`99e3e47`](https://github.com/cemmacabales/centient/commit/99e3e470ba8b33d9afe7bcebfd15ae8e82ca789c) |
| 09-15 15:19 | feat(analytics): route PostHog through /ingest and instrument key flows | — | #108 | `develop` | [`81667c8`](https://github.com/cemmacabales/centient/commit/81667c8f9c394be9e2f0827b649226364a585a42) |
| 09-15 16:22 | fix: address the PR #105 review findings (onboarding, sponsorship, reclaim) | — | #109 | `develop` | [`5d7a2bc`](https://github.com/cemmacabales/centient/commit/5d7a2bccf56a45e489cb4269cf84bace2156ca0a) |
| 09-15 16:27 | chore(release): promote develop to staging — Deliverable 2 onboarding through #29 | — | #105 | `staging` | [`7ff7dee`](https://github.com/cemmacabales/centient/commit/7ff7dee28f532e5cb9d63199368d42b67bc73d37) |
| 09-16 01:56 | feat(landing): rebuild the sign-in screen as a split hero with the owl up front | — | #112 | `develop` | [`77ddbad`](https://github.com/cemmacabales/centient/commit/77ddbadb597df7f5d85ff51c72bd27d9187fde72) |
| 09-16 01:56 | chore(stellar): remove the last Celo artifacts | — | #111 | `develop` | [`6dfea3b`](https://github.com/cemmacabales/centient/commit/6dfea3b98f7351da28854b2b200b445429abf4cc) |
| 09-16 01:56 | feat(analytics): track failed withdrawals and wallet connect failures | — | #110 | `develop` | [`ec4b4e1`](https://github.com/cemmacabales/centient/commit/ec4b4e13f116d1c5adbcb8dd741b1c8c57581fa9) |
| 09-16 02:02 | fix(landing): name the configured reward token in the wallet note | — | #114 | `develop` | [`de07bdd`](https://github.com/cemmacabales/centient/commit/de07bdde719cee2ee0438517899ee3fa18aed44f) |
| 09-16 02:08 | chore(release): promote develop to staging — landing hero, failure analytics, Celo cleanup | — | #113 | `staging` | [`e3db582`](https://github.com/cemmacabales/centient/commit/e3db582cf84d1c3a0d88ca7e5cd16161982958ec) |
| 09-16 02:30 | feat(landing): cycle the owl through its poses, the part #112 left out | — | #115 | `develop` | [`242de94`](https://github.com/cemmacabales/centient/commit/242de946b19e0fdc102c8a6145026e9bc9be9407) |
| 09-16 02:32 | chore(release): promote develop to staging — the owl's pose loop (#115) | — | #116 | `staging` | [`7564b5c`](https://github.com/cemmacabales/centient/commit/7564b5c644b6236604ab78e2c6392e3202989fce) |
| 09-16 12:36 | fix(auth): return to the landing page when logging out, without a reload | — | #117 | `develop` | [`184cd77`](https://github.com/cemmacabales/centient/commit/184cd77544229ad9b9788700e14d884f7dcbe16f) |
| 09-16 12:42 | chore(release): promote develop to staging — instant logout (#117) | — | #118 | `staging` | [`b52eb13`](https://github.com/cemmacabales/centient/commit/b52eb1372b8b5105afe5613f19b074bb2de19618) |
| 09-17 12:23 | feat(payout): record every on-chain payout in PostHog | — | #119 | `develop` | [`aac52cc`](https://github.com/cemmacabales/centient/commit/aac52ccf6533b69e70876390c817be06bf8d0f40) |
| 09-17 12:32 | chore(release): promote develop to staging — PostHog payout transactions (#119) | — | #120 | `staging` | [`8f660cc`](https://github.com/cemmacabales/centient/commit/8f660cc632f1c868a41618434a1c169dc0edabcc) |

*Generated 18 September 2026 from `gh pr list --state merged`. It is regenerated at the end of each week.*
