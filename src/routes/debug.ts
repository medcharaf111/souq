import { Router } from "express";
import { sallaFetch } from "../lib/salla";

const router = Router();

/**
 * TEMPORARY diagnostic route. Same as before. Delete after investigation.
 */
router.all("/_debug/salla", async (req, res) => {
  const key = req.query.key as string | undefined;
  if (key !== process.env.DEBUG_KEY) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const storeId = req.query.store as string | undefined;
  const path = req.query.path as string | undefined;
  if (!storeId || !path) {
    res.status(400).json({ error: "store and path query params required" });
    return;
  }
  const method = (req.query.method as string | undefined)?.toUpperCase() ?? "GET";
  const init: RequestInit = { method };
  if (method !== "GET" && method !== "HEAD") {
    init.body = JSON.stringify(req.body ?? {});
    init.headers = { "content-type": "application/json" };
  }
  try {
    const r = await sallaFetch(storeId, path, init);
    const text = await r.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    res.json({ status: r.status, ok: r.ok, body });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
