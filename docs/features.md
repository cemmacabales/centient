# Centient — Features

Running log of shipped features and scaffolding milestones.

## Scaffolding

- **Project scaffold (issue #13):** Next.js 16 App Router project with React 19.2, TypeScript 5.4, Tailwind 4, Prisma 7, and viem 2.x. Established the directory layout (`app/`, `lib/`, `components/`, `types/`, `prisma/`) with placeholder modules, `next.config.ts` set to `output: "standalone"` for Railway, `.env.local.example` template, and `.gitignore` excluding `node_modules/`, `.env.local`, `app/generated/`, and `.next/`.
- **Local Postgres via Docker (issue #24):** `docker-compose.yml` defines a `postgres:15-alpine` service on port 5432 with credentials matching `.env.local.example`, a named `centient_pgdata` volume for persistence across restarts, and a `pg_isready` healthcheck. One-command local setup: `docker compose up -d`.

## Libraries

- **Shared utilities (issue #15):** `lib/constants.ts` (Celo chain config + cUSD/USDC addresses + `REWARD_CUSD`), `lib/minipay.ts` (client-only `isMiniPay` + `getWalletAddress` via `eth_requestAccounts`), `lib/payout.ts` (server-side `payCUSD`, `waitForTx`, `rewardInWei` via viem + `privateKeyToAccount`), `lib/quality.ts` (15s in-memory rate limiter + reason-spam validator), `types/index.ts` (`PayoutStatus`, `Choice`, `TaskResponse`, `SubmitRequest`, `SubmitResponse`, `MeResponse`). Bumped `tsconfig.json` target to `ES2020` to allow the `100_000n` BigInt literal in `payout.ts`.

## Core flows

_Nothing shipped yet._
