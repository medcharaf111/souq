import { Router } from "express";
import type { Cart, CartItem, Customer, Product } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../lib/auth";

const router = Router();

type CartWithItems = Cart & {
  items: (CartItem & { product: Product })[];
};

async function getOrCreateCart(customer: Customer): Promise<CartWithItems> {
  const existing = await prisma.cart.findUnique({
    where: { customerId: customer.id },
    include: { items: { include: { product: true } } },
  });
  if (existing) return existing;
  return prisma.cart.create({
    data: { customerId: customer.id, storeId: customer.storeId },
    include: { items: { include: { product: true } } },
  });
}

function serializeCart(cart: CartWithItems) {
  let subtotal = 0;
  const currency = cart.items[0]?.product.priceCurrency ?? "SAR";
  const items = cart.items.map((it) => {
    const unit = it.product.salePriceAmount ?? it.product.priceAmount;
    const lineTotal = unit * it.qty;
    subtotal += lineTotal;
    return {
      id: it.id,
      product_id: it.product.id,
      salla_product_id: it.product.sallaId,
      name: it.product.name,
      image: it.product.imageUrl,
      url: it.product.productUrl,
      sku: it.product.sku,
      unit_price: unit,
      line_total: lineTotal,
      currency: it.product.priceCurrency,
      qty: it.qty,
      stock: it.product.quantity,
      status: it.product.status,
    };
  });
  return {
    id: cart.id,
    store_id: cart.storeId,
    items,
    item_count: items.reduce((s, it) => s + it.qty, 0),
    subtotal,
    currency,
  };
}

// GET /api/cart
router.get(
  "/cart",
  requireAuth(async (req, res) => {
    const cart = await getOrCreateCart(req.customer);
    res.json({ cart: serializeCart(cart) });
  })
);

// POST /api/cart/items   { product_id, qty? }
router.post(
  "/cart/items",
  requireAuth(async (req, res) => {
    const { product_id, qty } = (req.body ?? {}) as { product_id?: string; qty?: number };
    if (!product_id) {
      res.status(400).json({ error: "product_id required" });
      return;
    }
    const requested = Math.max(1, Math.min(99, Number(qty ?? 1) || 1));

    const product = await prisma.product.findUnique({ where: { id: product_id } });
    if (!product) {
      res.status(404).json({ error: "product not found" });
      return;
    }
    if (product.storeId !== req.customer.storeId) {
      res.status(400).json({ error: "product belongs to a different store" });
      return;
    }
    if (product.status !== "sale") {
      res.status(400).json({ error: "product not available" });
      return;
    }

    const cart = await getOrCreateCart(req.customer);
    await prisma.cartItem.upsert({
      where: { cartId_productId: { cartId: cart.id, productId: product.id } },
      update: { qty: { increment: requested } },
      create: { cartId: cart.id, productId: product.id, qty: requested },
    });

    const refreshed = await prisma.cart.findUnique({
      where: { id: cart.id },
      include: { items: { include: { product: true } } },
    });
    res.json({ cart: serializeCart(refreshed!) });
  })
);

// PATCH /api/cart/items/:id   { qty }   -- qty=0 removes
router.patch(
  "/cart/items/:id",
  requireAuth(async (req, res) => {
    const itemId = String(req.params.id);
    const item = await prisma.cartItem.findUnique({
      where: { id: itemId },
      include: { cart: true },
    });
    if (!item || item.cart.customerId !== req.customer.id) {
      res.status(404).json({ error: "item not found" });
      return;
    }
    const qty = Math.max(0, Math.min(99, Number((req.body ?? {}).qty ?? 0) || 0));
    if (qty === 0) {
      await prisma.cartItem.delete({ where: { id: item.id } });
    } else {
      await prisma.cartItem.update({ where: { id: item.id }, data: { qty } });
    }
    const refreshed = await prisma.cart.findUnique({
      where: { id: item.cartId },
      include: { items: { include: { product: true } } },
    });
    res.json({ cart: serializeCart(refreshed!) });
  })
);

// DELETE /api/cart/items/:id
router.delete(
  "/cart/items/:id",
  requireAuth(async (req, res) => {
    const itemId = String(req.params.id);
    const item = await prisma.cartItem.findUnique({
      where: { id: itemId },
      include: { cart: true },
    });
    if (!item || item.cart.customerId !== req.customer.id) {
      res.status(404).json({ error: "item not found" });
      return;
    }
    await prisma.cartItem.delete({ where: { id: item.id } });
    const refreshed = await prisma.cart.findUnique({
      where: { id: item.cartId },
      include: { items: { include: { product: true } } },
    });
    res.json({ cart: serializeCart(refreshed!) });
  })
);

// DELETE /api/cart
router.delete(
  "/cart",
  requireAuth(async (req, res) => {
    const cart = await prisma.cart.findUnique({ where: { customerId: req.customer.id } });
    if (cart) await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    const refreshed = await getOrCreateCart(req.customer);
    res.json({ cart: serializeCart(refreshed) });
  })
);

export default router;
