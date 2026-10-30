import { createHash, randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export const SESSION_COOKIE_NAME = "ob_session";
/** 30 days (TECHNICAL_SPEC §4). */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
/** A session with less than this left is renewed (AC-1.4). */
const RENEW_BELOW_MS = 7 * 24 * 60 * 60 * 1000;
const USER_AGENT_MAX_CHARS = 200;
/** Do not rewrite `last_seen_at` more often than this. */
const LAST_SEEN_GRANULARITY_MS = 5 * 60 * 1000;
const COOKIE_VALUE = /^[A-Za-z0-9_-]{43}$/;

function hashOf(cookieValue: string): string {
  return createHash("sha256").update(cookieValue).digest("hex");
}

function expiryFrom(now: Date): Date {
  return new Date(now.getTime() + SESSION_COOKIE_MAX_AGE_SECONDS * 1000);
}

/**
 * Creates a session. The cookie value is 32 random bytes in base64url and exists only in the
 * browser; the table keeps its SHA-256, so a database leak cannot be replayed as a cookie.
 */
export async function createSession(
  db: Db,
  userAgent: string | null,
  now: Date,
): Promise<{ cookieValue: string; expiresAt: Date }> {
  const cookieValue = randomBytes(32).toString("base64url");
  const expiresAt = expiryFrom(now);
  await db.session.create({
    data: {
      idHash: hashOf(cookieValue),
      createdAt: now,
      expiresAt,
      lastSeenAt: now,
      userAgent: userAgent === null ? null : userAgent.slice(0, USER_AGENT_MAX_CHARS),
    },
  });
  return { cookieValue, expiresAt };
}

/**
 * Looks a session up. Returns null for an unknown, malformed or expired one (expired rows are
 * removed). When fewer than 7 days remain the expiry moves to 30 days from now and
 * `renewedExpiresAt` carries it, so the caller can re-send the cookie.
 */
export async function readSession(
  db: Db,
  cookieValue: string,
  now: Date,
): Promise<{ renewedExpiresAt: Date | null } | null> {
  if (!COOKIE_VALUE.test(cookieValue)) return null;
  const idHash = hashOf(cookieValue);
  const row = await db.session.findUnique({ where: { idHash } });
  if (!row) return null;
  if (row.expiresAt.getTime() <= now.getTime()) {
    await db.session.deleteMany({ where: { idHash } });
    return null;
  }

  try {
    if (row.expiresAt.getTime() - now.getTime() < RENEW_BELOW_MS) {
      const renewedExpiresAt = expiryFrom(now);
      await db.session.update({
        where: { idHash },
        data: { expiresAt: renewedExpiresAt, lastSeenAt: now },
      });
      return { renewedExpiresAt };
    }

    if (now.getTime() - row.lastSeenAt.getTime() >= LAST_SEEN_GRANULARITY_MS) {
      await db.session.update({ where: { idHash }, data: { lastSeenAt: now } });
    }
  } catch (error) {
    // Deleted between the read and the update (logout in another tab): no session.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return null;
    }
    throw error;
  }
  return { renewedExpiresAt: null };
}

/** Deletes the session if it exists; unknown values are ignored. */
export async function deleteSession(db: Db, cookieValue: string): Promise<void> {
  if (!COOKIE_VALUE.test(cookieValue)) return;
  await db.session.deleteMany({ where: { idHash: hashOf(cookieValue) } });
}
