import "dotenv/config";
import "express-async-errors"; // patches Express 4 to route async throws to the error handler
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";

import authRouter from "./routes/auth";
import cartRouter from "./routes/cart";
import checkoutRouter from "./routes/checkout";
import debugRouter from "./routes/debug";
import installRouter from "./routes/install";
import loyaltyRouter from "./routes/loyalty";
import oauthRouter from "./routes/oauth";
import storesRouter from "./routes/stores";
import webhooksRouter from "./routes/webhooks";

const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_URL ?? "http://localhost:3001",
    credentials: true,
  })
);
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/", installRouter);
app.use("/api", authRouter);
app.use("/api", cartRouter);
app.use("/api", checkoutRouter);
app.use("/api", debugRouter);
app.use("/api", loyaltyRouter);
app.use("/api", oauthRouter);
app.use("/api", storesRouter);
app.use("/api", webhooksRouter);

// Catch-all error handler. Express 4 doesn't auto-route async throws here, so
// this mainly catches sync errors + anything explicitly passed to next(err).
// The bigger protection against the "request hangs → 502" failure mode is the
// Prisma connection retry in lib/prisma.ts.
app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[unhandled error]", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "internal_error" });
  }
);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`souq backend listening on :${port}`);
});
