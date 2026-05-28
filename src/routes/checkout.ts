import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../lib/auth";
import {
  createDiscountCoupon,
  createSallaOrder,
  CustomerProfileIncompleteError,
  ensureSallaCustomer,
  getLoyaltyProgram,
  getRedeemableLoyalty,
  SallaValidationError,
  type ShippingAddress,
  type CheckoutItem,
} from "../lib/salla";

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

    const {
      shipping,
      courier_id: courierId,
      name: profileName,
      phone: profilePhone,
      payment_method: paymentMethod,
      redeem_points: redeemPointsRaw,
    } = (req.body ?? {}) as {
      shipping?: ShippingAddress;
      courier_id?: number;
      name?: string;
      phone?: string;
      payment_method?: "cod" | "online";
      redeem_points?: number;
    };

    const requestedRedeem = Math.max(0, Math.floor(Number(redeemPointsRaw) || 0));

    // Map the customer's choice into Salla's accepted_methods array. "online"
    // means anything the merchant has enabled that isn't COD — Salla's hosted
    // checkout page lets the customer pick from those once they land there.
    const acceptedMethods =
      paymentMethod === "online"
        ? ["credit_card", "mada", "bank", "apple_pay", "stc_pay"]
        : ["cod"];

    // If the checkout form provided updated name/phone, persist them to the
    // customer profile BEFORE provisioning on Salla. This is how missing
    // fields get filled in for customers who signed up with just an email.
    if (
      (profileName && profileName.trim() !== (req.customer.name ?? "")) ||
      (profilePhone && profilePhone !== (req.customer.phone ?? ""))
    ) {
      await prisma.customer.update({
        where: { id: req.customer.id },
        data: {
          name: profileName?.trim() || req.customer.name,
          phone: profilePhone?.trim() || req.customer.phone,
        },
      });
    }

    try {
      // Phase B: ensure the local customer has a Salla customer counterpart.
      const sallaCustomerId = await ensureSallaCustomer(req.customer.id);

      // Phase E: loyalty redemption (optional). Build a one-time coupon
      // BEFORE order creation so the discount lands on the order. We record the
      // spend in our local ledger AFTER order success so we don't burn points on
      // a failed order. (Salla can't deduct via the partner API — see salla.ts.)
      let redeemCouponCode: string | null = null;
      let redeemedPoints = 0;
      let redeemedAmount = 0;
      let redeemedCurrency = "SAR";
      if (requestedRedeem > 0) {
        const [loyalty, program] = await Promise.all([
          getRedeemableLoyalty({
            storeId: req.customer.storeId,
            sallaCustomerId,
            localCustomerId: req.customer.id,
          }),
          getLoyaltyProgram(req.customer.storeId),
        ]);
        if (loyalty.available < requestedRedeem) {
          res.status(400).json({
            error: "insufficient_loyalty_points",
            message: `You requested ${requestedRedeem} points but only have ${loyalty.available} available.`,
            available: loyalty.available,
            requested: requestedRedeem,
          });
          return;
        }
        if (program.minRedeemPoints > 0 && requestedRedeem < program.minRedeemPoints) {
          res.status(400).json({
            error: "redemption_below_minimum",
            message: `Minimum redemption is ${program.minRedeemPoints} points.`,
            min: program.minRedeemPoints,
          });
          return;
        }
        const discountValue = Math.floor(requestedRedeem / program.pointsPerCurrencyUnit);
        if (discountValue < 1) {
          res.status(400).json({
            error: "redemption_too_small",
            message: `Need at least ${program.pointsPerCurrencyUnit} points to get 1 ${program.currency} off.`,
          });
          return;
        }
        try {
          redeemCouponCode = await createDiscountCoupon({
            storeId: req.customer.storeId,
            amount: discountValue,
            reason: `Loyalty redemption for customer ${req.customer.id}`,
          });
          redeemedPoints = requestedRedeem;
          redeemedAmount = discountValue;
          redeemedCurrency = program.currency;
        } catch (e) {
          res.status(500).json({
            error: "coupon_creation_failed",
            message:
              e instanceof Error
                ? e.message
                : "Could not create discount coupon for redemption.",
          });
          return;
        }
      }

      // Phase C: create the Salla order. Salla returns a checkout URL the
      // customer must be redirected to for payment.
      const order = await createSallaOrder({
        storeId: req.customer.storeId,
        sallaCustomerId,
        items: cart.items.map((it) => {
          // Prefer the customer's explicit option choices (saved from the
          // product detail page); fall back to auto-picking sensible defaults
          // for products that have required options but were added without a
          // selection (e.g. legacy cart items from before the variant picker).
          let chosen: CheckoutItem["options"] | undefined;
          if (it.selectedOptions) {
            try {
              const parsed = JSON.parse(it.selectedOptions);
              if (Array.isArray(parsed) && parsed.length > 0) chosen = parsed;
            } catch {}
          }
          return {
            sallaProductId: it.product.sallaId,
            qty: it.qty,
            options: chosen ?? defaultOptionsForProduct(it.product.raw),
          };
        }),
        shipping,
        courierId,
        acceptedMethods,
        couponCode: redeemCouponCode ?? undefined,
      });

      // Order succeeded → record the spend in our local ledger (Salla can't
      // deduct via the partner API). This is what keeps the next checkout's
      // availableToRedeem correct. Best-effort log on failure so a ledger hiccup
      // doesn't fail an order that's already been placed.
      if (redeemedPoints > 0 && redeemCouponCode) {
        try {
          await prisma.redemption.create({
            data: {
              customerId: req.customer.id,
              storeId: req.customer.storeId,
              points: redeemedPoints,
              amount: redeemedAmount,
              currency: redeemedCurrency,
              couponCode: redeemCouponCode,
              orderId: order.orderId,
            },
          });
        } catch (e) {
          console.error("[loyalty.redemption_record_failed]", {
            order_id: order.orderId,
            customer_id: req.customer.id,
            points: redeemedPoints,
            err: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // Empty the cart now — the order exists; if the customer bails on Salla's
      // payment page, they can complete it from the order page later.
      await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });

      res.json({
        order_id: order.orderId,
        checkout_url: order.checkoutUrl,
        customer_order_url: order.customerOrderUrl,
        is_pending_payment: order.isPendingPayment,
        payment_method: order.paymentMethod,
        status_slug: order.statusSlug,
        requested_methods: acceptedMethods,
        total: order.total,
        redeemed_points: redeemedPoints,
        redeemed_amount: redeemedAmount,
        redeem_coupon: redeemCouponCode,
      });
    } catch (e) {
      if (e instanceof CustomerProfileIncompleteError) {
        res.status(400).json({
          error: "profile_incomplete",
          missing: e.fields,
          message:
            "Please provide your full name (first + last) and phone number to complete checkout.",
        });
        return;
      }
      if (e instanceof SallaValidationError) {
        res.status(400).json({
          error: "salla_validation",
          fields: e.fields,
          message: "Salla rejected the order — see fields below.",
        });
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: message });
    }
  })
);

export default router;
