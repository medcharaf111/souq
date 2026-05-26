import { Router } from "express";
import { requireAuth } from "../lib/auth";
import { ensureSallaCustomer, getLoyaltyPoints } from "../lib/salla";

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
      const result = await getLoyaltyPoints(req.customer.storeId, sallaCustomerId);
      res.json({
        balance: result.balance,
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
