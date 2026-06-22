# Centient

[![CI](https://github.com/kimerran/t2p/actions/workflows/ci.yml/badge.svg)](https://github.com/kimerran/t2p/actions/workflows/ci.yml)

A data labeling platform built on Celo MiniPay, rewarding contributors with cUSD for completing tasks.

## Tech Stack

- **Framework:** Next.js 16 (App Router) + React 19
- **Language:** TypeScript 5.4
- **Styling:** Tailwind CSS 4
- **Database:** PostgreSQL with Prisma 7
- **Blockchain:** Celo via viem 2.x

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm (`npm i -g pnpm`)
- Docker (for local PostgreSQL)

### Setup

```bash
git clone https://github.com/kimerran/t2p.git
cd t2p
pnpm install
pnpm setup     # generates .env.local, starts Postgres, migrates + seeds
pnpm dev
```

`pnpm setup` produces a complete, bootable `.env.local` — every required key
is generated or filled (JWT secret, a throwaway hot-wallet key, platform fee,
cron secret) so no route 500s on a missing/placeholder value. It's **idempotent
and non-destructive**: re-running never overwrites a real secret you've already
set. Then it starts the `db` container, applies migrations, and seeds test data.

Once seeded, log in to test every area:

| Account | Email | Password | Access |
|---------|-------|----------|--------|
| Admin | `admin@centient.work` | `GoCent!123` | `SUPER_ADMIN` — full admin dashboard |
| Customer | `centient@centient.work` | `GoCent!123` | `CUSTOMER` — campaign owner views |

> Not using Docker for Postgres? Run `pnpm setup:env` (env only), point
> `DATABASE_URL` at your own database, then `pnpm db:deploy && pnpm db:seed`.
>
> Seeing `P3005 — database schema is not empty`? Your local DB predates the
> migration history (created via `db push`). Rebuild it cleanly with
> `pnpm db:reset` (destructive — drops local data, re-applies migrations + seed).

## Available Scripts

| Command | Description |
|---------|-------------|
| `pnpm setup` | One-command dev setup: env + Postgres + migrate + seed |
| `pnpm setup:env` | Generate/repair `.env.local` only (idempotent) |
| `pnpm dev` | Start development server |
| `pnpm build` | Generate Prisma client and build for production |
| `pnpm start` | Start production server |
| `pnpm db:migrate` | Run database migrations (dev) |
| `pnpm db:deploy` | Deploy migrations (production) |
| `pnpm db:seed` | Seed database with sample data |
| `pnpm db:studio` | Open Prisma Studio |
| `pnpm db:reset` | Reset database (warning: destructive) |

## Project Structure

```
├── app/              # Next.js App Router pages
├── components/       # React components
├── lib/              # Shared utilities (constants, payout, quality)
├── prisma/           # Schema, migrations, seed scripts
├── types/            # TypeScript type definitions
└── docs/             # Feature documentation
```

## License

MIT