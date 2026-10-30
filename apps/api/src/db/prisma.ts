import { PrismaClient } from "@prisma/client";

/**
 * Creates a Prisma client. The minimal error format keeps query arguments (which may hold email
 * content) out of error messages (SECURITY §4). Without an argument it reads DATABASE_URL.
 */
export function createPrisma(databaseUrl?: string): PrismaClient {
  return new PrismaClient({
    errorFormat: "minimal",
    ...(databaseUrl ? { datasourceUrl: databaseUrl } : {}),
  });
}

/** The process-wide Prisma client. Connects on first use. */
export const prisma = createPrisma();
