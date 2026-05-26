import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Request } from "express";
import { prisma } from "./prisma";

const SESSION_COOKIE = "souq_session";
const SESSION_DAYS = 30;

function getSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "JWT_SECRET env var is missing or too short. Generate a strong random string (32+ chars) and set it on Railway."
    );
  }
  return s;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

interface SessionPayload {
  sub: string;     // customer id
  store: string;   // store id this customer belongs to
}

export function issueSessionCookie(customerId: string, storeId: string) {
  const payload: SessionPayload = { sub: customerId, store: storeId };
  const token = jwt.sign(payload, getSecret(), { expiresIn: `${SESSION_DAYS}d` });
  return {
    name: SESSION_COOKIE,
    value: token,
    options: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax" as const,
      maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
      path: "/",
    },
  };
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;

export async function getCurrentCustomer(req: Request) {
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[
    SESSION_COOKIE
  ];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, getSecret()) as Partial<SessionPayload>;
    if (!payload.sub || !payload.store) return null;
    const customer = await prisma.customer.findUnique({ where: { id: payload.sub } });
    // Defensive: ensure the JWT's store claim still matches the customer's store
    // (cheap guard against a token issued before a customer was re-keyed).
    if (!customer || customer.storeId !== payload.store) return null;
    return customer;
  } catch {
    return null;
  }
}
