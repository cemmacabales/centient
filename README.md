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

1. **Clone the repository**

   ```bash
   git clone https://github.com/kimerran/t2p.git
   cd t2p
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Start PostgreSQL**

   ```bash
   docker compose up -d
   ```

4. **Configure environment**

   ```bash
   cp .env.local.example .env.local
   ```

5. **Run database migrations**

   ```bash
   npm run db:migrate
   ```

6. **Start development server**

   ```bash
   npm run dev
   ```

## Available Scripts

| Command | Description |
|---------|-------------|
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