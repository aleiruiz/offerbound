import { PrismaClient } from "@prisma/client";

/** The process-wide Prisma client. Reads DATABASE_URL and connects on first use. */
export const prisma = new PrismaClient();
