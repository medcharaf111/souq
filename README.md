# souq

Backend for the Salla multi-vendor marketplace. Express + Prisma + Postgres, talks to Salla via Partner OAuth.

## What it does

- Drives the OAuth install flow (`GET /install` → Salla → `GET /api/oauth/callback`)
- Stores per-merchant access + refresh tokens (Prisma, SQLite by default)
- Auto-refreshes tokens near expiry and on 401
- Syncs each merchant's product catalog into a local DB (`POST /api/stores/:id/sync`)
- Serves the cached catalog as JSON for the frontend (`GET /api/stores/:id/products`)
- Receives Salla webhooks for Easy-Mode auth and uninstall cleanup

## Setup

```bash
cp .env.example .env   # fill SALLA_CLIENT_ID, SALLA_CLIENT_SECRET, BACKEND_URL, FRONTEND_URL
npm install
npx prisma migrate dev --name init
npm run dev
```

Backend listens on `PORT` (default 3000). For local dev, expose with `ngrok http 3000` and set `BACKEND_URL` to the tunneled URL. The Callback URL in the Salla Partners portal must equal `BACKEND_URL + /api/oauth/callback`.

## Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `GET` | `/install` | Sets state cookie, redirects merchant to Salla auth |
| `GET` | `/api/oauth/callback` | Exchanges code for tokens, persists store, redirects to frontend |
| `GET` | `/api/stores` | List installed stores + product counts |
| `POST` | `/api/stores/:storeId/sync` | Pull catalog from Salla into local cache |
| `GET` | `/api/stores/:storeId/products` | Cached products (`?live=1` to passthrough to Salla) |
| `POST` | `/api/webhooks/salla` | Receives `app.store.authorize` / `app.uninstalled` |

## Production notes

- **Webhook signature verification is a TODO** in `src/routes/webhooks.ts`. Verify the HMAC header against your webhook secret before trusting any body fields.
- **API routes are unauthenticated.** Anyone who reaches the backend can list stores and trigger syncs. Before going live, add an admin token middleware on `/api/stores/*` and a frontend-only header / session for the customer routes.
- **Postgres on Railway**: add the Postgres plugin to your project; Railway auto-injects `DATABASE_URL` into the souq service. For local dev, run any Postgres (e.g. `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16`) and point `DATABASE_URL` at it.

## Companion frontend

The customer-facing UI lives in [souq-front](https://github.com/medcharaf111/souq-front). Run both side by side — the frontend's `NEXT_PUBLIC_API_URL` should point at this backend's `BACKEND_URL`.
