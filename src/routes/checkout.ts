import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../lib/auth";
import { createSallaOrder, ensureSallaCustomer, type ShippingAddress, type CheckoutItem } from "../lib/salla";

interface RawSallaProductOption {
  id?: number | string;
  required?: boolean;
  purpose?: string;
  values?: Array<{ id?: number | string; is_out_of_stock?: boolean }>;
}

/**
 * Parse the cached raw JSON for a Salla product and return a default options
 * payload — one entry per option that either is required or is a variant
 * selector. Prefers in-stock values; falls back to the first value if all are
 * out of stock (Salla will reject if truly unavailable, surfacing the error).
 *
 * v1 limitation: customer can't pick option values yet; we auto-fill defaults.
 */
function defaultOptionsForProduct(rawJson: string): CheckoutItem["options"] {
  let parsed: { options?: RawSallaProductOption[] };
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return undefined;
  }
  const opts = parsed.options ?? [];
  const out: NonNullable<CheckoutItem["options"]> = [];
  for (const o of opts) {
    // Variants must always be selected; non-variants only if explicitly required.
    const isVariant = o.purpose === "variants";
    if (!o.required && !isVariant) continue;
    const values = o.values ?? [];
    const inStock = values.find((v) => !v.is_out_of_stock);
    const chosen = inStock?.id ?? values[0]?.id;
    if (o.id != null && chosen != null) {
      out.push({ id: Number(o.id), value: [String(chosen)] });
    }
  }
  return out.length > 0 ? out : undefined;
}

const router = Router();

// POST /api/checkout
// Body: { shipping?: { country, city, street, block, postal_code }, courier_id?: number }
// Returns: { order_id, checkout_url, customer_order_url, is_pending_payment }
router.post(
  "/checkout",
  requireAuth(async (req, res) => {
    const cart = await prisma.cart.findUnique({
      where: { customerId: req.customer.id },
      include: { items: { include: { product: true } } },
    });
    if (!cart || cart.items.length === 0) {
      res.status(400).json({ error: "cart is empty" });
      return;
    }

    const { shipping, courier_id: courierId } = (req.body ?? {}) as {
      shipping?: ShippingAddress;
      courier_id?: number;
    };

    try {
      // Phase B: ensure the local customer has a Salla customer counterpart.
      const sallaCustomerId = await ensureSallaCustomer(req.customer.id);

      // Phase C: create the Salla order. Salla returns a checkout URL the
      // customer must be redirected to for payment.
      const order = await createSallaOrder({
        storeId: req.customer.storeId,
        sallaCustomerId,
        items: cart.items.map((it) => ({
          sallaProductId: it.product.sallaId,
          qty: it.qty,
          options: defaultOptionsForProduct(it.product.raw),
        })),
        shipping,
        courierId,
      });

      // Empty the cart now — the order exists; if the customer bails on Salla's
      // payment page, they can complete it from the order page later.
      await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });

      res.json({
        order_id: order.orderId,
        checkout_url: order.checkoutUrl,
        customer_order_url: order.customerOrderUrl,
        is_pending_payment: order.isPendingPayment,
        total: order.total,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: message });
    }
  })
);

export default router;
