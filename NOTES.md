# Souq — project notes

Short, focused handoff doc. For long-form setup see [README.md](./README.md).

## What this is

A **single-merchant marketplace template** powered by the Salla Partner API.
Each frontend deployment is branded for ONE merchant (via `NEXT_PUBLIC_STORE_ID`).
The backend is multi-tenant — one Express server can host many merchants'
storefronts simultaneously.

```
┌────────────────────────────────────────────────────────────────┐
│ souq-front (Vercel)                                            │
│   one deployment per merchant, branded with NEXT_PUBLIC_STORE_ID │
└──────────────────────┬─────────────────────────────────────────┘
                       │ /api/* (Vercel rewrite)
                       ▼
┌────────────────────────────────────────────────────────────────┐
│ souq backend (Railway, Express + Prisma + Postgres)            │
│  Routes:                                                        │
│    /install, /api/oauth/callback   — merchant OAuth             │
│    /api/auth/{signup,login,me,logout} — customer auth           │
│    /api/cart, /api/cart/items        — cart                     │
│    /api/checkout                     — order creation           │
│    /api/loyalty/points               — Salla loyalty read       │
│    /api/stores/:id/{products,sync}   — admin / catalog          │
│    /api/webhooks/salla               — Salla webhooks (stub)    │
└──────────────────────┬─────────────────────────────────────────┘
                       │ Bearer <merchant_token>
                       ▼
┌────────────────────────────────────────────────────────────────┐
│ Salla Admin API (api.salla.dev/admin/v2)                       │
└────────────────────────────────────────────────────────────────┘
```

## Verified end-to-end on production

- Signup → cart → checkout (COD) → order created in merchant's Salla dashboard
- Verified orders: `#262637956`, `#262633645`, `#262591046`

## Onboarding a new merchant — operator checklist

1. **Merchant installs the partner app**: send them
   `https://web-production-f300.up.railway.app/install`. They log in to their
   Salla store, approve scopes. Token lands in the `Store` table.
2. **Find the merchant's `store_id`**: visit `https://souq-front.vercel.app/admin`
   (or `GET /api/stores` on the backend). Copy it.
3. **Trigger initial product sync**: click **Sync** on the admin page, or
   `POST /api/stores/<store_id>/sync`. Products get cached locally.
4. **Spin up a branded frontend for this merchant**:
   - Fork / duplicate the Vercel project, OR add a new Vercel project pointing
     at the same `medcharaf111/souq-front` repo
   - Set `NEXT_PUBLIC_STORE_ID=<their_store_id>` on the new Vercel project
   - Set `NEXT_PUBLIC_API_URL=https://web-production-f300.up.railway.app`
   - Connect a custom domain if you have one
   - Deploy
5. **The merchant should also configure on their Salla dashboard**:
   - **Settings → Payments**: enable at least one payment method beyond COD
     (Mada, HyperPay, STC Pay, etc.) for the "Pay Online" option to work
   - **Apps**: optional — install Salla's **Customer Loyalty** app if they want
     point balances to show on the storefront's `/account` page
   - Turn OFF maintenance mode if it's on (otherwise customers landing on the
     Salla side post-payment see a maintenance banner)

## Required Salla scopes

Set on the partner app in salla.partners → App Scope. Merchant grants these on install.

| Scope | Purpose |
|---|---|
| `basic_info.read` | Implicit |
| `settings.read` | `/store/info` call after OAuth to learn store name + ID |
| `products.read` | Catalog sync |
| `categories.read` | (optional) for richer storefront browsing |
| `brands.read` | (optional) |
| `branches.read` | (optional) |
| `specialoffers.read` | (optional) |
| `customers.read_write` | Provision marketplace customers on the merchant store |
| `orders.read_write` | Create orders on checkout |
| `shippings.read` | Auto-pick a courier when building the order payload |
| `offline_access` | Refresh tokens (otherwise the access token dies after 14 days) |

## Required env vars

### Railway (`souq` backend)

```
SALLA_CLIENT_ID         from partner portal
SALLA_CLIENT_SECRET     from partner portal
SALLA_SCOPES            "offline_access products.read settings.read customers.read_write orders.read_write shippings.read"
BACKEND_URL             https://web-production-f300.up.railway.app
FRONTEND_URL            https://souq-front.vercel.app
JWT_SECRET              32+ random hex chars
DATABASE_URL            (referenced from Postgres plugin)
NODE_ENV                production
```

### Vercel (`souq-front` per merchant)

```
NEXT_PUBLIC_API_URL     https://web-production-f300.up.railway.app
NEXT_PUBLIC_STORE_ID    the merchant's Salla store ID (from /admin)
```

## Customer flow (current behaviour)

1. Customer visits the merchant's storefront → sees product grid (filtered to
   that merchant via `NEXT_PUBLIC_STORE_ID`)
2. Signs up with email + password (per-merchant — same email can sign up on
   different merchants as separate accounts)
3. Adds products to cart. The backend auto-picks the first in-stock variant
   value if a product has options (size, colour, etc.) — see
   [v1 gaps below](#known-v1-gaps).
4. Goes to `/checkout`. Fills name, phone (with +country code), full address
   (country, city, district/block, street, address line, postal, geo lat/lng),
   picks **Cash on delivery** or **Pay online**.
5. Backend:
   - Provisions a Salla customer on the merchant's store via
     `POST /admin/v2/customers` (idempotent via `Customer.sallaCustomerId`)
   - Auto-fetches the merchant's first active courier from
     `GET /admin/v2/shipping/companies/`
   - Builds the order payload with auto-filled variant options and the chosen
     `accepted_methods`
   - `POST /admin/v2/orders`
6. Frontend:
   - **COD**: lands on `/order/confirmed?order_id=...` (our page)
   - **Pay online**: redirects to Salla's hosted checkout URL — customer enters
     card on Salla's domain, comes back to the merchant's thank-you page

## Known v1 gaps

| # | Item | Workaround |
|---|---|---|
| 1 | **Cart UI has no variant picker** — auto-picks first in-stock option. Customer can't choose their size/colour. | OK for clothing demos where customer can return for wrong size; need to fix for real use. |
| 2 | **"Address incomplete" warning** in Salla dashboard. Salla wants more granular address (district hierarchy, region, etc.) than we collect. | Order still goes through; merchant can `Send update link to customer` via Salla. |
| 3 | **No webhook HMAC verification** in `api/webhooks/salla`. Anyone who knows the URL could forge events. | OK for dev; required before public launch. |
| 4 | **No admin auth on `/api/stores/*`**. Anyone who guesses the backend URL can list installed merchants and trigger syncs. | Same — required before public launch. |
| 5 | **RTL / Arabic styling** isn't dialled in. Layout works but isn't `dir="rtl"` by default. | Set on `<html>` and tune the CSS. |
| 6 | **Order webhooks not consumed**: when payment completes on Salla, we don't mark the order paid on our side. | OK for v1 since we don't track payment status server-side; needed if we want order history pages. |
| 7 | **Refresh token re-issue path** is in code but never tested against an expired token. | Watch for first 401 in 14 days. |

## Manual one-time things the operator has to do

These can't be automated and need a human + Salla portal access:

1. **Salla App Scope changes**: every time you add a scope, the merchant has
   to uninstall + reinstall to grant it.
2. **Webhook secret**: collect from the Webhooks tab on the partner app, store
   in Railway env var `SALLA_WEBHOOK_SECRET` before turning on HMAC check.
3. **Payment methods**: each merchant enables their own in their dashboard.
4. **Customer Loyalty app**: each merchant installs and configures it on their
   own store before `/account` shows real point balances.
5. **Maintenance mode**: must be OFF for customers to see Salla's post-payment
   confirmation page.

## Security follow-ups (do before going public)

- [ ] Rotate `SALLA_CLIENT_SECRET`, `JWT_SECRET`, Postgres password — all three
      appeared in the chat transcript while wiring things up
- [ ] Verify webhook HMAC signature in `src/routes/webhooks.ts`
- [ ] Add admin auth middleware on `/api/stores/*`
- [ ] Confirm CORS `origin` value on backend matches the production Vercel URL
      exactly (no trailing slash)
- [ ] Decide whether `allowBackup` style data (Customer table with hashed
      passwords) needs extra encryption at rest

## Salla docs referenced

- [Authorization (OAuth)](https://docs.salla.dev/421118m0)
- [List Products](https://docs.salla.dev/5394168e0)
- [Create Customer](https://docs.salla.dev/api-5394120)
- [Create Order](https://docs.salla.dev/api-5394145)
- [List Shipping Companies](https://docs.salla.dev/5394239e0)
- [Customer Loyalty Points](https://docs.salla.dev/12250577e0)

## Useful URLs

| | URL |
|---|---|
| Backend health | https://web-production-f300.up.railway.app/health |
| Backend stores list | https://web-production-f300.up.railway.app/api/stores |
| Frontend (demo merchant) | https://souq-front.vercel.app |
| Internal admin | https://souq-front.vercel.app/admin |
| Backend repo | https://github.com/medcharaf111/souq |
| Frontend repo | https://github.com/medcharaf111/souq-front |
| Salla Partners portal | https://salla.partners |
