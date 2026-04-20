# Centient — Features

Running log of shipped features and scaffolding milestones.

## Scaffolding

- **Project scaffold (issue #13):** Next.js 16 App Router project with React 19.2, TypeScript 5.4, Tailwind 4, Prisma 7, and viem 2.x. Established the directory layout (`app/`, `lib/`, `components/`, `types/`, `prisma/`) with placeholder modules, `next.config.ts` set to `output: "standalone"` for Railway, `.env.local.example` template, and `.gitignore` excluding `node_modules/`, `.env.local`, `app/generated/`, and `.next/`.
- **Prisma 7 data model (issue #14):** `User`, `Task`, and `Submission` models in `prisma/schema.prisma` backed by PostgreSQL via `@prisma/adapter-pg`. Wallet-keyed users, UUID tasks with gold-task flags, and submissions keyed by `(walletAddress, taskId)` with payout tracking. Singleton client in `lib/prisma.ts` reuses the same instance across Next.js hot reloads. Initial migration (`init`) creates `users`, `tasks`, `submissions` plus supporting indexes.

## Data

- **Task seed (issue #16):** `prisma/seed.ts` idempotently upserts 100 task pairs — 90 regular (15 general, 15 coding, 10 writing, 15 math, 15 explanation, 10 creative, 10 advice) and 10 gold (4 factually wrong, 2 empty, 2 inappropriate refusal, 2 nonsense) with deterministic string IDs and a 5-A/5-B gold answer balance. Uses `@prisma/adapter-pg`. Runs via `npm run db:seed`; re-runs are safe thanks to `upsert` keyed on `id`.

## Core flows

_Nothing shipped yet._
