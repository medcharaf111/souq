import { Router } from "express";
import { prisma } from "../lib/prisma";
import { sallaFetch, syncProductsForStore } from "../lib/salla";

const router = Router();

// GET /api/stores — list installed stores with product counts.
router.get("/stores", async (_req, res) => {
  const stores = await prisma.store.findMany({
    orderBy: { installedAt: "desc" },
    include: { _count: { select: { products: true } } },
  });
  res.json({
    stores: stores.map((s) => ({
      store_id: s.storeId,
      store_name: s.storeName,
      installed_at: s.installedAt,
      last_synced_at: s.lastSyncedAt,
      expires_at: s.expiresAt,
      scope: s.scope,
      product_count: s._count.products,
    })),
  });
});


// POST /api/stores/:storeId/sync — pull catalog from Salla into local cache.
router.post("/stores/:storeId/sync", async (req, res) => {
  try {
    const result = await syncProductsForStore(req.params.storeId);
    res.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

interface RawProductOption {
  id?: number | string;
  name?: string;
  type?: string;
  required?: boolean;
  purpose?: string;
  values?: Array<{
    id?: number | string;
    name?: string;
    is_out_of_stock?: boolean;
    price?: { amount?: number; currency?: string };
  }>;
}

function parseProductOptions(rawJson: string): Array<{
  id: number;
  name: string;
  type: string;
  required: boolean;
  purpose: string | null;
  values: Array<{ id: number; name: string; is_out_of_stock: boolean }>;
}> {
  try {
    const parsed = JSON.parse(rawJson) as { options?: RawProductOption[] };
    return (parsed.options ?? [])
      .filter((o): o is Required<Pick<RawProductOption, "id">> & RawProductOption => o.id != null)
      .map((o) => ({
        id: Number(o.id),
        name: o.name ?? "",
        type: o.type ?? "radio",
        required: !!o.required,
        purpose: o.purpose ?? null,
        values: (o.values ?? [])
          .filter((v) => v.id != null)
          .map((v) => ({
            id: Number(v.id),
            name: v.name ?? "",
            is_out_of_stock: !!v.is_out_of_stock,
          })),
      }));
  } catch {
    return [];
  }
}

// GET /api/stores/:storeId/products/:productId — single product with parsed
// options. Used by the product detail page on the storefront.
router.get("/stores/:storeId/products/:productId", async (req, res) => {
  const { storeId, productId } = req.params;
  const p = await prisma.product.findUnique({ where: { id: String(productId) } });
  if (!p || p.storeId !== storeId) {
    res.status(404).json({ error: "product not found" });
    return;
  }
  res.json({
    product: {
      id: p.id,
      salla_id: p.sallaId,
      name: p.name,
      sku: p.sku,
      description: p.description,
      price: { amount: p.priceAmount, currency: p.priceCurrency },
      sale_price: p.salePriceAmount,
      quantity: p.quantity,
      status: p.status,
      type: p.type,
      url: p.productUrl,
      image: p.imageUrl,
      options: parseProductOptions(p.raw),
    },
  });
});

// GET /api/stores/:storeId/products — products from local cache.
// Use ?live=1 to bypass cache (passthrough to Salla — debugging only).
router.get("/stores/:storeId/products", async (req, res) => {
  const { storeId } = req.params;

  if (req.query.live === "1") {
    const allowed = ["page", "per_page", "keyword", "status", "category", "format"];
    const qs = new URLSearchParams();
    for (const k of allowed) {
      const v = req.query[k];
      if (typeof v === "string") qs.set(k, v);
    }
    if (!qs.has("per_page")) qs.set("per_page", "50");
    const r = await sallaFetch(storeId, `/products${qs.toString() ? `?${qs}` : ""}`);
    res.status(r.status);
    res.setHeader("content-type", r.headers.get("content-type") ?? "application/json");
    res.send(await r.text());
    return;
  }

  const page = Math.max(1, Number(req.query.page ?? "1") || 1);
  const perPage = Math.min(100, Math.max(1, Number(req.query.per_page ?? "50") || 50));
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const search = typeof req.query.search === "string" ? req.query.search : undefined;

  const where = {
    storeId,
    ...(status ? { status } : {}),
    ...(search ? { name: { contains: search } } : {}),
  };

  const [total, products] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      orderBy: { syncedAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  res.json({
    store_id: storeId,
    page,
    per_page: perPage,
    total,
    has_more: page * perPage < total,
    products: products.map((p) => ({
      id: p.id,
      salla_id: p.sallaId,
      name: p.name,
      sku: p.sku,
      description: p.description,
      price: { amount: p.priceAmount, currency: p.priceCurrency },
      sale_price: p.salePriceAmount,
      quantity: p.quantity,
      status: p.status,
      type: p.type,
      url: p.productUrl,
      image: p.imageUrl,
      synced_at: p.syncedAt,
    })),
  });
});

export default router;
