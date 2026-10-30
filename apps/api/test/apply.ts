import type { PrismaClient } from "@prisma/client";
import type { Extraction, IcsEvent } from "@offerbound/contracts";

/** A confirmation from a fictional company; tests override what they exercise. */
export const BASE_EXTRACTION: Extraction = {
  category: "application_confirmation",
  confidence: 0.95,
  company: { name: "Quarry AI", websiteDomain: "quarry.example" },
  role: { title: "Platform Engineer", seniority: "senior" },
  jobUrl: null,
  contact: null,
  interview: null,
  assessment: null,
  leads: [],
  summary: "Application received",
  language: "en",
};

export const extraction = (over: Partial<Extraction> = {}): Extraction => ({
  ...BASE_EXTRACTION,
  ...over,
});

export type SeedMessage = {
  id: string;
  /** ISO instant. */
  at: string;
  state?: "extracted" | "job_related" | "discovered" | "failed" | "skipped" | "triaged_out";
  threadId?: string;
  direction?: "inbound" | "outbound";
  fromEmail?: string;
  extraction?: Extraction;
  icsEvents?: IcsEvent[] | null;
  attempts?: number;
};

/**
 * A message row in the shape the earlier stages leave: `extracted` rows carry the stored
 * extraction and every content column; other states carry only what their stage would have set.
 */
export async function seedMessage(prisma: PrismaClient, m: SeedMessage): Promise<void> {
  const state = m.state ?? "extracted";
  const e = m.extraction ?? BASE_EXTRACTION;
  const extracted = state === "extracted";
  await prisma.gmailMessage.create({
    data: {
      id: m.id,
      threadId: m.threadId ?? `thr-${m.id}`,
      internalDate: new Date(m.at),
      direction: m.direction ?? "inbound",
      labelIds: [],
      state,
      triageMethod: "rule",
      triageRule: "R4",
      attempts: m.attempts ?? 0,
      fromEmail: m.fromEmail ?? "careers@quarry.example",
      fromName: "Quarry Careers",
      toEmails: ["owner@example.com"],
      subject: `Subject of ${m.id}`,
      snippet: `Snippet of ${m.id}`,
      ...(extracted
        ? {
            bodyText: `Body of ${m.id}`,
            summary: e.summary,
            category: e.category,
            extractConfidence: e.confidence,
            extraction: e,
            ...(m.icsEvents === undefined || m.icsEvents === null
              ? {}
              : { icsEvents: m.icsEvents }),
          }
        : {}),
    },
  });
}

export const stateOf = async (prisma: PrismaClient, id: string) =>
  (await prisma.gmailMessage.findUniqueOrThrow({ where: { id } })).state;

export async function recordCounts(prisma: PrismaClient) {
  return {
    applications: await prisma.application.count(),
    companies: await prisma.company.count(),
    contacts: await prisma.contact.count(),
    leads: await prisma.lead.count(),
    interviews: await prisma.interview.count(),
    events: await prisma.event.count(),
    threadLinks: await prisma.threadLink.count(),
    reviewItems: await prisma.reviewItem.count(),
  };
}
