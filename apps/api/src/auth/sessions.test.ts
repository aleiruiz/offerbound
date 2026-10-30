import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  createSession,
  deleteSession,
  readSession,
  SESSION_COOKIE_MAX_AGE_SECONDS,
} from "./sessions.js";

type Row = {
  idHash: string;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  userAgent: string | null;
};

/** The few `session` delegate calls sessions.ts makes, over an array. */
function memoryDb() {
  const rows: Row[] = [];
  const db = {
    session: {
      create: ({ data }: { data: Omit<Row, "createdAt"> & { createdAt?: Date } }) => {
        const row: Row = { createdAt: data.lastSeenAt, ...data };
        rows.push(row);
        return Promise.resolve(row);
      },
      findUnique: ({ where }: { where: { idHash: string } }) =>
        Promise.resolve(rows.find((r) => r.idHash === where.idHash) ?? null),
      update: ({ where, data }: { where: { idHash: string }; data: Partial<Row> }) => {
        const row = rows.find((r) => r.idHash === where.idHash);
        if (!row) throw new Error("missing row");
        Object.assign(row, data);
        return Promise.resolve(row);
      },
      deleteMany: ({ where }: { where: { idHash: string } }) => {
        const before = rows.length;
        const kept = rows.filter((r) => r.idHash !== where.idHash);
        rows.splice(0, rows.length, ...kept);
        return Promise.resolve({ count: before - kept.length });
      },
    },
  };
  return { db: db as unknown as PrismaClient, rows };
}

const NOW = new Date("2026-10-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("sessions", () => {
  it("the cookie is 32 random bytes in base64url and only its SHA-256 is stored", async () => {
    const { db, rows } = memoryDb();
    const { cookieValue, expiresAt } = await createSession(db, "Mozilla", NOW);
    expect(cookieValue).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(cookieValue, "base64url")).toHaveLength(32);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idHash).toBe(createHash("sha256").update(cookieValue).digest("hex"));
    expect(JSON.stringify(rows)).not.toContain(cookieValue);
    expect(expiresAt.getTime()).toBe(NOW.getTime() + SESSION_COOKIE_MAX_AGE_SECONDS * 1000);
    expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBe(2_592_000);
  });

  it("creates a different cookie every time", async () => {
    const { db } = memoryDb();
    const a = await createSession(db, null, NOW);
    const b = await createSession(db, null, NOW);
    expect(a.cookieValue).not.toBe(b.cookieValue);
  });

  it("truncates the user agent to 200 characters and keeps null", async () => {
    const { db, rows } = memoryDb();
    await createSession(db, "x".repeat(500), NOW);
    await createSession(db, null, NOW);
    expect(rows[0]?.userAgent).toHaveLength(200);
    expect(rows[1]?.userAgent).toBeNull();
  });

  it("reads a fresh session without renewing it", async () => {
    const { db, rows } = memoryDb();
    const { cookieValue, expiresAt } = await createSession(db, null, NOW);
    const read = await readSession(db, cookieValue, new Date(NOW.getTime() + DAY));
    expect(read).toEqual({ renewedExpiresAt: null });
    expect(rows[0]?.expiresAt).toEqual(expiresAt);
  });

  it("renews a session with fewer than 7 days left to 30 days from now", async () => {
    const { db, rows } = memoryDb();
    const { cookieValue } = await createSession(db, null, NOW);
    const later = new Date(NOW.getTime() + 24 * DAY); // 6 days left
    const read = await readSession(db, cookieValue, later);
    const renewed = new Date(later.getTime() + 30 * DAY);
    expect(read).toEqual({ renewedExpiresAt: renewed });
    expect(rows[0]?.expiresAt).toEqual(renewed);
  });

  it("does not renew with exactly 7 days left", async () => {
    const { db } = memoryDb();
    const { cookieValue } = await createSession(db, null, NOW);
    const read = await readSession(db, cookieValue, new Date(NOW.getTime() + 23 * DAY));
    expect(read).toEqual({ renewedExpiresAt: null });
  });

  it("rejects and removes an expired session", async () => {
    const { db, rows } = memoryDb();
    const { cookieValue, expiresAt } = await createSession(db, null, NOW);
    expect(await readSession(db, cookieValue, expiresAt)).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it("rejects unknown and malformed cookie values", async () => {
    const { db } = memoryDb();
    await createSession(db, null, NOW);
    expect(await readSession(db, "A".repeat(43), NOW)).toBeNull();
    expect(await readSession(db, "", NOW)).toBeNull();
    expect(await readSession(db, "not a cookie value", NOW)).toBeNull();
  });

  it("deletes the session row", async () => {
    const { db, rows } = memoryDb();
    const { cookieValue } = await createSession(db, null, NOW);
    await deleteSession(db, cookieValue);
    expect(rows).toHaveLength(0);
    expect(await readSession(db, cookieValue, NOW)).toBeNull();
    await expect(deleteSession(db, cookieValue)).resolves.toBeUndefined();
  });
});
