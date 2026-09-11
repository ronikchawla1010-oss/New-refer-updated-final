# Free Coupon Hub

Telegram-native referral coupon bot with persistent Postgres inventory, milestone rewards, atomic claims, and an in-chat admin panel.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the Telegram bot and health endpoint
- `pnpm --filter @workspace/api-server run typecheck` — typecheck the bot
- `pnpm --filter @workspace/api-server run build` — bundle the Railway/production entrypoint
- `pnpm run typecheck` — full workspace typecheck

Required environment:

- `BOT_TOKEN` — BotFather token stored as a secret
- `DATABASE_URL` — PostgreSQL connection string
- `OWNER_ID` — numeric Telegram user ID for the protected owner account

Railway should run `pnpm --filter @workspace/api-server run dev` for development or build with `pnpm --filter @workspace/api-server run build` and start with `node --enable-source-maps artifacts/api-server/dist/index.mjs`. Run one replica for Telegram long polling; the database advisory lock also refuses a second polling instance.

## Stack

- Node.js 24, TypeScript, pnpm workspace
- Telegram Bot API long polling
- PostgreSQL through the `pg` driver
- esbuild bundle

## Where things live

- `artifacts/api-server/src/bot.ts` — Telegram handlers, onboarding, user menus, claims, admin conversations, broadcasts
- `artifacts/api-server/src/db.ts` — schema bootstrap, queries, transactions, advisory-lock helpers
- `artifacts/api-server/src/index.ts` — startup, health endpoint, graceful shutdown

## Architecture decisions

- The bot intentionally has exactly three source files to keep Railway deployment compact.
- Coupon reservation uses a Postgres transaction with row locking and `SKIP LOCKED`, then returns stock on failed Telegram delivery.
- Referral validity is finalized only after completed onboarding; the database owns uniqueness and milestone unlocks.
- Telegram message keyboards use the screenshot's two-column/full-width layout and emoji labels. Buttons are styled through Telegram's `style` field: `primary` (blue), `success` (green), and `danger` (red). Clients that do not support this newer field fall back to their default button style.
- The health endpoint exists only for Replit/Railway process health checks; there is no website or browser admin panel.

## Product

Users join required channels, accept the disclaimer, share a personal referral link, earn points from valid completed referrals, unlock milestones, and claim one-time coupon codes. Admins manage the full product from Telegram using `/admin`.

## Gotchas

- Do not start a second long-polling replica; it will be rejected by the Postgres advisory lock.
- Keep `DATABASE_URL`, `BOT_TOKEN`, and production `OWNER_ID` configured in the deployment environment.
- The first running instance initializes all tables and default settings automatically.