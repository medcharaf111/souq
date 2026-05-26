import { Router } from "express";
import { prisma } from "../lib/prisma";
import {
  getCurrentCustomer,
  hashPassword,
  issueSessionCookie,
  SESSION_COOKIE_NAME,
  verifyPassword,
} from "../lib/auth";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function assertStoreExists(storeId: string): Promise<boolean> {
  const store = await prisma.store.findUnique({ where: { storeId } });
  return !!store;
}

router.post("/auth/signup", async (req, res) => {
  const { storeId, email, password, name, phone } = (req.body ?? {}) as {
    storeId?: string;
    email?: string;
    password?: string;
    name?: string;
    phone?: string;
  };

  if (!storeId) {
    res.status(400).json({ error: "storeId is required" });
    return;
  }
  if (!(await assertStoreExists(storeId))) {
    res.status(400).json({ error: "store is not installed" });
    return;
  }
  if (!email || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: "invalid email" });
    return;
  }
  if (!password || password.length < 8) {
    res.status(400).json({ error: "password must be at least 8 characters" });
    return;
  }
  const existing = await prisma.customer.findUnique({
    where: { storeId_email: { storeId, email } },
  });
  if (existing) {
    res.status(409).json({ error: "email already registered for this store" });
    return;
  }
  const customer = await prisma.customer.create({
    data: {
      storeId,
      email,
      passwordHash: await hashPassword(password),
      name: name ?? null,
      phone: phone ?? null,
    },
  });
  const c = issueSessionCookie(customer.id, customer.storeId);
  res.cookie(c.name, c.value, c.options);
  res.json({
    customer: {
      id: customer.id,
      store_id: customer.storeId,
      email: customer.email,
      name: customer.name,
      phone: customer.phone,
    },
  });
});

router.post("/auth/login", async (req, res) => {
  const { storeId, email, password } = (req.body ?? {}) as {
    storeId?: string;
    email?: string;
    password?: string;
  };
  if (!storeId || !email || !password) {
    res.status(400).json({ error: "storeId, email, password required" });
    return;
  }
  const customer = await prisma.customer.findUnique({
    where: { storeId_email: { storeId, email } },
  });
  if (!customer || !(await verifyPassword(password, customer.passwordHash))) {
    res.status(401).json({ error: "invalid credentials" });
    return;
  }
  const c = issueSessionCookie(customer.id, customer.storeId);
  res.cookie(c.name, c.value, c.options);
  res.json({
    customer: {
      id: customer.id,
      store_id: customer.storeId,
      email: customer.email,
      name: customer.name,
      phone: customer.phone,
    },
  });
});

router.post("/auth/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

router.get("/auth/me", async (req, res) => {
  const customer = await getCurrentCustomer(req);
  if (!customer) {
    res.json({ customer: null });
    return;
  }
  res.json({
    customer: {
      id: customer.id,
      store_id: customer.storeId,
      email: customer.email,
      name: customer.name,
      phone: customer.phone,
    },
  });
});

export default router;
