import { PrismaClient } from "@prisma/client";

/**
 * The process-wide Prisma client. Reads DATABASE_URL and connects on first use. The minimal error
 * format keeps query arguments (which may hold email content) out of error messages (SECURITY §4).
 */
export const prisma = new PrismaClient({ errorFormat: "minimal" });
