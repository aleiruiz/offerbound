import type { Credentials } from "google-auth-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb, testPrisma } from "../../test/db.js";
import { decryptToken, encryptToken } from "../auth/crypto.js";
import {
  createGmailClientFactory,
  createPrismaConnectionStore,
  GmailAuthError,
  type GmailOAuth,
  type GmailTransport,
} from "./client.js";

const prisma = testPrisma();
const KEY = Buffer.alloc(32, 5);
const NOW = new Date("2026-10-01T12:00:00.000Z");

async function seedConnection(over: { status?: "active" | "needs_reauth" } = {}) {
  await prisma.gmailConnection.create({
    data: {
      id: 1,
      googleSub: "google-sub-owner",
      email: "owner@example.com",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      refreshTokenEnc: encryptToken("refresh-token-value", KEY),
      status: over.status ?? "active",
      backfillSince: new Date("2026-09-01"),
    },
  });
}

function factory(refresh: () => Promise<{ credentials: Credentials }>) {
  const oauth: GmailOAuth = { setCredentials: vi.fn(), refreshAccessToken: vi.fn(refresh) };
  const transport = {} as GmailTransport;
  return createGmailClientFactory({
    store: createPrismaConnectionStore(prisma),
    env: { google: { clientId: "client.example", clientSecret: "s" }, tokenEncryptionKey: KEY },
    clock: () => NOW,
    minRequestIntervalMs: 0,
    createSession: () => ({ oauth, transport }),
  });
}

beforeEach(async () => {
  await resetDb(prisma);
});

describe("the Gmail connection store", () => {
  it("stores a refreshed access token encrypted, with its expiry, on gmail_connection", async () => {
    await seedConnection();
    const expiry = NOW.getTime() + 3_600_000;
    await factory(() =>
      Promise.resolve({ credentials: { access_token: "new-access-token", expiry_date: expiry } }),
    )();
    const row = await prisma.gmailConnection.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.accessTokenEnc).not.toContain("new-access-token");
    expect(decryptToken(row.accessTokenEnc ?? "", KEY)).toBe("new-access-token");
    expect(row.accessTokenExpiresAt).toEqual(new Date(expiry));
    expect(decryptToken(row.refreshTokenEnc ?? "", KEY)).toBe("refresh-token-value");
    expect(row.status).toBe("active");
  });

  it("replaces the refresh token when Google rotates it", async () => {
    await seedConnection();
    await factory(() =>
      Promise.resolve({
        credentials: {
          access_token: "a",
          refresh_token: "rotated-refresh-value",
          expiry_date: NOW.getTime() + 3_600_000,
        },
      }),
    )();
    const row = await prisma.gmailConnection.findUniqueOrThrow({ where: { id: 1 } });
    expect(decryptToken(row.refreshTokenEnc ?? "", KEY)).toBe("rotated-refresh-value");
  });

  it("sets needs_reauth and last_sync_error on invalid_grant", async () => {
    await seedConnection();
    const rejected = Object.assign(new Error("invalid_grant"), {
      response: { status: 400, data: { error: "invalid_grant" } },
    });
    await expect(factory(() => Promise.reject(rejected))()).rejects.toBeInstanceOf(GmailAuthError);
    const row = await prisma.gmailConnection.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.status).toBe("needs_reauth");
    expect(row.lastSyncError).toMatch(/^invalid_grant/);
    expect(row.accessTokenEnc).toBeNull();
  });

  it("refuses without calling Google when the connection already needs reauth", async () => {
    await seedConnection({ status: "needs_reauth" });
    const refresh = vi.fn(() => Promise.resolve({ credentials: {} }));
    await expect(factory(refresh)()).rejects.toBeInstanceOf(GmailAuthError);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refuses when there is no connection row", async () => {
    await expect(factory(() => Promise.resolve({ credentials: {} }))()).rejects.toBeInstanceOf(
      GmailAuthError,
    );
  });

  it("a refresh that finishes after Disconnect does not store tokens back", async () => {
    await seedConnection();
    const slowRefresh = async (): Promise<{ credentials: Credentials }> => {
      // The owner presses Disconnect Gmail while the refresh is in flight.
      await prisma.gmailConnection.update({
        where: { id: 1 },
        data: {
          status: "disconnected",
          refreshTokenEnc: null,
          accessTokenEnc: null,
          accessTokenExpiresAt: null,
        },
      });
      return {
        credentials: { access_token: "late-access", expiry_date: NOW.getTime() + 3_600_000 },
      };
    };
    await factory(slowRefresh)();
    const row = await prisma.gmailConnection.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.status).toBe("disconnected");
    expect(row.accessTokenEnc).toBeNull();
    expect(row.accessTokenExpiresAt).toBeNull();
    expect(row.refreshTokenEnc).toBeNull();
  });

  it("a stale invalid_grant does not flip a reconnected row to needs_reauth", async () => {
    await seedConnection();
    const staleRejection = async (): Promise<{ credentials: Credentials }> => {
      // The owner reconnects (a new refresh token) while the old token's refresh is failing.
      await prisma.gmailConnection.update({
        where: { id: 1 },
        data: { refreshTokenEnc: encryptToken("new-refresh-value", KEY), status: "active" },
      });
      throw Object.assign(new Error("invalid_grant"), {
        response: { status: 400, data: { error: "invalid_grant" } },
      });
    };
    await expect(factory(staleRejection)()).rejects.toBeInstanceOf(GmailAuthError);
    const row = await prisma.gmailConnection.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.status).toBe("active");
    expect(row.lastSyncError).toBeNull();
    expect(decryptToken(row.refreshTokenEnc ?? "", KEY)).toBe("new-refresh-value");
  });
});
