import type { PrismaClient } from "@prisma/client";
import type { GmailClientFactory } from "../gmail/client.js";
import { workdayApiUrl } from "../leads/link-check.js";
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

/** Every `{ jobUrl, title }` pair found anywhere in `sources` (fixture emails, lead batches). */
export function fixtureJobTitles(sources: unknown): Map<string, string> {
  const titles = new Map<string, string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.jobUrl === "string" && typeof record.title === "string") {
      titles.set(record.jobUrl, record.title);
    }
    for (const item of Object.values(record)) visit(item);
  };
  visit(sources);
  return titles;
}

/**
 * Every job link in the fixtures opens: a 200 at the address asked for, a page that names the
 * job (its title, from `titles`), or the posting as Workday's API returns it. The fictional
 * postings cannot be fetched, and a demo has no business making requests to addresses that came
 * out of data (SECURITY §8). The link check still runs; it just finds an open posting.
 */
export function fixtureLinkFetcher(titles: ReadonlyMap<string, string>): LinkFetcher {
  const byApiUrl = new Map<string, string>();
  for (const [url, title] of titles) {
    try {
      const api = workdayApiUrl(new URL(url));
      if (api !== null) byApiUrl.set(api, title);
    } catch {
      // Not a URL: never asked for.
    }
  }
  return (url) => {
    const workdayTitle = byApiUrl.get(url);
    if (workdayTitle !== undefined) {
      return Promise.resolve({
        status: 200,
        finalUrl: url,
        contentType: "application/json",
        body: JSON.stringify({
          jobPostingInfo: {
            title: workdayTitle,
            canApply: true,
            jobDescription: "<p>Open position. Apply on the company careers page.</p>",
          },
        }),
      });
    }
    const title = titles.get(url);
    return Promise.resolve({
      status: 200,
      finalUrl: url,
      contentType: "text/plain",
      body: `${title === undefined ? "" : `${title}\n\n`}Open position. Apply on the company careers page.`,
    });
  };
}

export type DemoRuntime = {
  gmail: GmailClientFactory;
  llm: FakeLlmProvider;
  fetchLink: LinkFetcher;
};

/** Reads the fixtures (`fixtures/emails`, `fixtures/leads`) and the seed's mailbox order. */
export function createDemoRuntime(prisma: PrismaClient): DemoRuntime {
  const emails = loadEmailFixtures().filter((fixture) => fixture.demo);
  const leadBatches = loadLeadBatches();
  const llm = FakeLlmProvider.fromFixtures({ emails, leadBatches, db: prisma });
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
  const fetchLink = fixtureLinkFetcher(fixtureJobTitles([emails, leadBatches]));
  return { gmail: mailbox.factory(), llm, fetchLink };
}
