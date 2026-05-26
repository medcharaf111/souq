import type { Store } from "@prisma/client";
import { prisma } from "./prisma";

export const SALLA_AUTH_URL = "https://accounts.salla.sa/oauth2/auth";
export const SALLA_TOKEN_URL = "https://accounts.salla.sa/oauth2/token";
export const SALLA_API_BASE = "https://api.salla.dev/admin/v2";

export function getClientCreds() {
  const id = process.env.SALLA_CLIENT_ID;
  const secret = process.env.SALLA_CLIENT_SECRET;
  const backendUrl = process.env.BACKEND_URL;
  if (!id || !secret || !backendUrl) {
    throw new Error("Missing SALLA_CLIENT_ID / SALLA_CLIENT_SECRET / BACKEND_URL");
  }
  return {
    clientId: id,
    clientSecret: secret,
    redirectUri: `${backendUrl.replace(/\/$/, "")}/api/oauth/callback`,
    scopes: process.env.SALLA_SCOPES ?? "offline_access products.read",
  };
}

export interface SallaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

export async function exchangeCodeForToken(code: string): Promise<SallaTokenResponse> {
  const { clientId, clientSecret, redirectUri } = getClientCreds();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });
  const res = await fetch(SALLA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<SallaTokenResponse>;
}

async function refreshToken(refresh: string): Promise<SallaTokenResponse> {
  const { clientId, clientSecret } = getClientCreds();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(SALLA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<SallaTokenResponse>;
}

const REFRESH_SKEW_MS = 60 * 60 * 1000;

async function ensureFreshToken(store: Store): Promise<Store> {
  if (store.expiresAt.getTime() - Date.now() > REFRESH_SKEW_MS) return store;
  const t = await refreshToken(store.refreshToken);
  return prisma.store.update({
    where: { storeId: store.storeId },
    data: {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: new Date(Date.now() + t.expires_in * 1000),
      scope: t.scope,
    },
  });
}

export async function sallaFetch(
  storeId: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  let store = await prisma.store.findUnique({ where: { storeId } });
  if (!store) throw new Error(`Store ${storeId} not installed`);
  store = await ensureFreshToken(store);

  const url = path.startsWith("http")
    ? path
    : `${SALLA_API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;

  const doFetch = (token: string) =>
    fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });

  let res = await doFetch(store.accessToken);
  if (res.status === 401) {
    const t = await refreshToken(store.refreshToken);
    store = await prisma.store.update({
      where: { storeId: store.storeId },
      data: {
        accessToken: t.access_token,
        refreshToken: t.refresh_token,
        expiresAt: new Date(Date.now() + t.expires_in * 1000),
        scope: t.scope,
      },
    });
    res = await doFetch(store.accessToken);
  }
  return res;
}

// ─── Product sync ─────────────────────────────────────────────────────────────

interface SallaProduct {
  id: number | string;
  name: string;
  sku?: string | null;
  description?: string | null;
  price?: { amount?: number; currency?: string } | null;
  sale_price?: { amount?: number; currency?: string } | null;
  quantity?: number | null;
  status?: string | null;
  type?: string | null;
  url?: string | null;
  images?: Array<{ image?: string; url?: string } | string> | null;
}

interface ProductsPage {
  data: SallaProduct[];
  pagination?: { count?: number; current?: number; next?: string | null };
}

function firstImageUrl(p: SallaProduct): string | null {
  const imgs = p.images ?? [];
  for (const i of imgs) {
    if (!i) continue;
    if (typeof i === "string") return i;
    if (typeof i === "object") return i.url ?? i.image ?? null;
  }
  return null;
}

export interface SyncResult {
  storeId: string;
  pagesFetched: number;
  productsUpserted: number;
  durationMs: number;
}

export async function syncProductsForStore(storeId: string): Promise<SyncResult> {
  const t0 = Date.now();
  let pagesFetched = 0;
  let productsUpserted = 0;

  let nextUrl: string | null = "/products?per_page=50";

  while (nextUrl) {
    const res = await sallaFetch(storeId, nextUrl);
    if (!res.ok) throw new Error(`Salla /products ${res.status}: ${await res.text()}`);
    const page = (await res.json()) as ProductsPage;
    pagesFetched++;

    for (const p of page.data ?? []) {
      const sallaId = String(p.id);
      const data = {
        name: p.name ?? "",
        sku: p.sku ?? null,
        description: p.description ?? null,
        priceAmount: p.price?.amount ?? 0,
        priceCurrency: p.price?.currency ?? "SAR",
        salePriceAmount: p.sale_price?.amount ?? null,
        quantity: p.quantity ?? null,
        status: p.status ?? "sale",
        type: p.type ?? null,
        productUrl: p.url ?? null,
        imageUrl: firstImageUrl(p),
        raw: JSON.stringify(p),
        syncedAt: new Date(),
      };
      await prisma.product.upsert({
        where: { storeId_sallaId: { storeId, sallaId } },
        update: data,
        create: { storeId, sallaId, ...data },
      });
      productsUpserted++;
    }

    nextUrl = page.pagination?.next ?? null;
  }

  await prisma.store.update({
    where: { storeId },
    data: { lastSyncedAt: new Date() },
  });

  return { storeId, pagesFetched, productsUpserted, durationMs: Date.now() - t0 };
}

// ─── Phase B: Salla customer provisioning ────────────────────────────────────

interface SallaCustomerCreatePayload {
  first_name: string;
  last_name: string;
  mobile: string;
  mobile_code_country: string;
  email: string;
}

function splitName(full: string | null | undefined): { first: string; last: string } {
  const name = (full ?? "").trim();
  if (!name) return { first: "", last: "" };
  const parts = name.split(/\s+/);
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/**
 * Normalize a phone string for Salla's customer creation endpoint.
 *
 * Per Salla docs (POST /admin/v2/customers):
 *   - `mobile`: 9-ish digits, no country code, no leading zero
 *   - `mobile_code_country`: numeric prefix WITH plus, e.g. "+966", "+967"
 *
 * Examples accepted by this helper:
 *   "+966500000000"  → { country: "+966", mobile: "500000000" }
 *   "00966500000000" → { country: "+966", mobile: "500000000" }
 *   "0500000000" (Saudi local) → defaults to +966 → { country: "+966", mobile: "500000000" }
 */
function normalizeMobile(raw: string | null | undefined): { country: string; mobile: string } | null {
  if (!raw) return null;
  let stripped = raw.replace(/[\s-]/g, "");
  if (stripped.startsWith("+")) stripped = stripped.slice(1);
  else if (stripped.startsWith("00")) stripped = stripped.slice(2);

  // Numeric country prefixes we recognize (sorted longest-first so "966" wins
  // over "9", etc.). Default fallback is "+966" (Saudi Arabia) since the
  // current target market is Salla merchants headquartered in KSA.
  const prefixes = ["966", "971", "965", "973", "974", "968", "967", "962", "20"];
  let country = "+966";
  for (const code of prefixes) {
    if (stripped.startsWith(code)) {
      country = `+${code}`;
      stripped = stripped.slice(code.length);
      break;
    }
  }
  if (stripped.startsWith("0")) stripped = stripped.slice(1);
  if (!/^\d{6,15}$/.test(stripped)) return null;
  return { country, mobile: stripped };
}

export class CustomerProfileIncompleteError extends Error {
  fields: string[];
  constructor(fields: string[]) {
    super(`Customer profile incomplete: ${fields.join(", ")}`);
    this.fields = fields;
  }
}

export class SallaValidationError extends Error {
  fields: Record<string, string[]>;
  constructor(fields: Record<string, string[]>, scope: string) {
    super(`Salla ${scope} validation failed`);
    this.fields = fields;
  }
}

function maybeSallaValidation(body: unknown, scope: string): SallaValidationError | null {
  if (typeof body !== "object" || !body) return null;
  const b = body as { status?: number; success?: boolean; error?: { fields?: Record<string, string[]> } };
  if (b.success === false && b.error?.fields && typeof b.error.fields === "object") {
    return new SallaValidationError(b.error.fields, scope);
  }
  return null;
}

/**
 * Make sure our local Customer has a corresponding Salla customer record on
 * the merchant's store. Returns the Salla customer ID. Idempotent: if the
 * sallaCustomerId is already set on the local customer, returns it directly.
 *
 * Throws CustomerProfileIncompleteError if the local profile is missing
 * fields Salla requires (last name, valid phone).
 */
export async function ensureSallaCustomer(localCustomerId: string): Promise<string> {
  const local = await prisma.customer.findUnique({ where: { id: localCustomerId } });
  if (!local) throw new Error(`Local customer ${localCustomerId} not found`);
  if (local.sallaCustomerId) return local.sallaCustomerId;

  const { first, last } = splitName(local.name);
  const phone = normalizeMobile(local.phone);

  const missing: string[] = [];
  if (!first) missing.push("first_name");
  if (!last) missing.push("last_name");
  if (!phone) missing.push("phone");
  if (missing.length > 0) throw new CustomerProfileIncompleteError(missing);

  const payload: SallaCustomerCreatePayload = {
    first_name: first,
    last_name: last,
    email: local.email,
    mobile: phone!.mobile,
    mobile_code_country: phone!.country,
  };

  const res = await sallaFetch(local.storeId, "/customers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const validation = maybeSallaValidation(body, "customer");
    if (validation) throw validation;
    throw new Error(
      `Salla customer creation failed: ${res.status} ${JSON.stringify(body)}`
    );
  }
  const sallaId =
    (body as { data?: { id?: number | string } })?.data?.id?.toString() ?? null;
  if (!sallaId) {
    throw new Error(`Salla customer creation returned no id: ${JSON.stringify(body)}`);
  }
  await prisma.customer.update({
    where: { id: local.id },
    data: { sallaCustomerId: sallaId },
  });
  return sallaId;
}

// ─── Phase C: Salla order creation ───────────────────────────────────────────

export interface ShippingAddress {
  country?: string;
  city?: string;
  block?: string;          // district / neighborhood
  street_number?: string;  // street name (despite the misleading field name)
  address_line?: string;   // building / apartment / "حقل وصف بيت الشحن"
  postal_code?: string;
  geo_coordinates?: { latitude: number; longitude: number };
}

export interface CheckoutItem {
  sallaProductId: string;
  qty: number;
  options?: Array<{ id: number; value: string[] | number[] }>;
}

export interface CreateOrderResult {
  orderId: string;
  checkoutUrl: string | null;
  customerOrderUrl: string | null;
  isPendingPayment: boolean;
  total?: { amount: number; currency: string };
}

async function getFirstCourierId(storeId: string): Promise<number | null> {
  try {
    const res = await sallaFetch(storeId, "/shipping/companies/");
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as {
      data?: Array<{ id?: number | string; status?: string }>;
    };
    const active = (body.data ?? []).find((c) => !c.status || c.status === "active") ?? body.data?.[0];
    if (!active?.id) return null;
    return Number(active.id);
  } catch {
    return null;
  }
}

/**
 * Create an order on the merchant's Salla store with payment.status="pending_payment"
 * so Salla handles payment collection. Returns the checkout URL to redirect the
 * customer to.
 *
 * Salla requires `courier_id` and `ship_to` when delivery_method is "shipping".
 * If the caller doesn't supply a courier, we auto-pick the first active
 * shipping company from the merchant's configured list.
 *
 * Accepted payment methods default to ["cod"] (cash on delivery) because that's
 * the only method universally enabled on Salla demo stores. Merchants who have
 * enabled credit_card / mada / bank can override via args.acceptedMethods.
 */
export async function createSallaOrder(args: {
  storeId: string;
  sallaCustomerId: string;
  items: CheckoutItem[];
  shipping?: ShippingAddress;
  courierId?: number;
  acceptedMethods?: string[];
}): Promise<CreateOrderResult> {
  const accepted = args.acceptedMethods ?? ["cod"];
  let courierId = args.courierId ?? null;
  if (args.shipping && !courierId) {
    courierId = await getFirstCourierId(args.storeId);
  }

  const payload: Record<string, unknown> = {
    customer: { id: Number(args.sallaCustomerId) },
    products: args.items.map((it) => ({
      identifier_type: "id",
      identifier: Number(it.sallaProductId),
      quantity: it.qty,
      ...(it.options && it.options.length > 0 ? { options: it.options } : {}),
    })),
    payment: {
      status: "pending_payment",
      accepted_methods: accepted,
    },
    delivery_method: args.shipping ? "shipping" : null,
    ...(args.shipping
      ? {
          ship_to: args.shipping,
          ...(courierId ? { courier_id: courierId } : {}),
        }
      : {}),
  };

  const res = await sallaFetch(args.storeId, "/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as {
    data?: {
      id?: number | string;
      urls?: { checkout?: string; customer?: string };
      is_pending_payment?: boolean;
      total?: { amount?: number; currency?: string };
    };
  };
  if (!res.ok || !body.data?.id) {
    const validation = maybeSallaValidation(body, "order");
    if (validation) throw validation;
    throw new Error(`Salla order creation failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return {
    orderId: body.data.id.toString(),
    checkoutUrl: body.data.urls?.checkout ?? null,
    customerOrderUrl: body.data.urls?.customer ?? null,
    isPendingPayment: !!body.data.is_pending_payment,
    total: body.data.total?.amount && body.data.total.currency
      ? { amount: body.data.total.amount, currency: body.data.total.currency }
      : undefined,
  };
}

// ─── Phase D: Loyalty points read ────────────────────────────────────────────

export interface LoyaltyPointsEntry {
  name: string;
  points: number;
  used_points: number;
  status: string;
  order_id: string | null;
  expiry_date: string | null;
}

export async function getLoyaltyPoints(
  storeId: string,
  sallaCustomerId: string
): Promise<{ entries: LoyaltyPointsEntry[]; balance: number; usedTotal: number }> {
  const res = await sallaFetch(
    storeId,
    `/customers/loyalty/points?customer_id=${encodeURIComponent(sallaCustomerId)}`
  );
  if (!res.ok) {
    // Most common cause: store doesn't have the Customer Loyalty app installed.
    // Treat as zero-balance rather than erroring.
    return { entries: [], balance: 0, usedTotal: 0 };
  }
  const body = (await res.json().catch(() => ({}))) as {
    data?: Array<Partial<LoyaltyPointsEntry>>;
  };
  const entries: LoyaltyPointsEntry[] = (body.data ?? []).map((e) => ({
    name: e.name ?? "",
    points: Number(e.points ?? 0),
    used_points: Number(e.used_points ?? 0),
    status: e.status ?? "",
    order_id: e.order_id ?? null,
    expiry_date: e.expiry_date ?? null,
  }));
  let balance = 0;
  let usedTotal = 0;
  for (const e of entries) {
    balance += e.points - e.used_points;
    usedTotal += e.used_points;
  }
  return { entries, balance, usedTotal };
}
