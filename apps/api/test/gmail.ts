import type { PrismaClient } from "@prisma/client";
import type { EmailFixture } from "@offerbound/contracts";
import { encryptToken } from "../src/auth/crypto.js";
import { testEnv } from "./app.js";

/** A minimal fictional email fixture for FakeGmailClient. */
export function emailFixture(
  id: string,
  internalDate: string,
  over: Partial<EmailFixture> = {},
): EmailFixture {
  return {
    id,
    threadId: `thr-${id}`,
    internalDate,
    labels: ["INBOX"],
    headers: {
      from: "Recruiter <jobs@quarry.example>",
      to: ["owner@example.com"],
      subject: `Subject ${id}`,
      date: "Mon, 05 Oct 2026 10:00:00 +0000",
    },
    snippet: `Snippet ${id}`,
    bodyText: `Body of ${id}`,
    demo: true,
    expected: {
      triage: "job_related",
      category: null,
      company: null,
      role: null,
      outcome: "needs_review",
    },
    llm: { triage: null, extraction: null },
    ...over,
  };
}

/** The encryption key `testEnv()` uses. */
export function testTokenKey(): Buffer {
  const key = testEnv().tokenEncryptionKey;
  if (!key) throw new Error("test env has no token key");
  return key;
}

type ConnectionOverrides = Partial<
  Parameters<PrismaClient["gmailConnection"]["create"]>[0]["data"]
>;

/** Inserts the singleton gmail_connection row: active, tokens stored, syncing not started. */
export async function seedConnection(
  prisma: PrismaClient,
  over: ConnectionOverrides = {},
): Promise<void> {
  await prisma.gmailConnection.create({
    data: {
      id: 1,
      googleSub: "google-sub-owner",
      email: "owner@example.com",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      refreshTokenEnc: encryptToken("refresh-token-value", testTokenKey()),
      status: "active",
      backfillSince: new Date("2026-09-01"),
      ...over,
    },
  });
}

/** A connection whose owner pressed Start syncing: backfill running, started in the past. */
export async function seedStartedConnection(
  prisma: PrismaClient,
  over: ConnectionOverrides = {},
): Promise<void> {
  await seedConnection(prisma, {
    startedAt: new Date("2026-10-01T11:00:00.000Z"),
    backfillState: "running",
    ...over,
  });
}
