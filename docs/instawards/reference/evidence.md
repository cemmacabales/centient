# Evidence index

Every account and transaction from the sprint, in one place. Transaction and account links open on [stellar.expert](https://stellar.expert/explorer/testnet) and need no account.

{% hint style="warning" %}
**Testnet history is reset periodically.** Hashes are recorded in full so they can be checked against any archive. The raw evidence runs are committed as JSON in the repository ([evidence files](#evidence-files)), so the record survives even if an explorer link stops resolving.
{% endhint %}

## Accounts

| Account | Role | Status |
| --- | --- | --- |
| [`GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO`](https://stellar.expert/explorer/testnet/account/GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO) | **Payout account (hot wallet)**, 2-of-3 | **Deployed.** Configured and first paid out on 8 September |
| [`GC5UOKLU6J2EROZYYP2I23ZEF4YF42TGGRNQMMTGOJGJ7NOCH3TTR4A6`](https://stellar.expert/explorer/testnet/account/GC5UOKLU6J2EROZYYP2I23ZEF4YF42TGGRNQMMTGOJGJ7NOCH3TTR4A6) | **Cold reserve**, 2-of-3 | **Deployed** since 11 September (TC-021). From 7–8 September it was the spike's payout account |
| [`GDPGRS4P6UZZK23CKKELGLJAYTCAWPV4C7TH6Q322SF735A5H6U5XK5G`](https://stellar.expert/explorer/testnet/account/GDPGRS4P6UZZK23CKKELGLJAYTCAWPV4C7TH6Q322SF735A5H6U5XK5G) | First cold reserve, 2-of-3 | Historical. The #10 refill proof on 8 September; replaced on 11 September |
| [`GAFGVTR2TMPQZWWYUNIAOTFTIFPRUODUD4LB5M2IRA6ORLE4CCPXS7OK`](https://stellar.expert/explorer/testnet/account/GAFGVTR2TMPQZWWYUNIAOTFTIFPRUODUD4LB5M2IRA6ORLE4CCPXS7OK) | First multisig proof, 2-of-3 | Historical. Still configured correctly, but its signer secrets were not kept, so it cannot be operated |
| [`GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`](https://stellar.expert/explorer/testnet/account/GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5) | Testnet USDC issuer | External |

**Why so many multisig accounts.** All of them remain 2-of-3 with thresholds 2/2/2 on-chain today.

1. The first account (19 August) proved the topology but could not sign, because its secrets were not kept. The lesson is recorded: a multisig proof is only useful if the signing material survives with it.
2. `GC5UOKLU…` (7 September) ran the spike and the first payouts.
3. The deployed build moved to `GCP34RIT…` on 8 September.
4. The first cold reserve, `GDPGRS4P…`, proved refills the same day.
5. On 11 September, `GC5UOKLU…` was re-provisioned as the cold reserve for the TC-021 refill test.

### Signers, as read from Horizon on 18 September

**Payout account** `GCP34RIT…4BUO`, thresholds low / med / high = 2 / 2 / 2:

| Signer | Weight |
| --- | --- |
| `GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO` (master) | 1 |
| `GAHZKJFAWX3HXAYQFAPCJ3Y2DFHYBOCSNVBJTZRDYJXN763KIR6HZ2U6` | 1 |
| `GCAUNAS2ZHBROHNKP32KWMEPJGMX5XJMSGNKXV3YVMRZ72SFBL3PKHIU` | 1 |

**Cold reserve** `GC5UOKLU…R4A6`, thresholds 2 / 2 / 2:

| Signer | Weight |
| --- | --- |
| `GC5UOKLU6J2EROZYYP2I23ZEF4YF42TGGRNQMMTGOJGJ7NOCH3TTR4A6` (master) | 1 |
| `GDNL2OG7XGBHTPNW4WQAT7AVLXYFHAP76DVYFMSKIZLP47KYMOLS27V3` | 1 |
| `GB6NBHA5ML3DOAQXBSDRNYVJUE6B3VPEP2BH5ZXPL5D6YZV5DJC6IWLI` | 1 |

## Deliverable 1 transactions

| Date | What it proves | Signatures | Transaction |
| --- | --- | --- | --- |
| 19 Aug | First account configured as a 2-of-3 multisig (historical) | 1 | [`6446ef5b…`](https://stellar.expert/explorer/testnet/tx/6446ef5b30d3df9f1e12cebf0afb369e895c4d94b4402b07fd300732c92ae142) |
| 7 Sep | Operable payout account configured as a 2-of-3 multisig | 1 | [`8a16d623…`](https://stellar.expert/explorer/testnet/tx/8a16d6236cbb0aa1887eba35f6b4b04e41e289532df06b1d13413551e8fc1ad5) |
| 7 Sep | Payout account's USDC trustline, multisig-signed | 2 | [`dd5c8f61…`](https://stellar.expert/explorer/testnet/tx/dd5c8f61f0e18b31f7f16c4d947070d12cc45c62befa844935dbd03d08ea8fe4) |
| 7 Sep | Sponsored recipient account + USDC trustline (recipient holds no XLM) | 3 | [`63dba352…`](https://stellar.expert/explorer/testnet/tx/63dba35261787b2fa05c0c1c833a02f5983c3a4e229d984a7ed1ecf3c881a71b) |
| 7 Sep | **First multisig-signed USDC payment** (inner transaction) | 2 | [`91b46b51…`](https://stellar.expert/explorer/testnet/tx/91b46b51e73c5ec650913dd395c803e16a7ca32d44d962e4e61be8134df20b3c) |
| 7 Sep | Fee-bump wrapper: Centient pays the fee | 2 | [`be8a6a23…`](https://stellar.expert/explorer/testnet/tx/be8a6a2363401ff77f3634b8af47db88a4e2706e401319fa8ecd2412342e9154) |
| 8 Sep | Payout-service settlement, fee-bumped | 2 | [`9f6b8ae9…`](https://stellar.expert/explorer/testnet/tx/9f6b8ae96a2d17cf3ba2fd585f1e434287bc7113d33f5ecec75cbbe53470996c) |
| 8 Sep | First cold reserve (`GDPGRS4P…`): USDC trustline | 1 | [`fddea73e…`](https://stellar.expert/explorer/testnet/tx/fddea73e981194f020bcf531f96140c3117f8c400915228e6901c2312b4a8c6a) |
| 8 Sep | First cold reserve configured as a 2-of-3 multisig | 1 | [`05bbe397…`](https://stellar.expert/explorer/testnet/tx/05bbe397033a7984700b8d844cf1d247e04db7537fd9a0293a5bda6c1506d14a) |
| 8 Sep | Hot → cold funding transfer through the multisig payout service, fee-bumped | 2 | [`452fd680…`](https://stellar.expert/explorer/testnet/tx/452fd68061ecae052ebd681ee47010adbc2e05c01c86afb9bba685a77fb1d836) |
| 8 Sep | Cold → hot refill, signed by cold master + cold ops (#10) | 2 | [`3a5969cd…`](https://stellar.expert/explorer/testnet/tx/3a5969cdac22dad6646630c90cdb3ae3919a727f2abd8f663863b7e9e6b9ef3e) |
| 8 Sep | **Deployed** payout account (`GCP34RIT…`) configured as a 2-of-3 multisig | 1 | [`e966c0a5…`](https://stellar.expert/explorer/testnet/tx/e966c0a5c27cbe0253f2812d158b38f8e91513de48254923f9ecb6f4c19630fd) |
| 8 Sep | Two-signature 1 USDC payout from the deployed account, fee-bumped | 2 | [`5083dd72…`](https://stellar.expert/explorer/testnet/tx/5083dd72a16bfa749c6b302c293e931939acd70cc52f63586443921d60698206) |
| 11 Sep | **F-01 bypass proof.** `web` held two signer seeds and produced both signatures itself, without the co-signer. Kept on record as the finding the custody guard now prevents | 2 | [`81d799d3…`](https://stellar.expert/explorer/testnet/tx/81d799d3315421707d64ad3ca0d7903598b0839d8a1af5638347bd13615717fd) |

## Deliverable 2 evidence

| Date | What it proves | Transaction |
| --- | --- | --- |
| 14 Sep | Sponsorship signed in the **real Freighter extension** and submitted (#24) | [`0c16eadd…`](https://stellar.expert/explorer/testnet/tx/0c16eadd6ea8f710371a3dfcf3f6935c632f2b46d12909c0709498095e72da1b) |
| 14 Sep | **Sponsored account + trustline for a never-funded address** (#27) | [`b1ef0d3a…`](https://stellar.expert/explorer/testnet/tx/b1ef0d3aa2d3f74f7b86c3cbff840205718e76164b70e3774b5263a3051a435b) |
| 14 Sep | **Sponsored trustline in a fee bump**; the contributor signs the minimum inner fee (#28) | [`776cdee0…`](https://stellar.expert/explorer/testnet/tx/776cdee005e9e46ec990d877f87a024751700e1d5bac5dc83663919a033e4c54) |
| 14 Sep | Reclaim run: sponsorships created through the #27/#28 path (#29) | [`eb42524d…`](https://stellar.expert/explorer/testnet/tx/eb42524d2d9639ae2d8fcc43a546b6d85864f78e608ac01bdde913b1b1578f09), [`390d6f01…`](https://stellar.expert/explorer/testnet/tx/390d6f015684d4c07dc8f7689ee52ca507aad22f4cb5a0e49598cfc1ff7a6912), [`b6b4008b…`](https://stellar.expert/explorer/testnet/tx/b6b4008b6c57415fd06fe44c50cabd7a9b3f654f5de8f4526d77b730abe66ba4), [`fb6a0a9b…`](https://stellar.expert/explorer/testnet/tx/fb6a0a9bfa1da49726d637b2a9be780e2497b6754c450d92bfd37055f5e974d8), [`7059978d…`](https://stellar.expert/explorer/testnet/tx/7059978de068d85b2809ff627388f4eeabcc510ad4081530e9bb6d703e8eceea) |
| 14 Sep | An owner removed its own trustline and merged away; the sponsor got 3 reserves back (#29) | [`07cdba0a…`](https://stellar.expert/explorer/testnet/tx/07cdba0a8b21fe7dc40471738043842a9c52337f736cfa77da383086398e5e74) |
| 14 Sep | **Revocations executed by reclaim**; the contributor keeps the trustline (#29) | [`d064b947…`](https://stellar.expert/explorer/testnet/tx/d064b94722463b8a4d3e9cfa335ca57644e1857665c69e7d60d0721fd8779484), [`1f9cefbf…`](https://stellar.expert/explorer/testnet/tx/1f9cefbf66e7b5c9a203851e811213b5e4f9da223d1df052c59236e59c4c131c) |

The signed-challenge evidence has no transaction, because signing a message does not touch the ledger. It is in the Freighter evidence file below: a real SEP-53 signature and seven verification checks.

## Evidence files

| File | Issue | Contents |
| --- | --- | --- |
| [`payments-lane-evidence.md`](https://github.com/cemmacabales/centient/blob/develop/docs/payments-lane-evidence.md) | #12 | The no-single-key guard, the Definition-of-Done mapping and residual risks |
| [`2026-09-14-freighter-wallet-signing-evidence.json`](https://github.com/cemmacabales/centient/blob/develop/docs/superpowers/specs/2026-09-14-freighter-wallet-signing-evidence.json) | #24 | Freighter connect, challenge, replay, decline and sponsorship signing |
| [`2026-09-14-sponsored-account-creation-evidence.json`](https://github.com/cemmacabales/centient/blob/develop/docs/superpowers/specs/2026-09-14-sponsored-account-creation-evidence.json) | #27 | Never-funded address → sponsored account, decline, duplicate submit |
| [`2026-09-14-sponsored-trustline-fee-bump-evidence.json`](https://github.com/cemmacabales/centient/blob/develop/docs/superpowers/specs/2026-09-14-sponsored-trustline-fee-bump-evidence.json) | #28 | Six forged-envelope refusals, fee bump, minimum inner fee |
| [`2026-09-14-sponsored-reserve-reclaim-evidence.json`](https://github.com/cemmacabales/centient/blob/develop/docs/superpowers/specs/2026-09-14-sponsored-reserve-reclaim-evidence.json) | #29 | 19/19 reclaim checks |
| [`2026-09-15-first-connect-onboarding-evidence.json`](https://github.com/cemmacabales/centient/blob/develop/docs/superpowers/specs/2026-09-15-first-connect-onboarding-evidence.json) | #30 | Definition of Done → named tests |

## Builds

| Build | SHA | Meaning |
| --- | --- | --- |
| D1 QA-passed | [`263be4c`](https://github.com/cemmacabales/centient/commit/263be4cd5ab06103d965044c6a8bd3c40678f308) | `QA:PASSED` 28/28 on #80 |
| D1 on `main` | — | Promoted by PR #92 on 14 September |
| D2 under test | [`8f660cc`](https://github.com/cemmacabales/centient/commit/8f660cc632f1c868a41618434a1c169dc0edabcc) | Deployed on `staging`, reviewed `P0:0 P1:0`; same tree as `develop` [`aac52cc`](https://github.com/cemmacabales/centient/commit/aac52ccf6533b69e70876390c817be06bf8d0f40) |

## Screenshots and recordings

| Item | Deliverable | Status |
| --- | --- | --- |
| Deliverable 1 proof of deliverables (PDF, explorer captures of both accounts and a two-signature payment) | D1 | Held by the builder; to be attached here |
| Recording: wallet connect → signed challenge → session issued | D2 | Pending from #31 |
| Recording: connect → rank → instant USDC → reconciled | D3 | Week 3 |
| 3–5 minute demo | D4 | Week 4 |
