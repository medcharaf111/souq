import { Router } from "express";
import { prisma } from "../lib/prisma";
import { exchangeCodeForToken, sallaFetch } from "../lib/salla";

const router = Router();

// GET /api/oauth/callback — Salla redirects here after the merchant approves.
// Verifies state, exchanges code for tokens, resolves the merchant's storeId,
// then redirects the user to the frontend.
router.get("/oauth/callback", async (req, res) => {
  const { code, state: returnedState, error } = req.query as Record<string, string | undefined>;
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3001";

  if (error) {
    res.redirect(`${frontendUrl}/?error=${encodeURIComponent(error)}`);
    return;
  }
  if (!code || !returnedState) {
    res.status(400).json({ error: "missing code or state" });
    return;
  }

  const expectedState = req.cookies?.salla_oauth_state;
  res.clearCookie("salla_oauth_state", { path: "/" });
  if (!expectedState || expectedState !== returnedState) {
    res.status(400).json({ error: "state mismatch" });
    return;
  }

  try {
    const token = await exchangeCodeForToken(code);
    const expiresAt = new Date(Date.now() + token.expires_in * 1000);

    // Persist with a placeholder storeId; resolve the real one via /store/info.
    const tempStoreId = `pending:${Date.now()}`;
    await prisma.store.create({
      data: {
        storeId: tempStoreId,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt,
        scope: token.scope,
      },
    });

    let resolvedStoreId = tempStoreId;
    try {
      const r = await sallaFetch(tempStoreId, "/store/info");
      if (r.ok) {
        const body = (await r.json()) as { data?: { id?: number | string; name?: string } };
        const id = body.data?.id?.toString();
        const name = body.data?.name ?? null;
        if (id) {
          await prisma.store.upsert({
            where: { storeId: id },
            update: {
              storeName: name,
              accessToken: token.access_token,
              refreshToken: token.refresh_token,
              expiresAt,
              scope: token.scope,
            },
            create: {
              storeId: id,
              storeName: name,
              accessToken: token.access_token,
              refreshToken: token.refresh_token,
              expiresAt,
              scope: token.scope,
            },
          });
          await prisma.store.delete({ where: { storeId: tempStoreId } });
          resolvedStoreId = id;
        }
      }
    } catch {
      // Fall through — store stays under the placeholder ID; webhook can resolve it later.
    }

    res.redirect(`${frontendUrl}/?installed=${encodeURIComponent(resolvedStoreId)}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

export default router;
