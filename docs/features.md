# Centient — Features

Running log of shipped features and scaffolding milestones.

## Scaffolding

- **Project scaffold (issue #13):** Next.js 16 App Router project with React 19.2, TypeScript 5.4, Tailwind 4, Prisma 7, and viem 2.x. Established the directory layout (`app/`, `lib/`, `components/`, `types/`, `prisma/`) with placeholder modules, `next.config.ts` set to `output: "standalone"` for Railway, `.env.local.example` template, and `.gitignore` excluding `node_modules/`, `.env.local`, `app/generated/`, and `.next/`.
- **Local Postgres via Docker (issue #24):** `docker-compose.yml` defines a `postgres:15-alpine` service on port 5432 with credentials matching `.env.local.example`, a named `centient_pgdata` volume for persistence across restarts, and a `pg_isready` healthcheck. One-command local setup: `docker compose up -d`.

## Core flows

_Nothing shipped yet._
