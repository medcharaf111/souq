import { Router } from "express";
import { prisma } from "../lib/prisma";

const router = Router();

// POST /api/webhooks/salla — Salla webhook receiver.
//
// TODO: verify the HMAC signature header against the webhook secret from the
// Partners portal before trusting any body fields.
router.post("/webhooks/salla", async (req, res) => {
  const event = req.body as { event?: string; data?: Record<string, unknown> } | undefined;
  if (!event || typeof event !== "object") {
    res.status(400).json({ error: "invalid body" });
    return;
  }
  const type = event.event;
  const data = event.data;

  if (type === "app.store.authorize" && data) {
    const storeId = String(data.merchant ?? data.store_id ?? "");
    const accessToken = String(data.access_token ?? "");
    const refreshTokenStr = String(data.refresh_token ?? "");
    const expiresIn = Number(data.expires ?? data.expires_in ?? 0);
    const scope = String(data.scope ?? "");
    if (storeId && accessToken && refreshTokenStr && expiresIn) {
      await prisma.store.upsert({
        where: { storeId },
        update: {
          accessToken,
          refreshToken: refreshTokenStr,
          expiresAt: new Date(Date.now() + expiresIn * 1000),
          scope,
        },
        create: {
          storeId,
          accessToken,
          refreshToken: refreshTokenStr,
          expiresAt: new Date(Date.now() + expiresIn * 1000),
          scope,
        },
      });
    }
  } else if (type === "app.uninstalled" && data) {
    const storeId = String(data.merchant ?? data.store_id ?? "");
    if (storeId) {
      await prisma.store.delete({ where: { storeId } }).catch(() => undefined);
    }
  }

  res.json({ ok: true });
});

export default router;
