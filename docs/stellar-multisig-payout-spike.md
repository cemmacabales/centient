# E1-2 — Multisig USDC payout spike

Issue: [#6](https://github.com/webnxt-2030/Centient/issues/6)

Network: Stellar Testnet

Executed: 2026-09-07

## Result

The spike completed a real 1 USDC payout from the Centient 2-of-3 multisig
account to a newly generated recipient. Centient sponsored both the recipient
account and its USDC trustline, then paid every transaction fee through the
multisig payout account. The recipient held and spent no XLM.

| Evidence | Value |
| --- | --- |
| Payout account | `GC5UOKLU6J2EROZYYP2I23ZEF4YF42TGGRNQMMTGOJGJ7NOCH3TTR4A6` |
| Recipient | `GA4XSHGIOVGWI6ZGDIRFG3ROFOHXRDVHH5YKGFKC5C2LHOT6EB5WCQXI` |
| USDC before | `0.0000000` |
| USDC after | `1.0000000` |
| USDC increase | `1.0000000` |
| XLM before | `0.0000000` |
| XLM after | `0.0000000` |
| XLM spent | `0.0000000` |
| Fee account | `GC5UOKLU6J2EROZYYP2I23ZEF4YF42TGGRNQMMTGOJGJ7NOCH3TTR4A6` |
| Fee charged for payout | `200` stroops |
| Inner payment signatures | `2` |
| Outer fee-bump signatures | `2` |

### Testnet transactions

- Payout-account USDC trustline: [`dd5c8f61f0e18b31f7f16c4d947070d12cc45c62befa844935dbd03d08ea8fe4`](https://stellar.expert/explorer/testnet/tx/dd5c8f61f0e18b31f7f16c4d947070d12cc45c62befa844935dbd03d08ea8fe4)
- Sponsored recipient account and USDC trustline: [`63dba35261787b2fa05c0c1c833a02f5983c3a4e229d984a7ed1ecf3c881a71b`](https://stellar.expert/explorer/testnet/tx/63dba35261787b2fa05c0c1c833a02f5983c3a4e229d984a7ed1ecf3c881a71b)
- Inner USDC payment hash: `91b46b51e73c5ec650913dd395c803e16a7ca32d44d962e4e61be8134df20b3c`
- Submitted fee-bump transaction: [`be8a6a2363401ff77f3634b8af47db88a4e2706e401319fa8ecd2412342e9154`](https://stellar.expert/explorer/testnet/tx/be8a6a2363401ff77f3634b8af47db88a4e2706e401319fa8ecd2412342e9154)

The Circle testnet USDC issuer used by the configured asset is
`GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`.

## Reusable transaction flow

1. `buildSponsoredRecipientTx` builds one atomic CAP-33 transaction:
   `beginSponsoringFutureReserves`, zero-balance `createAccount`, recipient-
   sourced USDC `changeTrust`, and recipient-sourced
   `endSponsoringFutureReserves`.
2. `buildUsdcPaymentTx` builds the time-bounded inner payment from integer
   seven-decimal USDC units.
3. `addIndependentSignatures` produces each signature against the same
   unchanged transaction hash and then combines them in one envelope.
4. `buildMultisigFeeBump` verifies that the inner transaction contains valid
   signatures from both required keys before wrapping it. Its base fee is the
   greatest of the requested fee, the inner per-operation fee, and Stellar's
   network minimum.
5. The outer fee-bump envelope is independently signed by the master and ops
   signers. `verifyPayoutEvidence` rejects success unless the recipient's USDC
   delta is exact, its XLM remains zero, Centient is the fee account, and both
   envelopes have at least two signatures.

Run the testnet-only proof with:

```sh
npm run stellar:multisig:payout-spike
```

The runner submits each transaction at most once. It creates the payout
account's USDC trustline if necessary and stops with funding instructions if
the account lacks enough testnet USDC.

## Production handoff notes

- A fee is specified in stroops per operation. A fee-bump builder must not pass
  the inner envelope's total fee as though it were a per-operation fee.
- Every transaction is time-bounded and uses the network passphrase when
  computing signatures. The inner source account owns its sequence number;
  wrapping the signed inner transaction must not rebuild or mutate it.
- This spike uses the payout multisig account as the fee source. That makes the
  evidence unambiguous, but it also requires two signatures on both the inner
  and outer envelopes. A dedicated single-key fee account can reduce signer
  coordination if its funding, authorization, and operational risk are handled
  explicitly in the production implementation.
- The existing single-signature `payUsdc` and `buildSponsoredTrustlineTx`
  paths are no longer sufficient for an account whose medium threshold is 2;
  submitting them unchanged fails with `tx_bad_auth`. The production payout,
  fee-sponsorship, and withdrawal issues own their replacement rather than
  weakening the multisig threshold.
- `submitSponsoredTrustline` intentionally rejects fee-bump envelopes today.
  The production integration must choose and test the submission/reconciliation
  boundary explicitly.
- Expected Horizon failures include `op_no_destination` for an absent recipient
  account, `op_no_trust` for a missing recipient USDC trustline, and
  `tx_bad_seq` when the source sequence is stale. Production code may rebuild
  from a freshly loaded sequence only when the prior submission is known not to
  have succeeded. An unknown submission outcome must be reconciled by hash and
  must never be blindly retried.

## References

- [Circle testnet faucet](https://faucet.circle.com/?allow=true)
- [Circle testnet token addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)
- [Stellar fee-bump transactions](https://developers.stellar.org/docs/learn/fundamentals/transactions/fee-bump-transactions)
- [Stellar sponsored reserves](https://developers.stellar.org/docs/learn/encyclopedia/sponsored-reserves)
