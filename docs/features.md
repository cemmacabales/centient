# Centient — Features

Running log of shipped features and scaffolding milestones.

## Scaffolding

- **Project scaffold (issue #13):** Next.js 16 App Router project with React 19.2, TypeScript 5.4, Tailwind 4, Prisma 7, and viem 2.x. Established the directory layout (`app/`, `lib/`, `components/`, `types/`, `prisma/`) with placeholder modules, `next.config.ts` set to `output: "standalone"` for Railway, `.env.local.example` template, and `.gitignore` excluding `node_modules/`, `.env.local`, `app/generated/`, and `.next/`.
- **Prisma 7 data model (issue #14):** `User`, `Task`, and `Submission` models in `prisma/schema.prisma` backed by PostgreSQL via `@prisma/adapter-pg`. Wallet-keyed users, UUID tasks with gold-task flags, and submissions keyed by `(walletAddress, taskId)` with payout tracking. Singleton client in `lib/prisma.ts` reuses the same instance across Next.js hot reloads. Initial migration (`init`) creates `users`, `tasks`, `submissions` plus supporting indexes.

## Core flows

_Nothing shipped yet._
