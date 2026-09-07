# Stellar cold-reserve refill runbook

Issue #10 separates the always-online payout wallet from the bulk USDC reserve.
The hot wallet holds only a bounded operating float. The cold reserve is a
separate native Stellar 2-of-3 account, and a refill is accepted only when two
of its three configured identities sign the exact cold-to-hot transaction.

## Security boundary

The deployed application stores these cold values only:

- cold account public key;
- ops and policy co-signer public keys;
- refill trigger, target, and minimum retained USDC units.

It stores no cold seed. The scheduler only reports that a refill is required.
Each custodian runs the `sign` command on isolated infrastructure with exactly
one seed, the public policy, and the separately approved exact amount. Signing
does not contact Horizon. The custodian then removes the seed from the process
environment. The keyless
submit command rechecks the current balances, transaction shape, amount, time
bounds, fee, and every signature before one Horizon submission.

The three allowed signing identities are the cold account master, cold ops, and
cold policy keys. Each has weight 1; low, medium, and high thresholds are 2.
Any two can refill, but no single key can move reserve funds.

## Required configuration

All values refer to the active `STELLAR_NETWORK` and
`STELLAR_USDC_ISSUER`. One USDC is `10000000` units.

```dotenv
STELLAR_COLD_RESERVE_ACCOUNT=G_cold_master_public_key
STELLAR_COLD_OPS_SIGNER_PUBLIC=G_cold_ops_public_key
STELLAR_COLD_POLICY_SIGNER_PUBLIC=G_cold_policy_public_key
STELLAR_PLATFORM_ACCOUNT=G_platform_hot_wallet_public_key
STELLAR_HOT_FLOAT_TRIGGER_UNITS=250000000
STELLAR_HOT_FLOAT_TARGET_UNITS=1000000000
STELLAR_COLD_MIN_RETAIN_UNITS=500000000
```

The example policy triggers at 25 USDC, restores exactly 100 USDC, and refuses
any refill that would leave less than 50 USDC cold. Set values from the measured
daily payout budget. The worst-case USDC loss after a complete hot-wallet
compromise is the configured target, never the remaining cold balance.

The cold account also needs XLM for its base reserve, USDC trustline, and rare
refill fees. Keep at least 5 XLM spendable above its ledger reserve. The refill
transaction pays its own fee and refuses a total fee over 10,000 stroops.

The deployed payout service may derive the same hot account from
`STELLAR_PLATFORM_SECRET`. When public account and secret are both configured,
startup fails if they disagree. Offline custodians configure only the public
account and never receive the hot seed.

## Provision a testnet cold reserve

Generate the master, ops, and policy keys on separate trusted systems. Move
each seed directly into its custodian's secret manager. Exchange only the three
public keys. For a disposable testnet proof, the setup command can generate and
print throwaway keys only when `STELLAR_ALLOW_TESTNET_KEY_GENERATION=true` is
explicitly set; copy them immediately and never commit its output. That switch
is rejected on the public network. Production setup fails closed unless the
master seed and both pre-provisioned signer public keys are supplied.

Initial setup requires the master seed only long enough to create the USDC
trustline and install the 2/2/2 threshold policy:

```bash
STELLAR_NETWORK=testnet \
STELLAR_COLD_RESERVE_SECRET='<master seed from secure injection>' \
STELLAR_COLD_OPS_SIGNER_PUBLIC='G…' \
STELLAR_COLD_POLICY_SIGNER_PUBLIC='G…' \
STELLAR_PLATFORM_ACCOUNT='G…' \
STELLAR_USDC_ISSUER='GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' \
npm run stellar:reserve:setup
```

On testnet, a missing cold account is friendbot-funded. The script establishes
the configured USDC trustline before raising thresholds, configures master/ops/
policy at weight 1, verifies 2/2/2 through Horizon, and prints public explorer
links. It verifies the cold seed matches any configured cold public key and
rejects a cold account that matches the configured hot wallet before making a
network call. On public network it never funds an account or generates keys
automatically.

If the account already has any active signer outside the intended master, ops,
and policy keys, setup aborts before creating a trustline or changing
thresholds. Remove that signer only through an explicitly authorized manual
recovery signed under the account's current policy, then rerun setup.

After setup:

1. Verify the three public keys and thresholds on stellar.expert.
2. Fund the cold XLM floor.
3. Send USDC to the cold account through the Circle testnet faucet or an
   approved treasury transfer.
4. Fund the hot account with no more than its target float.
5. Remove `STELLAR_COLD_RESERVE_SECRET` from the setup environment.

Once the thresholds are installed, key rotation needs any two current
custodians. Do not expect the setup script's single master signature to rotate
an already secured account.

## Scheduled detection

Call the authenticated endpoint on the chosen schedule (hourly is sufficient
for the initial operating float):

```text
POST /api/cron/reserve-refill
Authorization: Bearer <CRON_SECRET>
```

Responses:

- `200 healthy`: hot USDC is above the trigger.
- `202 refill_required`: custodians must execute the exact `amountUnits`.
- `503 insufficient_reserve`: no transaction is proposed; replenish or revise
  the policy through an approved configuration change.
- `500`: configuration or Horizon failed; inspect server logs and do not guess
  an amount.

The cron does not generate XDR. A refill XDR expires after 15 minutes, so an
unattended scheduler must not create competing stale envelopes.

## Prepare the exact refill

On an online operator host with public policy configuration and Horizon access:

```bash
npm run stellar:reserve:refill -- status
npm run stellar:reserve:refill -- prepare
```

`prepare` only succeeds for `refill_required`. Confirm the printed cold account,
hot account, exact USDC amount, hash, and explorer URL. Copy the
`STELLAR_RESERVE_REFILL_XDR=…` value through the approved secure channel. The
XDR contains no secret, but an unsubmitted signed XDR is approval material and
must not be committed or posted publicly.

## Collect two independent signatures

Custodian A runs, using secret-manager injection rather than a literal shell
history entry:

```bash
STELLAR_RESERVE_REFILL_XDR='<prepared XDR>' \
STELLAR_RESERVE_REFILL_AMOUNT_UNITS='<approved amountUnits>' \
STELLAR_COLD_SIGNER_SECRET='<one custodian seed from secure injection>' \
npm run stellar:reserve:refill -- sign
```

Custodian A passes only the resulting XDR to custodian B. Custodian B repeats
the same command with B's own seed and the partially signed XDR. A signer must
be one of master, ops, or policy, and the command refuses the same key twice.
No process invocation may contain two cold seeds.

The signing host needs no network access. Transfer `amountUnits` independently
from the XDR (for example, from the authenticated cron response) and compare it
to the approved request before setting `STELLAR_RESERVE_REFILL_AMOUNT_UNITS`.

Both custodians independently compare the printed source, destination, amount,
asset issuer, fee, expiry, and hash to the approved request before signing.

## Submit once

Return the twice-signed XDR to the online operator host:

```bash
STELLAR_RESERVE_REFILL_XDR='<twice-signed XDR>' \
npm run stellar:reserve:refill -- submit
```

Immediately before submission, the command reloads hot and cold balances and
requires that the current plan still matches the XDR's exact amount. It rejects
extra operations, operation-level source overrides, a different source,
destination, asset, issuer, amount, fee above 10,000 stroops, a future start,
an expiry more than 15 minutes away, missing/expired time bounds, unconfigured
signatures, duplicate identities, or fewer than two valid signatures.

The signed hash and explorer link print before Horizon is called. The command
submits once and never retries automatically.

## Unknown submission outcome

If the connection drops or Horizon times out after the hash prints:

1. Do not submit the XDR again.
2. Search the printed hash on Horizon or stellar.expert.
3. If it succeeded, verify both balance deltas and record the hash.
4. If it is absent after the transaction expires, run `status` and prepare a
   fresh transaction from the new on-chain sequence.
5. If status cannot be established, freeze refills and escalate. Never create a
   second approval based on an assumed failure.

Stellar sequence numbers prevent the same successful envelope from executing
twice, while the short time bound limits an unsubmitted approval's lifetime.

## Emergency stop and recovery

For a suspected hot compromise, wrong policy, or custodian incident:

1. Disable the external reserve-refill cron schedule.
2. Stop preparing and submitting refill XDRs.
3. Preserve the last printed hash and reconcile it on-chain.
4. Rotate affected cold signers with two known-good current custodians.
5. Move cold funds to a newly provisioned 2-of-3 account if two identities may
   be compromised.
6. Rotate the hot signing set separately and lower the configured target before
   resuming.
7. Re-enable the scheduler only after public keys, thresholds, balances, and
   configuration have been reviewed by two people.

For `insufficient_reserve`, do not lower the retain floor merely to make the
job green. Replenish cold funds or approve a policy change with an explicit
updated worst-case calculation.

## Public evidence record

Record only public facts after the live testnet proof:

```text
Network:
Cold account:
Cold ops public key:
Cold policy public key:
Thresholds and weights:
Trustline transaction hash:
Multisig setup transaction hash:
Refill transaction hash:
Hot USDC before -> after:
Cold USDC before -> after:
Trigger / target / retained floor:
stellar.expert account and transaction links:
```

Never record a seed, secret-manager reference, or signed XDR.
