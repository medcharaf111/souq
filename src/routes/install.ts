import { Router } from "express";
import { randomBytes } from "node:crypto";
import { SALLA_AUTH_URL, getClientCreds } from "../lib/salla";

const router = Router();

// GET /install — start the OAuth flow.
// Merchant clicks an install link from the frontend, lands here on the backend,
// we set a state cookie and redirect to Salla.
router.get("/install", (_req, res) => {
  const { clientId, redirectUri, scopes } = getClientCreds();
  const state = randomBytes(16).toString("hex");

  res.cookie("salla_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
    path: "/",
  });

  const url = new URL(SALLA_AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("state", state);

  res.redirect(url.toString());
});

export default router;
