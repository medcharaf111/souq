import { PrismaClient, Prisma } from "@prisma/client";

// Connection-level errors worth retrying. P1001 = can't reach DB server,
// P1017 = server closed the connection. These spike briefly when the Railway
// container restarts (redeploys) before the private network re-resolves
// postgres.railway.internal. Logic/validation errors are NOT retried.
const RETRYABLE_CODES = new Set(["P1001", "P1017"]);

function isRetryable(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientInitializationError) return true;
  const code = (e as { code?: string })?.code;
  return code != null && RETRYABLE_CODES.has(code);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeClient() {
  const base = new PrismaClient();
  // Auto-retry every query a few times on transient connection failures.
  return base.$extends({
    query: {
      async $allOperations({ args, query }) {
        let lastErr: unknown;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            return await query(args);
          } catch (e) {
            if (!isRetryable(e)) throw e;
            lastErr = e;
            await sleep(250 * (attempt + 1)); // 250ms, 500ms, 750ms backoff
          }
        }
        throw lastErr;
      },
    },
  });
}

type ExtendedClient = ReturnType<typeof makeClient>;

const g = globalThis as unknown as { prisma?: ExtendedClient };
export const prisma: ExtendedClient = g.prisma ?? makeClient();
if (process.env.NODE_ENV !== "production") g.prisma = prisma;
