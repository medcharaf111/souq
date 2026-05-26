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
