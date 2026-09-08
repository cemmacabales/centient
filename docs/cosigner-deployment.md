# Deploying the independent policy co-signer

> **Topology amended 2026-09-08.** The co-signer ships as a `cosigner` **service
> inside the existing `centient-work` project**, not as a separate project: the
> maintainer's account cannot create projects in that workspace. See the
> amendment in [ADR-0001](adr/0001-simulated-cosigner-isolation.md) for what that
> costs (the separate member list) and what it buys back (private networking).
>
> **`scripts/setup-cosigner.sh` walks the whole procedure interactively** and is
> the recommended way to run it — the Railway CLI needs a terminal, and every
> secret is read hidden and piped to `railway variable set --stdin` so it never
> reaches a process list or a shell history.

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
-- Allowed read. This transaction should complete normally.
BEGIN;
SET LOCAL ROLE centient_cosigner;
SELECT count(*) FROM public.submissions;
ROLLBACK;

-- The payout-job request path reads a different table. This must also succeed.
BEGIN;
SET LOCAL ROLE centient_cosigner;
SELECT count(*) FROM public.payout_jobs;
ROLLBACK;

-- Run each refusal probe as its own transaction. After PostgreSQL rejects a
-- statement, that transaction is aborted until ROLLBACK; combining the probes
-- would make every later one fail without proving its own permission boundary.
BEGIN;
SET LOCAL ROLE centient_cosigner;
UPDATE public.submissions
SET "payoutStatus" = "payoutStatus"
WHERE false;
-- must fail: permission denied for table submissions
ROLLBACK;

BEGIN;
SET LOCAL ROLE centient_cosigner;
DELETE FROM public.submissions WHERE false;
-- must fail: permission denied for table submissions
ROLLBACK;

BEGIN;
SET LOCAL ROLE centient_cosigner;
INSERT INTO public.payout_jobs ("id", "status", "createdAt", "updatedAt")
VALUES ('cosigner-permission-probe', 'queued', NOW(), NOW());
-- must fail: permission denied for table payout_jobs
ROLLBACK;

BEGIN;
SET LOCAL ROLE centient_cosigner;
UPDATE public.payout_jobs SET "status" = 'queued' WHERE false;
-- must fail: permission denied for table payout_jobs
ROLLBACK;

BEGIN;
SET LOCAL ROLE centient_cosigner;
SELECT count(*) FROM public.users;
-- must fail: permission denied for table users
ROLLBACK;
```

`"payoutStatus"` is the real mapped column name, and `queued` is a valid
`PayoutJobStatus` value. Those details matter: a nonexistent column or invalid
enum value would fail before PostgreSQL checked the role's permissions and would
certify nothing. If either allowed read fails, any write succeeds, or the
`users` read succeeds, stop — the grant is wrong and the isolation is cosmetic.
The transactions make every probe safe even if a grant is accidentally too
broad.

Build `COSIGNER_DATABASE_URL` from the Postgres service's **public** connection
details (`DATABASE_PUBLIC_URL`, or the host and port on its Connect tab), with
your new user and password substituted in.

**Use the internal host: `postgres.railway.internal`.** Railway's private
networking carries service-to-service traffic within a project, and under the
amended topology the co-signer shares `centient-work` with the database. The
read-only credential therefore never leaves Railway's network.

(Had the co-signer stayed in its own project, this would have had to use the
public host with `?sslmode=require`. That hop is what the amendment buys back.)

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
2. Configure the service. Every setting below can be set from the dashboard
   (**Settings** → Deploy / Build), but the CLI form is reproducible and is what
   this runbook uses. Link the CLI to the new project first
   (`railway link --project centient-cosigner`), then:

   ```bash
   railway environment edit --service-config cosigner deploy.startCommand "npm run cosign"
   railway environment edit --service-config cosigner deploy.healthcheckPath "/health"
   railway environment edit --service-config cosigner deploy.restartPolicyType "ON_FAILURE"
   # Explicitly empty. The repo-root railway.json runs `prisma migrate deploy`
   # before every deploy, which the co-signer must never do: it holds a read-only
   # credential and no DATABASE_URL, so the deploy fails — and "fixing" that by
   # adding DATABASE_URL would hand this service the application's read-write
   # connection and dissolve the separation it exists to provide.
   railway environment edit --service-config cosigner deploy.preDeployCommand ""
   # The co-signer shares lib/ with the application, so watching only its own
   # directory would leave it running stale decision logic.
   railway environment edit --service-config cosigner build.watchPatterns \
     '["services/cosigner/**","lib/stellar/**","prisma/**","package.json"]'
   ```

   **Do not add a `railway.json` for this service.** Railway deprecated Config as
   Code on 2026-09-08: existing files are read until 2026-12-01, but **new
   services cannot opt into it**, so a config file committed here would simply
   never be read. Its successor is Infrastructure as Code
   (`.railway/railway.ts`, applied with `railway config plan` /
   `railway config apply`), which suits this project well later precisely
   because it contains exactly one service. Before reaching for it, note that
   apply is **omit-means-delete** and the authoring file must describe the whole
   environment — pointing a partial file at the main `centient` project would
   propose deleting everything it does not mention.

3. **Variables** — these belong here and in no other project:

   | Variable | Value |
   | --- | --- |
   | `STELLAR_POLICY_SIGNER_SECRET` | the policy seed (`S…`) |
   | `COSIGNER_SHARED_SECRET` | the `openssl rand -hex 32` output |
   | `COSIGNER_DATABASE_URL` | `postgresql://centient_cosigner:…@PUBLIC_HOST:PORT/railway?sslmode=require` |
   | `COSIGNER_DAILY_CAP_UNITS` | e.g. `1000000000` (100 USDC) — set it independently of the app's cap and at or below the hot-float target; see the [daily-cap runbook](stellar-daily-payout-cap-runbook.md) |
   | `COSIGNER_ISOLATION_LEVEL` | `same-workspace` |
   | `STELLAR_NETWORK` | `testnet` |
   | `STELLAR_USDC_ISSUER` | the same issuer the app pays in |
   | `PORT` | Railway sets this; the service reads it |

4. **Settings → Networking → Generate Domain.** Note the URL.
5. Deploy, then confirm: `curl https://<domain>/health` returns
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
| Deploy fails in a pre-deploy step running `prisma migrate deploy` | The service picked up the repo-root `railway.json`. Clear the Pre-Deploy Command in the service's Settings. Do not add `DATABASE_URL` to make it pass. |
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
