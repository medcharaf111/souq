# Souq — handoff document

For the next Claude Code session. This is the complete state of the project as
of commit-level snapshot; read top to bottom before doing any work.

---

## TL;DR

A Salla-powered single-merchant-per-deployment marketplace template. Live and
working end-to-end. A real customer can sign up, browse, add a product (with
variant selected), checkout (COD), and the order lands in the merchant's Salla
dashboard. Multiple real orders have been placed against the demo store.

Stack:
- **Backend** (`souq`): Express 4 + TypeScript + Prisma + Postgres → Railway
- **Frontend** (`souq-front`): Next.js 15 App Router + TypeScript → Vercel
- **Cookie-based customer auth**: JWT in httpOnly cookie; frontend talks to
  backend via a Next.js rewrite (`/api/*` → backend) so the cookie domain
  matches and works cross-origin transparently.

---

## Live URLs

| What | URL |
|---|---|
| Storefront (demo merchant) | https://souq-front.vercel.app |
| Internal admin | https://souq-front.vercel.app/admin |
| Backend (Express) | https://web-production-f300.up.railway.app |
| Backend health | https://web-production-f300.up.railway.app/health |
| Backend repo | https://github.com/medcharaf111/souq |
| Frontend repo | https://github.com/medcharaf111/souq-front |
| Salla Partners portal | https://salla.partners |

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  souq-front (Vercel, Next.js 15 App Router)             │
│                                                          │
│  Per-merchant deployments. Each Vercel project has its  │
│  own NEXT_PUBLIC_STORE_ID env var → the whole storefront │
│  is scoped to that one merchant's catalog.              │
│                                                          │
│  next.config.ts rewrite: /api/* → backend transparently │
│  so customer session cookie lives on the frontend       │
│  origin (souq-front.vercel.app) and is sent on every    │
│  fetch.                                                  │
└──────────────────────┬───────────────────────────────────┘
                       │ /api/* (rewrite)
                       ▼
┌──────────────────────────────────────────────────────────┐
│  souq backend (Railway, Express + Prisma + Postgres)    │
│                                                          │
│  Routes:                                                 │
│    GET  /health                                          │
│    GET  /install                                         │
│    GET  /api/oauth/callback                              │
│    POST /api/webhooks/salla        (HMAC verify is TODO) │
│    POST /api/auth/signup           (per-store)           │
│    POST /api/auth/login                                   │
│    GET  /api/auth/me                                      │
│    POST /api/auth/logout                                  │
│    GET  /api/stores                                       │
│    POST /api/stores/:id/sync                              │
│    GET  /api/stores/:id/products                          │
│    GET  /api/stores/:id/products/:pid                     │
│    GET  /api/cart, POST /items, PATCH /items/:id, DEL    │
│    POST /api/checkout                                     │
│    GET  /api/loyalty/points                               │
└──────────────────────┬───────────────────────────────────┘
                       │ Bearer <merchant_token>
                       ▼
┌──────────────────────────────────────────────────────────┐
│  Salla Admin API (api.salla.dev/admin/v2)                │
│                                                          │
│  Endpoints we hit:                                       │
│    GET  /store/info             (after install)          │
│    GET  /products               (sync — paginated)       │
│    POST /customers              (provision customer)     │
│    GET  /shipping/companies/    (auto-pick courier)      │
│    GET  /payment/methods?status=enabled                  │
│    POST /orders                 (checkout)               │
│    GET  /customers/loyalty/points (loyalty balance)      │
└──────────────────────────────────────────────────────────┘
```

Two distinct identities to keep straight:

| Identity | Lives where | When created | Survives logout? |
|---|---|---|---|
| **Merchant** | Salla side | When they install the partner app | Until merchant uninstalls |
| **Customer** | Our DB + provisioned on Salla on first checkout | At signup | Cookie cleared on logout; DB row stays; Salla customer record stays |

---

## Data model

```prisma
model Store {
  storeId      String    @id           // Salla store ID
  storeName    String?
  accessToken  String
  refreshToken String
  expiresAt    DateTime                // 14 days from install
  scope        String                  // granted scope list
  installedAt  DateTime  @default(now())
  lastSyncedAt DateTime?
  products     Product[]
}

model Product {
  id              String   @id @default(cuid())
  storeId         String
  sallaId         String                // (storeId, sallaId) unique
  name            String
  sku             String?
  description     String?
  priceAmount     Float
  priceCurrency   String
  salePriceAmount Float?
  quantity        Int?
  status          String                // "sale" / "out" / "hidden" / "deleted"
  type            String?
  productUrl      String?
  imageUrl        String?
  raw             String                // full Salla JSON for fields we haven't modeled (incl. options)
  cartItems       CartItem[]
  // ... indexes on storeId+status, storeId+syncedAt, name
}

model Customer {
  id              String   @id @default(cuid())
  storeId         String                // PER-STORE: (storeId, email) unique
  email           String
  phone           String?
  name            String?
  passwordHash    String                // bcryptjs
  sallaCustomerId String?               // filled lazily on first checkout
  cart            Cart?
}

model Cart {
  id         String     @id @default(cuid())
  customerId String     @unique         // 1:1 with Customer
  storeId    String                     // denormalized for queries
  items      CartItem[]
}

model CartItem {
  id              String   @id @default(cuid())
  cartId          String
  productId       String                // local Product id
  qty             Int
  selectedOptions String?               // JSON: [{id: <option_id>, value: [<value_id>]}]
  // unique on (cartId, productId)
}
```

---

## Required Salla scopes

Set on the partner app at salla.partners → App Scope. Merchant grants on install.

| Scope | Used for |
|---|---|
| `settings.read` | `GET /store/info` to learn store name + id after OAuth |
| `products.read` | catalog sync |
| `customers.read_write` | `POST /customers` to provision marketplace customers |
| `orders.read_write` | `POST /orders` to create the order at checkout |
| `shippings.read` | `GET /shipping/companies/` to auto-pick first active courier |
| `payments.read` | `GET /payment/methods?status=enabled` so we only send valid methods |
| `offline_access` | issue refresh tokens (otherwise access token dies in 14 days) |

Optional (richer storefront UI later): `categories.read`, `brands.read`,
`branches.read`, `specialoffers.read`.

**Current demo store** has all of the above EXCEPT `payments.read`. Code is
defensive: if `payments.read` is missing, the order creation falls back to
sending unfiltered methods and Salla returns field-level errors that the
frontend surfaces cleanly. To pick up the upgrade, the merchant should reinstall.

---

## Env vars

### Railway (`souq-api` service, name displayed as "web")

```
SALLA_CLIENT_ID                  (from partner portal)
SALLA_CLIENT_SECRET              (from partner portal — rotated by user post-session)
SALLA_SCOPES                     offline_access products.read settings.read customers.read_write orders.read_write shippings.read payments.read marketing.read_write loyalties.read_write
                                 # marketing.read_write → coupon create (the loyalty discount).
                                 # loyalties.read_write → loyalty point grant/deduct: live test shows POST /customers/loyalty/points 403s WITHOUT it
                                 #   (one docs page says customers.read_write, but behavior + the /loyalty/program 401 indicate loyalties.*). Reads work with customers.read.
BACKEND_URL                      https://web-production-f300.up.railway.app
FRONTEND_URL                     https://souq-front.vercel.app
JWT_SECRET                       (32-byte hex — rotated post-session)
DATABASE_URL                     (Postgres add-on ref — auto-injected)
NODE_ENV                         production
PORT                             (Railway auto)
```

### Vercel (`souq-front`, one project per merchant)

```
NEXT_PUBLIC_API_URL              https://web-production-f300.up.railway.app
NEXT_PUBLIC_STORE_ID             2141815737  (Salla store_id; demo "متجر تجريبي")
```

Vercel auto-injects `VERCEL_URL` (per-deploy) and `VERCEL_PROJECT_PRODUCTION_URL`
(stable alias). Server components prefer the production alias so they don't
hit Vercel's deployment-protection wall.

---

## Salla portal config that's already done on the existing demo

App on Salla Partners portal: configured.
- **Auth Mode**: Custom
- **App URL**: `https://web-production-f300.up.railway.app`
- **Callback URL**: `https://web-production-f300.up.railway.app/api/oauth/callback`
- **Webhook URL**: `https://web-production-f300.up.railway.app/api/webhooks/salla`
- **Subscribed webhooks**: Product Created / Updated / Deleted (Store Events tab)
- **Scopes ticked**: Basic Info, Settings, Customers (RW), Orders (RW),
  Branches, Categories, Brands, Products, Special Offers, Shipping
  - **Missing**: `payments.read` — needs a manual tick + merchant reinstall to
    enable the dynamic payment-method filter
- Demo store ID `2141815737` (Arabic name "متجر تجريبي")
- Demo store has 20 seeded sample products (all clothing, all with size options)

---

## Customer flow — step by step

1. Customer visits `https://souq-front.vercel.app/`
2. Server component fetches `/api/stores/2141815737/products?per_page=24&status=sale`
   (via Vercel rewrite → backend → local cache populated from Salla)
3. Customer clicks a product card → `/product/<localProductId>` server-renders
4. Customer picks an option value, qty, clicks "Add to cart"
   - Not logged in → redirected to `/login`
   - Logged in → `POST /api/cart/items { product_id, qty, options }`
   - `selectedOptions` persisted on the `CartItem` row as JSON
5. Header cart count updates; `/cart` shows line items
6. Customer clicks **Continue to checkout** → `/checkout`
   - Form pre-fills name + phone from profile (editable; required for Salla)
   - Address: country, city, district/block, street, address line, postal,
     geo-coordinates (with "Use my location" button)
   - Payment method: COD vs Pay online
7. Submit → `POST /api/checkout { name, phone, payment_method, shipping }`
8. Backend:
   - Persists any updated name/phone back to `Customer`
   - `ensureSallaCustomer()` — if `sallaCustomerId` is null, `POST /admin/v2/customers`
     with normalized phone and `mobile_code_country = "+966"` (or whatever
     country prefix). Idempotent.
   - Resolves `accepted_methods`: COD = `["cod"]`, Online =
     `["credit_card", "mada", "bank", "apple_pay", "stc_pay"]` — then filters
     against `getEnabledPaymentMethodSlugs()` when `payments.read` is granted.
   - Auto-picks the first active courier from `GET /shipping/companies/`
   - For each cart item, parses Product.raw and either uses the customer's
     `selectedOptions` or auto-defaults to the first in-stock value for each
     required/variant option.
   - `POST /admin/v2/orders` with full payload.
   - On 422 from Salla, throws `SallaValidationError` with the field map;
     route returns 400 + `{ fields: {...} }`.
   - On success, clears the cart and returns `{ order_id, checkout_url,
     customer_order_url, is_pending_payment }`.
9. Frontend:
   - `is_pending_payment === true` (real online payment) → redirect to Salla's
     hosted checkout URL. Customer pays on Salla's domain.
   - Else (COD) → redirect to `/order/confirmed?order_id=...&salla_url=...`
     (our page; "Order placed successfully" + reference + link to merchant's
     order page).

---

## Known issues + gotchas (the meaty list)

These are battle scars from this session. Read carefully — each one will save
the next session 30+ minutes.

### Cross-origin cookie / Vercel rewrite

The auth cookie is set by the backend (Railway domain) but the customer
browses the frontend (Vercel domain). Different origins → browser doesn't send
the cookie on cross-origin fetches by default.

**Fix in place**: `souq-front/next.config.ts` rewrites `/api/*` to the backend.
The browser sees `souq-front.vercel.app/api/auth/...` as same-origin; the
cookie is set on the Vercel domain and travels along on every request.

Don't change this. Don't change SameSite to `none` thinking it'll fix
cross-origin — the rewrite is the real fix.

### Server-side fetches and Vercel deployment protection

Vercel's "Deployment Protection" blocks the unique per-deploy URLs
(`souq-front-<sha>-...vercel.app`) but allows the production alias
(`souq-front.vercel.app`). Server components doing `fetch()` against
`VERCEL_URL` hit the auth wall.

**Fix in place**: `src/lib/api.ts → getApiBase()` prefers
`VERCEL_PROJECT_PRODUCTION_URL` (stable alias) over `VERCEL_URL` (per-deploy).

### `mobile_code_country` is the dial code with `+`, NOT the ISO code

Salla docs example: `"+967"` for Yemen. My first implementation sent `"SA"`
(ISO 3166), which made Salla unable to parse the mobile and return
`"mobile invalid"`.

**Fix in place**: `normalizeMobile()` in `src/lib/salla.ts` maps recognized
country prefixes to `"+966"` / `"+971"` / etc.

### `accepted_methods` rejected if merchant hasn't enabled them

If you send `["credit_card", "mada", "bank", "apple_pay", "stc_pay"]` but the
merchant only has bank enabled, Salla returns
`payment.accepted_methods.0/1/3/4 invalid`. Only index 2 (bank) works.

**Fix in place**: `getEnabledPaymentMethodSlugs()` filters the list when
`payments.read` is granted. Gracefully falls back when the scope isn't there.

### "Pay online" can resolve to a non-card method silently

If the customer picks "Pay online" but the merchant only has, say, `bank`
enabled, the filter narrows the request to `["bank"]`. Salla accepts and
returns `is_pending_payment: false` (bank transfer is "merchant verifies
manually," no Salla-hosted checkout). The frontend previously assumed
`!is_pending_payment` = COD and showed COD copy — confusing for the customer.

**Fix in place**:
- Backend captures `payment_method` and `status.slug` from Salla's order
  response and returns them on `/api/checkout`.
- Backend ALSO logs the full Salla order response via
  `console.log("[salla.order.created]", ...)` — search Railway logs to see
  exactly what Salla picked for a given order.
- Frontend passes `method=<slug>` to `/order/confirmed` and renders
  method-specific copy (COD, bank, credit_card, mada, etc.). Falls back to a
  generic "merchant will contact you" message for unknown methods.

**Still TODO (improvement)**: if "Pay online" gets resolved to a non-card
method, maybe surface a confirmation step before placing the order
("Heads up: this merchant accepts bank transfer only — proceed?"). For now,
the order is placed and the method-specific copy on /order/confirmed is the
recovery point.

### Loyalty redemption — IMPLEMENTED (Path B), discount mechanism verified live

**Earning** loyalty points works fine — Salla auto-awards based on order amount;
no customer auth needed; points show up on `/account` via our read endpoint.

**Redeeming** points at checkout is implemented end-to-end. The flow: customer
passes `redeem_points: N` to `POST /api/checkout` → backend checks
`availableToRedeem` (= Salla balance − points already spent in our local ledger)
→ creates a one-time `fixed` coupon for the SAR equivalent → applies it on the
Salla order via `coupon_code` → records the spend in the `Redemption` table. See
`createDiscountCoupon` / `getRedeemableLoyalty` / `getLoyaltyProgram` in
[`src/lib/salla.ts`](src/lib/salla.ts) and the redemption block in
[`src/routes/checkout.ts`](src/routes/checkout.ts).

#### What is PROVEN live (2026-05-28, demo store 2141815737)

- **Validation path**: `redeem_points` greater than balance → clean
  `insufficient_loyalty_points` 400 (no coupon, no order).
- **Discount lands on the order**: created a real order (id `1406841375`) for a
  94-SAR product + 50-SAR shipping with a `fixed` 50-SAR coupon. Salla's order
  `amounts.discounts` showed `{code, discount: "50.00"}` and total came out to
  **94** (= 94 + 50 − 50). Without the coupon it would be 144. ✅

#### Two real bugs found & fixed during the smoke test

1. **Coupon `type`** — must be `"fixed"`, not `"amount"`. Salla's
   `POST /coupons` rejects `"amount"` with 422 "invalid discount type".
2. **Coupon `code` charset** — must be **alphanumeric only** (`[A-Z0-9]`).
   `POST /coupons` accepts hyphens, but applying that code on an **order**
   fails 422 "coupon code must contain only letters and numbers". The generator
   now emits `LOYALTY<base36-ts><rand>` (no hyphens).

#### Why deduction uses a local ledger (Salla point-write is unavailable)

Salla's partner API will not let us deduct points. Investigated live on demo/dev
store 2141815737 (merchant "Demo", `dev-…`, `@email.partners`):

| Endpoint | Method | Result |
|---|---|---|
| `/customers/loyalty/points` (read balance) | GET | ✅ 200 — works with `customers.read` |
| `/customers/loyalty/points` (grant/deduct) | POST | ❌ **403 `ليس لديك صلاحية`** |
| `/loyalty/program` (read points→SAR rate) | GET | ❌ 401 — "needs `loyalties.read, loyalties.read_write`" |
| `/coupons` create+delete, `/orders` create, `/customers` create | POST | ✅ all succeed with current scopes |

Ruled out: **program-inactive** (activated a full program — earn method + reward +
reminder — still 403) and a **blanket demo-store write block** (orders/coupons/
customers all write fine). The loyalty write is specifically gated: one docs page
([Update Customer Loyalty Points](https://docs.salla.dev/12250579e0)) labels it
`customers.read_write`, but live behavior + the `/loyalty/program` 401 show the
loyalty domain sits behind **`loyalties.*`** — a reserved scope NOT selectable in
the partner portal. Research confirmed there is no alternate write endpoint, no
loyalty webhooks, and native redemption is storefront-only (logged-in customer).
The Customer Wallet debit endpoint has the same allow-list gate.

**Solution implemented — local redemption ledger** (`Redemption` model in
[`prisma/schema.prisma`](prisma/schema.prisma)):
- `getRedeemableLoyalty()` returns `available = sallaBalance − Σ(local Redemption.points)`.
- Checkout validates against `available`, creates the coupon, and writes a
  `Redemption` row on order success — **no Salla write**. `getLoyaltyPoints` stays
  the Salla read; `GET /api/loyalty/points` now returns `balance` = net available,
  plus `salla_balance` and `locally_redeemed`.
- No double-count: Salla's read already nets its own `used_points`, and our spends
  never reach Salla.

**Caveat (single-channel assumption):** since we never write to Salla, the
merchant's Salla dashboard won't reflect app redemptions, and if the SAME customer
also shops the merchant's native Salla storefront they could spend the same points
there too. Fine for the one-app-per-merchant template model. If a merchant runs
both channels, request Salla to allow-list the app for `customer-wallets.read_write`
(documented wallet debit/credit) or `loyalties.read_write`, then switch the deduct
to the real API.

**Still to verify live:** a full redeem checkout (seed a non-zero Salla balance →
redeem → confirm coupon on the order + a `Redemption` row + reduced `available`
next time). Earlier blocked only by *seeding* — the grant write 403s too — so seed
via the dashboard's manual point grant, or test on a store where the customer
already has a balance.

> Cleanup note: smoke-test coupons were deleted. One leftover **test order
> `1406841375`** (pending COD, demo store) can be cancelled from the dashboard.

Open implementation choices (unchanged):
- Conversion rate (points → SAR) — currently default 10:1 until `loyalties.read`
  lets us read `/loyalty/program`.
- Partial redemption vs. fixed tiers (50 / 100 / 500 points)?
- Show redemption UI only above a minimum balance (currently: only if balance > 0).

### Demo stores can't render the customer-facing payment form (platform-enforced)

**Critical discovery, confirmed via direct API probe**. The "store under
maintenance" banner shown on `demostore.salla.sa/<slug>/...` URLs is NOT a
toggleable maintenance setting. It's Salla's platform-level guard for stores
with `type: "demo"`.

What we verified:
- `GET /admin/v2/store/info` returns `{ "type": "demo", "status": "active",
  "verified": false, "licenses": { tax_number: null, commercial_number: null,
  freelance_number: null } }` — the store is "active" in the data, no
  maintenance flag exists.
- `GET /admin/v2/settings?entity=store` returns exactly ONE setting:
  `{ slug: "store.activities", type: "form" }`. There is no
  `store.maintenance` setting on a demo store.
- The Salla dashboard's "Maintenance Mode" panel hits
  `/admin/v2/settings/fields/store.maintenance` and gets a 404 from Salla's
  own backend — because that endpoint doesn't exist for demo stores.
- Creating a fresh demo store reproduces the exact same behavior.

Conclusion: **demo stores are admin-side functional but customer-side blocked**.
- Orders ARE accepted via API (our integration works end-to-end)
- The customer storefront shows the "under construction" banner regardless of
  any merchant action
- This is to prevent real payment processors from getting hit by test orders

To **visually confirm the card payment form**, you need a real (non-demo)
production merchant store with verified KYC + commercial registration. There
is no workaround on the demo side.

For the partner integration itself: nothing more to do. Real merchants will
get the real payment form. Demo stores demonstrate that the integration
works without enabling real money flow.

### `is_pending_payment: false` does NOT mean "paid"

Critical Salla semantics gotcha. The order create response can return:
```
{ is_pending_payment: false, status.slug: "payment_pending", payment_method: null }
```

This looks contradictory but it's how Salla expresses "unpaid order created;
the customer should visit `urls.checkout` to pick a method and pay." The
`is_pending_payment` flag is more like "is there an immediate hosted-payment
flow we built specifically for you" — and Salla returns `false` for it even on
unpaid orders.

**Fix in place**: Frontend's `CheckoutForm` redirects to `r.checkout_url`
whenever the customer picked `payment_method: "online"`, regardless of the
`is_pending_payment` flag. That's the URL where the customer picks a method
and pays.

The flag is still relevant for the COD path: `payment_method: "cod"` →
always go to `/order/confirmed` and skip Salla.

### Variants disguised as non-required options

A Salla product option can have `required: false` but `purpose: "variants"` —
the option IS effectively required because you must pick a variant.

**Fix in place**: `defaultOptionsForProduct()` in `src/routes/checkout.ts`
treats `purpose === "variants"` as required regardless of the `required` flag.

### `ship_to` shape — what Salla actually wants

Beyond country/city/postal_code, Salla requires:
- `block` (district/neighborhood)
- `street_number` (the street's name, despite the misleading field name)
- `address_line` (building/apartment description)
- `geo_coordinates: { latitude, longitude }`

Without all of these, order creation 422s with field-level errors. The
checkout form collects all of them; geo-coordinates can be auto-filled by the
browser's geolocation via the "Use my location" button.

### COD orders redirect to Salla → empty cart UX

If we redirect a COD customer to `customer_order_url`, they land on Salla's
storefront — but they're not logged in there, so they see Salla's empty cart
page.

**Fix in place**: Frontend's `CheckoutForm` checks `is_pending_payment`:
- `true` → redirect to Salla's hosted payment page
- `false` (COD) → redirect to OUR `/order/confirmed` page

### Demo store had ALL variants out-of-stock

Every option value on every demo product has `is_out_of_stock: true`. Order
creation still succeeds because Salla doesn't strictly enforce stock for
demo stores — but for a production merchant, you'd need to handle this
properly (skip out-of-stock values; surface error if none in stock).

### Salla's customer creation: `last_name` is required

The very first version of `ensureSallaCustomer` made last_name optional. Salla
rejected with field error. Now we require name to contain a space (first +
last) at signup AND we allow the customer to update it at checkout.

### Auth wall on missing `JWT_SECRET`

The auth helper throws a clear error if `JWT_SECRET` env var is empty or
shorter than 16 chars. If you see "JWT_SECRET env var is missing or too
short", set it on Railway.

### Per-store customer scoping

Same email can sign up on Merchant A and Merchant B as completely separate
customers. Unique constraint is `(storeId, email)` not just `email`. The JWT
cookie carries both `customerId` AND `storeId`, and we double-check on
`getCurrentCustomer` that the JWT's store matches the customer row's store.

---

## What's done vs not done

| Feature | State |
|---|---|
| OAuth install + token storage | ✅ |
| Refresh token + auto-retry on 401 | ✅ (in `sallaFetch`) |
| Catalog sync (Products) | ✅ |
| Customer auth (signup/login/me/logout) | ✅ per-store |
| Cart | ✅ with selectedOptions |
| Variant picker on product detail | ✅ |
| Checkout flow (address + payment method) | ✅ |
| Salla customer provisioning at checkout | ✅ |
| Order creation on Salla | ✅ multiple real orders placed |
| Auto-pick courier | ✅ |
| Auto-default variant options if customer skipped | ✅ |
| Surface Salla field-level errors in UI | ✅ |
| Order confirmation page (COD) | ✅ |
| Redirect to Salla checkout (Pay Online) | ✅ |
| Payment method dynamic filter | ✅ (graceful no-op if `payments.read` not granted) |
| Loyalty points display on /account | ✅ — needs merchant's Customer Loyalty app installed to show non-zero |
| Loyalty points REDEMPTION at checkout | ⚠️ implemented; discount proven live; deduct gated on `loyalties.read_write` scope — see [loyalty redemption](#loyalty-redemption--implemented-path-b-discount-mechanism-verified-live) |
| Multi-merchant deployment via NEXT_PUBLIC_STORE_ID | ✅ |
| Webhook signature verification | ❌ TODO — endpoint accepts any body |
| Admin auth on /api/stores/* | ❌ TODO — unauthenticated |
| RTL / Arabic styling polish | ❌ TODO |
| Customer order history page | ❌ TODO |
| Categories / brands filtering UI | ❌ TODO |
| Order status webhooks → update local UI | ❌ TODO |

---

## Onboarding a NEW merchant (operator workflow)

1. Send them the install URL: `https://web-production-f300.up.railway.app/install`
2. They authenticate on Salla, approve the scopes, land back on Vercel admin
3. On `/admin`, you see the new store row with their `store_id` and product count
4. Click **Sync** to pull their catalog into the local DB
5. **Create a new Vercel project** for them (or duplicate the existing
   `souq-front` project):
   - Source: the same `medcharaf111/souq-front` GitHub repo
   - Env vars: `NEXT_PUBLIC_API_URL=<backend url>` and
     `NEXT_PUBLIC_STORE_ID=<their store_id>`
   - Optional: connect a custom domain
6. Deploy. That Vercel project is now that merchant's branded storefront.
7. **Tell the merchant** to:
   - Enable at least one payment method in Salla → Settings → Payments
     (otherwise "Pay online" won't work)
   - Optionally install Salla's Customer Loyalty app
   - Turn OFF maintenance mode on the storefront
8. Done. Multiple merchants run off the same backend; each has their own
   branded Vercel deployment.

---

## Quick verification recipe (run anytime to confirm end-to-end works)

```bash
EMAIL="verify+$(date +%s)@example.com"
COOKIE=$(mktemp)
BASE="https://souq-front.vercel.app"
STORE=2141815737

# Pick a product (cmpms5t1f0013k71kjsgkxxht works on the demo store)
PRODUCT_ID="cmpms5t1f0013k71kjsgkxxht"

# 1. Signup
curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"storeId\":\"$STORE\",\"email\":\"$EMAIL\",\"password\":\"testpass123\",\"name\":\"E2E Test\",\"phone\":\"+966500000000\"}" \
  -c "$COOKIE" $BASE/api/auth/signup

# 2. Product detail with options
curl -s "$BASE/api/stores/$STORE/products/$PRODUCT_ID" | head -c 500

# 3. Add to cart with a selected option
curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"product_id\":\"$PRODUCT_ID\",\"qty\":1,\"options\":[{\"id\":1108028364,\"value\":[\"1090918447\"]}]}" \
  -b "$COOKIE" $BASE/api/cart/items

# 4. COD checkout
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"name":"E2E Test","phone":"+966500000000","payment_method":"cod","shipping":{"country":"SA","city":"Riyadh","block":"Al Olaya","street_number":"King Fahd Rd","address_line":"Building 12","postal_code":"11564","geo_coordinates":{"latitude":24.7136,"longitude":46.6753}}}' \
  -b "$COOKIE" $BASE/api/checkout
```

Expected at step 4: `{"order_id":"...","is_pending_payment":false,"customer_order_url":"..."}`

---

## CLI shortcuts

Both Railway and Vercel CLIs are logged in to `charafamri111@gmail.com`'s
accounts on this machine. From either repo's directory:

```powershell
# Railway
railway service web         # links to web service
railway variables           # list backend env vars
railway logs                # tail backend logs
railway logs --build        # build phase
railway redeploy --yes      # force redeploy

# Vercel (from souq-front/)
vercel ls                   # list deployments
vercel env ls               # list env vars
vercel --prod               # trigger production deploy
vercel logs <deployment-id> # tail logs
```

---

## Security follow-ups (do these before going public)

- [ ] Rotate `SALLA_CLIENT_SECRET`, `JWT_SECRET`, and the Postgres password —
      all three appeared in the chat transcript while wiring things up
- [ ] Verify webhook HMAC signature in `src/routes/webhooks.ts` against the
      webhook secret from the Partners portal
- [ ] Add admin auth middleware on `/api/stores/*` (currently anyone with the
      URL can list installed merchants and trigger syncs)
- [ ] Confirm CORS `origin` value matches the production Vercel URL exactly
- [ ] Decide on rate limiting for `/api/auth/signup` and `/api/auth/login`
- [ ] Re-evaluate `allowBackup` semantics — Prisma hashes passwords with bcrypt
      but the DB contains them; deserves operator review

---

## Salla docs referenced

- [Authorization (OAuth)](https://docs.salla.dev/421118m0)
- [List Products](https://docs.salla.dev/5394168e0)
- [Product Details](https://docs.salla.dev/api-5394169) — for option shape
- [Create Customer](https://docs.salla.dev/api-5394120)
- [Create Order](https://docs.salla.dev/api-5394145)
- [List Shipping Companies](https://docs.salla.dev/5394239e0)
- [Available Payment Methods](https://docs.salla.dev/5394164e0)
- [Customer Loyalty Points](https://docs.salla.dev/12250577e0)

---

## Commit log (significant)

| Commit | What |
|---|---|
| `1edee50` | Initial backend |
| `217c576` | Postgres + Railway-ready start script |
| `1189f89` | Customer auth (signup/login/me/logout) |
| `5c19710` | Cart system |
| `81efa2a` | Salla customer provisioning + order creation + loyalty |
| `e65c777` | normalize mobile + require first/last/phone with structured error |
| `c925837` | mobile_code_country numeric `+966` not ISO `SA` (THE big fix) |
| `359033a` | Surface Salla validation errors as 400 with fields |
| `e44db27` | Payment method picker (cod / online) |
| `2e175dd` | Variant picker — CartItem.selectedOptions + product detail endpoint |
| `<latest>` | Payment-method dynamic filter via getEnabledPaymentMethodSlugs |

Frontend mirrors with similar progression — see `git log` on `souq-front`.

---

## Final note to next session

When you pick up, the workflow IS WORKING. Multiple orders have been placed on
the real demo store. The user is AFK and trusts the state. If something looks
broken: first check whether you're hitting a stale build (Railway/Vercel
sometimes lag 30-60s after push), then check the cookie path (rewrites are
load-bearing), then check what scope is granted on the install vs what you're
trying to call.

Don't waste cycles re-explaining the architecture — refer to this doc.
