# Wallet identity and sponsorship

How a contributor with an empty wallet signs in and becomes payable, without email, password or XLM. Built in [Deliverable 2](../deliverables/d2.md).

## One address, three roles

A contributor's case-sensitive `G…` Stellar address is their:

1. **identity**, the account it belongs to,
2. **session subject**, what the session token is issued for, and
3. **payout destination**, the only address their USDC can be sent to.

The address is never normalised or lower-cased. Withdrawing to any other address returns `403 address_not_bound`, and binding a second wallet to an account returns `409 wallet_already_bound`.

## Sign-in: the signed challenge

```
 Browser (Freighter)                         Centient
 ───────────────────                         ────────
 connect → address G…  ──────────────────►   POST /api/auth/wallet/challenge
                                              issue one-time message:
                                                address · network · nonce (128-bit)
                                                issued-at · expires-at (5 min)
                        ◄──────────────────   challenge
 sign (SEP-53)          ──────────────────►   POST /api/auth/wallet/verify
                                              ✓ signature over the SEP-53 digest
                                              ✓ same address, same network, live nonce
                                              → consume challenge (one conditional delete)
                        ◄──────────────────   session for G…
```

| Case | Answer |
| --- | --- |
| Replay an accepted proof | `401 challenge_not_found` (the challenge was consumed) |
| Proof after expiry | `401 challenge_expired` (the challenge is removed) |
| Wrong address, network or signer, or a bad signature | Refused. The challenge **is not consumed**, so the real signer can still use it |
| More than 5 challenges/min for one address, or 20/min from one IP | `429` |

## First connect: sponsored account and trustline

A brand-new address does not exist on the network until someone pays its base reserve, and it cannot hold USDC without a trustline. Centient pays both.

```
 ① server builds:   beginSponsoringFutureReserves(G…)   ← source: sponsor
                    createAccount(G…, 0 XLM)            ← only if the address is brand-new
                    changeTrust(USDC)                   ← source: the contributor
                    endSponsoringFutureReserves         ← source: the contributor
                    inner fee = network minimum
 ② contributor signs in Freighter, which authorises the two operations sourced from their account
 ③ server verifies the exact bytes it built, then signs as sponsor
 ④ server wraps it in a fee bump (Centient pays) and submits
```

The server refuses an envelope that the contributor did not sign, that was signed for another network, that carries an extra signature, that arrives with a client-supplied fee bump, whose bytes changed after the sponsor signed, or that names a different address. Each refusal leaves no ledger row and nothing on-chain.

The sponsor key is **not** a payout signer. That separation is what finding F-01 required.

## Sponsored reserves are a liability

Every sponsored account and trustline locks XLM on the contributor's behalf. Centient tracks it per contributor, and the per-contributor cap is enforced.

**Reclaim** is an operator-run process, and dry run is the default. It applies ordered rules:

1. Pending sponsorships are reconciled, never revoked.
2. A revocation already in flight is waited on.
3. A sponsored line to another asset stops the row.
4. Entries already gone are recorded as released.
5. **Protected:** a linked wallet, an in-flight or flagged withdrawal, an unsettled submission, an owed balance, or USDC on the trustline.
6. An owner who cannot cover the reserve is skipped. On-chain, a revocation fails `op_low_reserve` when the owner holds no XLM.
7. Everything else is eligible.

Because of rule 6, most contributors' reserves stay outstanding. That is the correct outcome: a revocation never removes a trustline a payout needs.

→ [Reclaim runbook](https://github.com/cemmacabales/centient/blob/develop/docs/stellar-sponsorship-reclaim-runbook.md)
