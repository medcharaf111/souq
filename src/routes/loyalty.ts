import { Router } from "express";
import { requireAuth } from "../lib/auth";
import { ensureSallaCustomer, getRedeemableLoyalty } from "../lib/salla";

const router = Router();

// GET /api/loyalty/points
// Returns this customer's loyalty point balance + history on the merchant's
// store. If the merchant hasn't installed the Customer Loyalty app on Salla,
// returns a zero balance (not an error).
router.get(
  "/loyalty/points",
  requireAuth(async (req, res) => {
    try {
      const sallaCustomerId = await ensureSallaCustomer(req.customer.id);
      const result = await getRedeemableLoyalty({
        storeId: req.customer.storeId,
        sallaCustomerId,
        localCustomerId: req.customer.id,
      });
      res.json({
        balance: result.available, // net = Salla balance − points spent in-app
        salla_balance: result.sallaBalance,
        locally_redeemed: result.locallyRedeemed,
        used_total: result.usedTotal,
        entries: result.entries,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: message });
    }
  })
);

export default router;
