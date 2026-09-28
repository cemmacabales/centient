# D4 multisig re-verification (#45)

Re-verifies, before the public release, that the live hot payout account and cold
reserve still enforce the no-single-signer boundary. Only public data is
recorded here: account and signer public keys, Horizon output and transaction
hashes. **Stellar testnet only** (D-7).

**Taken:** 2026-09-28, at testnet ledger 4909240 (04:29:47Z), against the
deployment's own configuration. The accounts under test are the ones `web` is
configured with, not the historical accounts recorded in the runbooks.

## Result

| Account | Role | Thresholds (low/med/high) | Signers, weight 1 each | Verdict |
| --- | --- | --- | --- | --- |
| [`GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO`](https://stellar.expert/explorer/testnet/account/GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO) | Hot payout (`STELLAR_PLATFORM_ACCOUNT`) | 2 / 2 / 2 | master, ops `GAHZKJFA…Z2U6`, policy `GCAUNAS2…PKHIU` | ✅ Pass |
| [`GC5UOKLU6J2EROZYYP2I23ZEF4YF42TGGRNQMMTGOJGJ7NOCH3TTR4A6`](https://stellar.expert/explorer/testnet/account/GC5UOKLU6J2EROZYYP2I23ZEF4YF42TGGRNQMMTGOJGJ7NOCH3TTR4A6) | Cold reserve (`STELLAR_COLD_RESERVE_ACCOUNT`) | 2 / 2 / 2 | master, cold ops `GB6NBHA5…IWLI`, cold policy `GDNL2OG7…27V3` | ✅ Pass |

Every signer has weight 1 and every threshold is 2. So any payment, and any
change to the signer set, needs two of the three keys. **No single key, the
master included, can move payout or reserve funds.**

## Command output

`scripts/stellar-multisig-verify.ts` is read-only. It loads the account from
Horizon, requires the configured co-signers to be present, and exits non-zero
unless payments need at least two signatures and the master alone cannot pay.

```bash
STELLAR_NETWORK=testnet \
STELLAR_PLATFORM_ACCOUNT=GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO \
STELLAR_OPS_SIGNER_PUBLIC=GAHZKJFAWX3HXAYQFAPCJ3Y2DFHYBOCSNVBJTZRDYJXN763KIR6HZ2U6 \
STELLAR_POLICY_SIGNER_PUBLIC=GCAUNAS2ZHBROHNKP32KWMEPJGMX5XJMSGNKXV3YVMRZ72SFBL3PKHIU \
  npx tsx scripts/stellar-multisig-verify.ts
```

```text
=== Payout multisig verification ===
account : GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO
explorer: https://stellar.expert/explorer/testnet/account/GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO

Thresholds: { low_threshold: 2, med_threshold: 2, high_threshold: 2 }
Signers:
  GAHZKJFAWX3HXAYQFAPCJ3Y2DFHYBOCSNVBJTZRDYJXN763KIR6HZ2U6  weight=1  (co-signer)
  GCAUNAS2ZHBROHNKP32KWMEPJGMX5XJMSGNKXV3YVMRZ72SFBL3PKHIU  weight=1  (co-signer)
  GCP34RITQIVSLHS5T4XZRENIBUS3T7FHL3VSR24GK7HPMHGAAKWK4BUO  weight=1  (master)

✅ Definition of Done met: payments require ≥ 2 signatures; master alone cannot pay.
```

```bash
STELLAR_NETWORK=testnet \
STELLAR_PLATFORM_ACCOUNT=GC5UOKLU6J2EROZYYP2I23ZEF4YF42TGGRNQMMTGOJGJ7NOCH3TTR4A6 \
STELLAR_OPS_SIGNER_PUBLIC=GB6NBHA5ML3DOAQXBSDRNYVJUE6B3VPEP2BH5ZXPL5D6YZV5DJC6IWLI \
STELLAR_POLICY_SIGNER_PUBLIC=GDNL2OG7XGBHTPNW4WQAT7AVLXYFHAP76DVYFMSKIZLP47KYMOLS27V3 \
  npx tsx scripts/stellar-multisig-verify.ts
```

```text
=== Payout multisig verification ===
account : GC5UOKLU6J2EROZYYP2I23ZEF4YF42TGGRNQMMTGOJGJ7NOCH3TTR4A6
explorer: https://stellar.expert/explorer/testnet/account/GC5UOKLU6J2EROZYYP2I23ZEF4YF42TGGRNQMMTGOJGJ7NOCH3TTR4A6

Thresholds: { low_threshold: 2, med_threshold: 2, high_threshold: 2 }
Signers:
  GB6NBHA5ML3DOAQXBSDRNYVJUE6B3VPEP2BH5ZXPL5D6YZV5DJC6IWLI  weight=1  (co-signer)
  GC5UOKLU6J2EROZYYP2I23ZEF4YF42TGGRNQMMTGOJGJ7NOCH3TTR4A6  weight=1  (master)
  GDNL2OG7XGBHTPNW4WQAT7AVLXYFHAP76DVYFMSKIZLP47KYMOLS27V3  weight=1  (co-signer)

✅ Definition of Done met: payments require ≥ 2 signatures; master alone cannot pay.
```

Anyone can re-run both commands. They need no secrets.

## No drift since setup

Each account has one `set_options` transaction on record, and it is the one that
configured it:

| Account | `set_options` transaction | Set |
| --- | --- | --- |
| Hot `GCP34RIT…` | [`e966c0a5…30fd`](https://stellar.expert/explorer/testnet/tx/e966c0a5c27cbe0253f2812d158b38f8e91513de48254923f9ecb6f4c19630fd), 2026-09-08 06:30Z | master weight 1, thresholds 2/2/2, signers `GCAUNAS2…` and `GAHZKJFA…` at weight 1 |
| Cold `GC5UOKLU…` | [`8a16d623…1ad5`](https://stellar.expert/explorer/testnet/tx/8a16d6236cbb0aa1887eba35f6b4b04e41e289532df06b1d13413551e8fc1ad5), 2026-09-07 02:57Z | master weight 1, thresholds 2/2/2, signers `GB6NBHA5…` and `GDNL2OG7…` at weight 1 |

Both were read from Horizon's operations for each account, newest first. No
later signer or threshold change exists.

## Who holds which key

The on-chain boundary holds only if no single deployment holds two signing keys
for the same account. This was checked against the Railway services' variables,
**by variable name**. For the seeds that are present, only the derived public key
was compared. No seed value was printed or recorded.

| Key | Signer on | Held by |
| --- | --- | --- |
| Hot master `GCP34RIT…` | Hot | **No deployment.** `web` carries no `STELLAR_PLATFORM_SECRET` (F-01) |
| Hot ops `GAHZKJFA…` | Hot | `web` (`STELLAR_OPS_SIGNER_SECRET`) |
| Hot policy `GCAUNAS2…` | Hot | `cosigner` (`STELLAR_POLICY_SIGNER_SECRET`), and nothing else |
| Cold master, cold ops, cold policy | Cold | **No deployment.** `web` holds the cold public keys only |
| Sponsor `GDF6XPTB…XD5S` | **Neither** | `web` (`STELLAR_SPONSOR_SECRET`) |

So `web` holds one hot signer (ops) and the co-signer holds one (policy). Neither
can meet the threshold alone, and the policy co-signer re-derives every payout
from the ledger before it signs (ADR-0001). The sponsor key, which `web` also
holds, is not a signer on either account.

## Observations, not failures

- **The cold runbook's evidence record names an earlier cold account.** That
  record is the 2026-09-08 proof on `GDPGRS4P…`. The deployment uses
  `GC5UOKLU…`, the first hot payout account re-provisioned as cold, and the
  runbook already says so in its deployed-policy note (merged 2026-09-11 in
  #95). *Corrected 2026-09-28:* this record first said the fix was only on the
  unmerged `fix/f01-payout-key-custody` branch. That branch's runbook is
  identical to `develop`'s.
- **`web` has no `STELLAR_OPS_SIGNER_PUBLIC`.** The runbook says the ops public
  key lives in the env. The payout path signs with the ops seed directly and
  reads no public variable, so the command above supplies the key from this
  record.
- **Role names differ from the historical record.** The deployment calls
  `GB6NBHA5…` the cold *ops* signer and `GDNL2OG7…` the cold *policy* signer. The
  multisig runbook's historical section, written when this was the hot account,
  names them the other way round. Every weight is 1, so the labels do not change
  the boundary.
- **The in-code guard is on `develop`.** The check that refuses a deployment
  holding the payout threshold alone merged on 2026-09-11 in #93 as `6d5d0b4`
  (`lib/stellar/key-custody.ts`), and the payout submitter calls it through
  `assertCustodyBelowThreshold`. *Corrected 2026-09-28:* this record first said
  the guard was only on the unmerged F-01 branch. It looked for `be86d20`, the
  branch's pre-merge SHA, which never reached `develop` under that SHA.
