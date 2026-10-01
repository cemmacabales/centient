# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Labelers: people, often first-time crypto users in emerging markets (the pilot is the Philippines), who want to earn small, real dollar payments from a phone or laptop. They sign in by connecting the Freighter wallet (browser extension, or the mobile app over WalletConnect), then work through comparison tasks one at a time.

Secondary, not addressed by the landing page: AI labs and customers who fund campaigns through the admin console, and operators who run it.

## Product Purpose

Centient pays people in USDC on Stellar to teach AI what "better" looks like. A task shows a prompt someone asked an AI and two responses; the labeler picks the better one and writes a short reason. Each accepted answer is paid on-chain, straight to the labeler's wallet. Success is a labeler who connects a wallet, completes tasks, and sees each payment arrive.

## Positioning

Per-answer on-chain payment: every accepted answer is its own USDC payment on Stellar, sent through a 2-of-3 multisig payout and verifiable on the public ledger. There is no balance to withdraw and no speculative token. The wallet is the account: no email or password.

## Operating Context

- Entry is wallet-first: the landing page is also the sign-in screen. Connecting Freighter and signing a one-time challenge creates or opens the account. Email sign-in exists only for accounts created before wallet sign-in.
- Everything currently runs on Stellar testnet (decision D-7). Test USDC has no cash value.
- Quality guards run behind the loop: hidden gold tasks that pay nothing, rate limits, reason-spam checks, left-bias guards. Failing too many gold tasks pauses the account.

## Capabilities and Constraints

- Reward per task is env-driven (default 0.05 USDC) and shown on each task before answering.
- Payout statuses a labeler can see: pending, sent, confirmed.
- Single Next.js 16 app (App Router, React 19, Tailwind 4). Strict CSP: scripts from self only, images from self/data/blob, connect-src limited to self, Sentry and WalletConnect, frames limited to WalletConnect verify and youtube-nocookie.
- Landing footer shows the deployed build SHA linked to its commit (#48).

## Brand Commitments

- Name "Centient" (capital C only), tagline "Train AI, cent by cent.", domain centient.work, contact centient@artisam.xyz.
- brand.md is the visual and voice source of truth: deep green primary (#006d3d) with a green action gradient, warm gold secondary reserved for money, Manrope for headlines and amounts, Inter for body and labels, Material Symbols Outlined icons.
- The owl mascot (public/mascot, five poses) and the logo are confirmed brand assets.
- Voice: clear not clever, verbs first on buttons, confident not hypey, no crypto or AI jargon by default, no emoji in UI copy.
- User direction (2026-10-01): the landing revamp keeps this brand and rebuilds the page's layout, type scale, composition and motion.

## Evidence on Hand

- Promo video on YouTube (id uxjxu33TOuM), embedded via youtube-nocookie.
- Public docs at https://centient.gitbook.io/centient-docs/.
- Real on-chain payouts on Stellar testnet, readable from Horizon.
- No testimonials, customer logos, usage metrics or press. Do not invent them.

## Product Principles

- Show the payment, don't promise it: every claim about pay should point at something a visitor can see or verify.
- The task is simple on purpose: one prompt, two responses, one reason.
- The wallet is the account: never ask for more than a wallet signature to start.
- Be plain about testnet: never imply test USDC is spendable money.

## Accessibility & Inclusion

Mobile-first audience on mid-range phones and variable connections: tap targets of at least 48px, AA contrast, reduced motion honored, and nothing essential behind hover.
