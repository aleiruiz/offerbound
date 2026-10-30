import { PrismaClient } from "@prisma/client";

let client: PrismaClient | undefined;

/** A Prisma client for tests, connected to DATABASE_URL. The same instance is reused per worker. */
export function testPrisma(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

/**
 * Empties every application table and restarts identity sequences. Tables are read from the
 * catalog, so tables added by later migrations are covered. Migration history is kept.
 */
export async function resetDb(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    select tablename from pg_tables
    where schemaname = 'public' and tablename <> '_prisma_migrations'
    order by tablename`;
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"public"."${r.tablename.replaceAll('"', '""')}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}
