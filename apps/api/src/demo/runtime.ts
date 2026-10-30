import type { PrismaClient } from "@prisma/client";
import type { GmailClientFactory } from "../gmail/client.js";
import type { LinkFetcher } from "../leads/ssrf.js";
import { loadEmailFixtures } from "../fixtures/emails.js";
import { loadLeadBatches } from "../fixtures/leads.js";
import { FakeLlmProvider } from "../llm/fake-provider.js";
import { FakeMailbox } from "./fake-mailbox.js";
import { loadSeed } from "./seed.js";

/**
 * The demo's stand-ins for everything outside the process (TECHNICAL_SPEC §12). Nothing here
 * reaches the network: the mailbox and the model replay fixtures, and the link check is answered
 * locally.
 */

/**
 * Every job link in the demo opens: a fixed page, a 200 at the address asked for. The fictional
 * postings cannot be fetched, and a demo has no business making requests to addresses that came
 * out of data (SECURITY §8). The link check still runs; it just finds an open posting.
 */
export const demoLinkFetcher: LinkFetcher = (url) =>
  Promise.resolve({
    status: 200,
    finalUrl: url,
    contentType: "text/plain",
    body: "Open position. Apply on the company careers page.",
  });

export type DemoRuntime = {
  gmail: GmailClientFactory;
  llm: FakeLlmProvider;
  fetchLink: LinkFetcher;
};

/** Reads the fixtures (`fixtures/emails`, `fixtures/leads`) and the seed's mailbox order. */
export function createDemoRuntime(prisma: PrismaClient): DemoRuntime {
  const emails = loadEmailFixtures().filter((fixture) => fixture.demo);
  const llm = FakeLlmProvider.fromFixtures({ emails, leadBatches: loadLeadBatches(), db: prisma });
  const mailbox = new FakeMailbox(emails, loadSeed().mailbox.order, {
    // A message the database holds arrived when its `internal_date` says. Sync leaves the epoch
    // until triage has read the message; that is "not known yet".
    arrivalOf: async (id) => {
      const row = await prisma.gmailMessage.findUnique({
        where: { id },
        select: { internalDate: true },
      });
      return row === null || row.internalDate.getTime() <= 0 ? null : row.internalDate;
    },
    // The model answers for a delivery with what the fixture says, moved to its arrival.
    onDeliver: (fixture) => {
      if (fixture.llm.triage !== null) {
        llm.register("triage", { messageId: fixture.id }, fixture.llm.triage);
      }
      if (fixture.llm.extraction !== null) {
        llm.register("extract", { messageId: fixture.id }, fixture.llm.extraction);
      }
    },
  });
  return { gmail: mailbox.factory(), llm, fetchLink: demoLinkFetcher };
}
