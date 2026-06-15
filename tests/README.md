# Tests

Integration and unit tests for the `/api/submit` route and supporting libraries.

## Running locally

```bash
# 1. Start a test Postgres + apply migrations
npm run db:test:up

# 2. Run the suite
npm test

# Or with coverage
npm run test:coverage

# Stop the test DB
npm run db:test:down
```

`db:test:up` starts a `postgres:15-alpine` container on port **5433** (so it does not collide with the dev DB on 5432) and applies all Prisma migrations.

If you'd rather point at your own Postgres, set one of these env vars before running `npm test`:

- `TEST_DATABASE_URL` — preferred
- `DATABASE_URL` — fallback; also used by the app code under test

## Structure

```
app/api/submit/__tests__/route.test.ts   # 22 integration tests for /api/submit
components/__tests__/                     # 24 unit tests for lib/* helpers
tests/helpers/
  db.ts                                   # Prisma client + truncateAll()
  factories.ts                            # createUser, createTask, createGoldTask, seedSubmissions
```

## What's mocked

- `@/lib/payout` — `payReward` is stubbed with `vi.fn()` so no real RPC hits the chain. `rewardInWei()` runs for real.
- `@/lib/quality` — `isRateLimited` is stubbed by default to `false`; the rate-limit test sets it to `true` on the second call.

## What's real

- A real PostgreSQL (Docker `centient-test-pg` or any reachable instance).
- The route handler, Prisma client, and Prisma migrations.
- All validation, gold-task logic, left-bias detection, and the payout DB writes.

## CI

`.github/workflows/ci.yml` spins up a `postgres:15-alpine` service container, runs `prisma migrate deploy`, then `npm test` and `npm run test:coverage`. Coverage HTML + lcov are uploaded as the `coverage-report` artifact.
