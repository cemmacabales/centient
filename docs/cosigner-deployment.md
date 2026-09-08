# Deploying the independent policy co-signer

The runbook for issue #8 under the topology decided in
[ADR-0001](adr/0001-simulated-cosigner-isolation.md): the co-signer runs in its
own Railway **project**, inside the same workspace as the application, for the
MVP on testnet.

Read the ADR first if you have not. The short version: this buys a separate
container, variable scope, deploy trigger, member list, and database credential.
It does not buy a separate account or control plane, and `same-workspace` is
refused on the public network for exactly that reason.

## What you are building

```
Railway workspace
├── Project: centient            ← already exists
│   └── web            COSIGNER_URL, COSIGNER_SHARED_SECRET
│                      (must NOT hold STELLAR_POLICY_SIGNER_SECRET)
└── Project: centient-cosigner   ← new
    └── cosigner       STELLAR_POLICY_SIGNER_SECRET, COSIGNER_DATABASE_URL
                       COSIGNER_DAILY_CAP_UNITS
```

The two projects talk over HTTPS. The co-signer reads the same Postgres instance
as the app, through a role that can only `SELECT`.

## 1. Create the read-only database role

Run this against the **production** database, as a superuser, before deploying
anything. The credential is the real boundary in this topology, so it is worth
getting exactly right.

```sql
CREATE ROLE centient_cosigner LOGIN PASSWORD 'replace-with-a-generated-password';

-- Read, and only read, the two tables the policy decision consults. `users` is
-- deliberately not granted: the co-signer reads the destination from the
-- submission and the payout job, never from the user record, so the grant would
-- widen what a leaked co-signer credential discloses for nothing in return.
GRANT CONNECT ON DATABASE railway TO centient_cosigner;
GRANT USAGE ON SCHEMA public TO centient_cosigner;
GRANT SELECT ON public.submissions, public.payout_jobs TO centient_cosigner;

-- Future tables must not be readable by default; grant them deliberately.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM centient_cosigner;
```

Verify the boundary is real rather than assumed:

```sql
SET ROLE centient_cosigner;
SELECT count(*) FROM public.submissions;          -- succeeds
UPDATE public.submissions SET payout_status = 'x'; -- must fail: permission denied
RESET ROLE;
```

If the `UPDATE` succeeds, stop — the grant is wrong and the isolation is
cosmetic.

Build `COSIGNER_DATABASE_URL` from the Postgres service's **public** connection
details (`DATABASE_PUBLIC_URL`, or the host and port on its Connect tab), with
your new user and password substituted in.

**It must be the public host, not `postgres.railway.internal`.** Railway's
private networking is scoped to a single project, and the co-signer lives in a
different project by design. The internal hostname does not resolve from there,
and the failure presents as a hung connection rather than a clear error.

## 2. Generate the keys and secrets

The policy keypair may already exist from the #5 multisig setup
(`STELLAR_POLICY_SIGNER_PUBLIC` on the payout account). If so, use that keypair —
generating a new one means re-running the multisig setup. Otherwise:

```bash
pnpm stellar:multisig:setup
```

The shared HMAC secret is new, and is not a Stellar key:

```bash
openssl rand -hex 32
```

## 3. Create the co-signer's Railway project

1. In the Railway dashboard, **New Project** → **Deploy from GitHub repo** →
   pick `webnxt-2030/Centient`. Name the project `centient-cosigner`.
2. Open the created service → **Settings** → **Config as Code**, and set the
   config path to `services/cosigner/railway.json`.

   This is not cosmetic. The repo-root `railway.json` runs
   `npx prisma migrate deploy` before every deploy, which the co-signer must
   never do: it holds a read-only credential and has no `DATABASE_URL` at all,
   so the deploy would fail — and "fixing" that by adding `DATABASE_URL` would
   hand this service the application's read-write connection and dissolve the
   separation it exists to provide. Its own config carries no migration step.

   The co-signer's config already sets the start command (`npm run cosign`) and
   the health check path (`/health`).

3. Still in **Settings**, set **Watch Paths**: `services/cosigner/**`,
   `lib/stellar/**`, `prisma/**`, `package.json`. The co-signer shares `lib/`
   with the application, so scoping it to its own directory alone would leave it
   running stale decision logic after a change to the checks it depends on.
4. **Variables** — these belong here and in no other project:

   | Variable | Value |
   | --- | --- |
   | `STELLAR_POLICY_SIGNER_SECRET` | the policy seed (`S…`) |
   | `COSIGNER_SHARED_SECRET` | the `openssl rand -hex 32` output |
   | `COSIGNER_DATABASE_URL` | `postgresql://centient_cosigner:…@…` (the read-only role) |
   | `COSIGNER_DAILY_CAP_UNITS` | e.g. `200000000000` (200 USDC) — set it independently of the app's cap |
   | `COSIGNER_ISOLATION_LEVEL` | `same-workspace` |
   | `STELLAR_NETWORK` | `testnet` |
   | `STELLAR_USDC_ISSUER` | the same issuer the app pays in |
   | `PORT` | Railway sets this; the service reads it |

5. **Settings → Networking → Generate Domain.** Note the URL.
6. Deploy, then confirm: `curl https://<domain>/health` returns
   `{"status":"ok","isolation":"same-workspace"}`.

## 4. Point the application at it, and take the key away

In the **existing** `centient` project's service variables:

- add `COSIGNER_URL=https://<cosigner-domain>/cosign`
- add `COSIGNER_SHARED_SECRET` — the same value as the co-signer's
- add `COSIGNER_ISOLATION_LEVEL=same-workspace`
- **delete `STELLAR_POLICY_SIGNER_SECRET`** and `STELLAR_ALLOW_LOCAL_COSIGNER`

The deletion is not tidying. The app refuses to start while it can see both
`COSIGNER_URL` and the policy secret, because a process able to produce both
signatures is not a 2-of-3. If the deploy crash-loops with that message, the
variable is still set.

Keep `STELLAR_POLICY_SIGNER_PUBLIC` — the app needs the public key to verify the
signature it gets back.

## 5. Prove the boundary

```bash
# Health, and the topology it believes it is running under.
curl -s https://<cosigner-domain>/health

# An unauthenticated signing request is refused before any database work.
curl -s -X POST https://<cosigner-domain>/cosign \
  -H 'content-type: application/json' -d '{}'
# => 401, "request must carry x-centient-signature, …"
```

Then run one testnet payout end to end and confirm the settled transaction
carries two distinct signatures (`assertPayoutFullySigned` enforces this before
submission, and the #12 suite regression-guards it).

## What breaks, and what it means

| Symptom | Cause |
| --- | --- |
| App crash-loops: "configured with both COSIGNER_URL and STELLAR_POLICY_SIGNER_SECRET" | The policy seed is still in the app project. Delete it there. |
| Every payout refused 401 | `COSIGNER_SHARED_SECRET` differs between the two projects. |
| Every payout refused 409 "no ledger row" | `COSIGNER_DATABASE_URL` points at the wrong database. |
| Co-signer hangs or times out reaching Postgres | `COSIGNER_DATABASE_URL` uses `postgres.railway.internal`. Private networking is per-project; use the public host. |
| Refused 409 "already carries broadcast hash" | Working as intended — that payout settled already. Do not retry it; reconcile. |
| Refused 503 "same-workspace is never permitted on the public network" | `STELLAR_NETWORK=public` under the MVP topology. This is the mainnet gate; see the ADR's exit criteria. |
| Co-signer exits at boot | A required variable is missing. There are no fallbacks by design; the log names the one. |
| Deploy fails in a pre-deploy step running `prisma migrate deploy` | The service is using the repo-root `railway.json`. Point Config as Code at `services/cosigner/railway.json`. Do not add `DATABASE_URL` to make it pass. |
| Payout fails "co-signature is not the configured co-signer" | `STELLAR_POLICY_SIGNER_PUBLIC` in the app does not match the seed the co-signer holds. |

## Operating notes

- **One replica.** Two pieces of state are in-process: the replay-nonce store,
  and the record of what this service has signed but not yet seen broadcast
  (which is what stops two simultaneous requests both spending the last of the
  daily cap). A second instance would silently stop guarding both.

  The general fix — durable reservations in the database — is deliberately not
  taken: writing them would mean granting the co-signer write access, and the
  read-only credential is the one boundary this topology actually enforces.
  Scaling past one replica means shared storage that is not this database, or
  the separate-account topology in the ADR's exit criteria. Until then this is
  the same single-writer constraint the payout submitter already carries, and
  the payout service holds the primary cap regardless.
- **Rotating the shared secret** is a two-project change with a window where they
  disagree; payouts fail closed (401) during it rather than proceeding unsigned.
- **Rotating the policy key** means re-running the #5 multisig setup to update
  the payout account's signer set. It is not a variable change alone.
- The co-signer needs no database of its own, no persistent disk, and no
  scheduler. It is a request-response service on a low-traffic path.
