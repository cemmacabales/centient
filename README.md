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
- Docker (for local PostgreSQL)

### Setup

```bash
git clone https://github.com/kimerran/t2p.git
cd t2p
npm install
npm run setup     # generates .env.local, starts Postgres, migrates + seeds
npm run dev
```

`npm run setup` produces a complete, bootable `.env.local` — every required key
is generated or filled (JWT secret, a throwaway hot-wallet key, platform fee,
cron secret) so no route 500s on a missing/placeholder value. It's **idempotent
and non-destructive**: re-running never overwrites a real secret you've already
set. Then it starts the `db` container, applies migrations, and seeds test data.

Once seeded, log in to test every area:

| Account | Email | Password | Access |
|---------|-------|----------|--------|
| Admin | `admin@centient.work` | `GoCent!123` | `SUPER_ADMIN` — full admin dashboard |
| Customer | `centient@centient.work` | `GoCent!123` | `CUSTOMER` — campaign owner views |

> Not using Docker for Postgres? Run `npm run setup:env` (env only), point
> `DATABASE_URL` at your own database, then `npm run db:deploy && npm run db:seed`.
>
> Seeing `P3005 — database schema is not empty`? Your local DB predates the
> migration history (created via `db push`). Rebuild it cleanly with
> `npm run db:reset` (destructive — drops local data, re-applies migrations + seed).

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run setup` | One-command dev setup: env + Postgres + migrate + seed |
| `npm run setup:env` | Generate/repair `.env.local` only (idempotent) |
| `npm run dev` | Start development server |
| `npm run build` | Generate Prisma client and build for production |
| `npm run start` | Start production server |
| `npm run db:migrate` | Run database migrations (dev) |
| `npm run db:deploy` | Deploy migrations (production) |
| `npm run db:seed` | Seed database with sample data |
| `npm run db:studio` | Open Prisma Studio |
| `npm run db:reset` | Reset database (warning: destructive) |

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