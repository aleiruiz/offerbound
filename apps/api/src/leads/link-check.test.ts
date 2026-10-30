import { describe, expect, it } from "vitest";
import { checkLink } from "./link-check.js";
import { createSafeFetcher, type LinkFetcher, type Transport } from "./ssrf.js";

type Page = Partial<{
  status: number;
  finalUrl: string;
  contentType: string | null;
  body: string;
}>;

/** A fetcher that answers every URL with the same canned page and records what it was asked. */
function stubFetcher(page: Page = {}) {
  const requested: string[] = [];
  const fetch: LinkFetcher = (url) => {
    requested.push(url);
    return Promise.resolve({
      status: page.status ?? 200,
      finalUrl: page.finalUrl ?? url,
      contentType: page.contentType === undefined ? "text/html; charset=utf-8" : page.contentType,
      body: page.body ?? "<html><body><h1>Backend Engineer</h1><p>Build things.</p></body></html>",
    });
  };
  return { fetch, requested };
}

const URL_OK = "https://jobs.example/roles/backend-engineer";
const html = (inner: string) => `<html><body><main>${inner}</main></body></html>`;

describe("checkLink", () => {
  it("linkedin.com → unverifiable without any request", async () => {
    for (const url of [
      "https://www.linkedin.com/jobs/view/123456",
      "https://linkedin.com/jobs/view/123456",
      "https://de.linkedin.com/jobs/view/123456?trk=x",
      "https://WWW.LinkedIn.com/jobs/view/1",
    ]) {
      const { fetch, requested } = stubFetcher();
      expect(await checkLink(url, fetch), url).toEqual({
        verdict: "unverifiable",
        finalUrl: null,
        pageExcerpt: null,
      });
      expect(requested).toEqual([]);
    }
  });

  it("does not treat a host that merely ends in linkedin.com as LinkedIn", async () => {
    const { fetch, requested } = stubFetcher();
    expect((await checkLink("https://notlinkedin.com/jobs/1", fetch)).verdict).toBe("verified");
    expect(requested).toHaveLength(1);
  });

  it("a redirect that lands on LinkedIn → unverifiable", async () => {
    const { fetch } = stubFetcher({ finalUrl: "https://www.linkedin.com/login?session=1" });
    expect(await checkLink(URL_OK, fetch)).toEqual({
      verdict: "unverifiable",
      finalUrl: null,
      pageExcerpt: null,
    });
  });

  it("404 or 410 → dead", async () => {
    for (const status of [404, 410]) {
      const { fetch } = stubFetcher({ status, body: "" });
      expect(await checkLink(URL_OK, fetch), String(status)).toEqual({
        verdict: "dead",
        finalUrl: URL_OK,
        pageExcerpt: null,
      });
    }
  });

  it.each([
    "No longer accepting applications",
    "This job is no longer available.",
    "This position has been filled",
    "This job has expired",
    "Job not found",
    "Esta vacante ya no está disponible",
    "Vacante cerrada",
  ])("200 with the closed marker %j → dead", async (marker) => {
    const { fetch } = stubFetcher({ body: html(`<h1>Backend Engineer</h1><p>${marker}</p>`) });
    expect((await checkLink(URL_OK, fetch)).verdict).toBe("dead");
  });

  it("finds a closed marker whatever the case, entity encoding, markup split or line breaks", async () => {
    for (const body of [
      html("<p>JOB NOT FOUND</p>"),
      html("<p>Ya no est&aacute; disponible</p>"),
      html("<p>Ya no est&#225; disponible</p>"),
      html("<p>This&nbsp;position has been <b>filled</b></p>"),
      html("<p>No longer\n   accepting applications</p>"),
      html("<p>This job&nbsp;has&#32;expired</p>"),
    ]) {
      const { fetch } = stubFetcher({ body });
      expect((await checkLink(URL_OK, fetch)).verdict, body).toBe("dead");
    }
    const plain = stubFetcher({ contentType: "text/plain", body: "Vacante cerrada" });
    expect((await checkLink(URL_OK, plain.fetch)).verdict).toBe("dead");
  });

  it("ignores a marker that only appears inside a script, style or comment", async () => {
    const body = html(
      `<script>window.i18n = { notFound: "Job not found" }</script>
       <style>.x::after { content: "job not found" }</style>
       <!-- this job has expired -->
       <h1>Backend Engineer</h1>`,
    );
    const { fetch } = stubFetcher({ body });
    expect((await checkLink(URL_OK, fetch)).verdict).toBe("verified");
  });

  it("a final URL equal to the Ashby board root jobs.ashbyhq.com/quarry → dead", async () => {
    for (const finalUrl of [
      "https://jobs.ashbyhq.com/quarry",
      "https://jobs.ashbyhq.com/quarry/",
      "https://jobs.ashbyhq.com/quarry?utm_source=feed",
      "https://JOBS.ashbyhq.com/quarry#top",
    ]) {
      const { fetch } = stubFetcher({ finalUrl });
      expect(
        (await checkLink("https://jobs.ashbyhq.com/quarry/4e8a2f1c", fetch)).verdict,
        finalUrl,
      ).toBe("dead");
    }
  });

  it("treats the bare board root of other known ATS hosts as dead, and a job page there as verified", async () => {
    const roots = [
      "https://boards.greenhouse.io/quarry",
      "https://job-boards.greenhouse.io/quarry",
      "https://jobs.lever.co/quarry",
      "https://apply.workable.com/quarry/",
      "https://jobs.smartrecruiters.com/Quarry",
    ];
    for (const finalUrl of roots) {
      const { fetch } = stubFetcher({ finalUrl });
      expect((await checkLink(URL_OK, fetch)).verdict, finalUrl).toBe("dead");
    }
    const jobs = [
      "https://jobs.ashbyhq.com/quarry/4e8a2f1c-9b3d-4a6e-8c21-5d7f0a9b1e34",
      "https://boards.greenhouse.io/quarry/jobs/4012345",
      "https://job-boards.greenhouse.io/quarry/jobs/4012345",
      "https://jobs.lever.co/quarry/4e8a2f1c-9b3d-4a6e-8c21-5d7f0a9b1e34",
      "https://apply.workable.com/quarry/j/ABC123DEF4/",
      "https://jobs.smartrecruiters.com/Quarry/743999912345-backend-engineer",
      // A query that names a job is not a board root.
      "https://job-boards.greenhouse.io/quarry?gh_jid=4012345",
    ];
    for (const finalUrl of jobs) {
      const { fetch } = stubFetcher({ finalUrl });
      expect((await checkLink(URL_OK, fetch)).verdict, finalUrl).toBe("verified");
    }
  });

  it("a company page on its own domain is not a board root", async () => {
    const { fetch } = stubFetcher({ finalUrl: "https://quarry.example/careers" });
    expect((await checkLink(URL_OK, fetch)).verdict).toBe("verified");
  });

  it("200 → verified with an 8,000-character text excerpt", async () => {
    const words = "alpha beta gamma delta ".repeat(1000);
    const { fetch } = stubFetcher({ body: html(`<h1>Backend Engineer</h1><p>${words}</p>`) });
    const result = await checkLink(URL_OK, fetch);
    expect(result.verdict).toBe("verified");
    expect(result.finalUrl).toBe(URL_OK);
    expect(result.pageExcerpt).toHaveLength(8000);
    expect(result.pageExcerpt?.startsWith("Backend Engineer")).toBe(true);
    expect(result.pageExcerpt).not.toContain("<");
  });

  it("keeps a short page whole, as text, from either content type", async () => {
    const htmlPage = stubFetcher({
      body: html("<h1>Platform Engineer</h1><p>Remote, &amp; fun</p>"),
    });
    const result = await checkLink(URL_OK, htmlPage.fetch);
    expect(result.pageExcerpt).toBe("Platform Engineer\n\nRemote, & fun");
    const plain = stubFetcher({ contentType: "text/plain", body: "Plain <b>text</b> posting" });
    expect((await checkLink(URL_OK, plain.fetch)).pageExcerpt).toBe("Plain <b>text</b> posting");
  });

  it("does not split an astral character when cutting the excerpt", async () => {
    const body = html(`<p>${"a".repeat(7999)}😀 tail</p>`);
    const { fetch } = stubFetcher({ body });
    const excerpt = (await checkLink(URL_OK, fetch)).pageExcerpt ?? "";
    expect(excerpt).toHaveLength(7999);
    expect(excerpt.at(-1)).toBe("a");
  });

  it("200 with a body that is not text → verified with no excerpt", async () => {
    const { fetch } = stubFetcher({ contentType: "application/pdf", body: "" });
    expect(await checkLink(URL_OK, fetch)).toEqual({
      verdict: "verified",
      finalUrl: URL_OK,
      pageExcerpt: null,
    });
  });

  it("a timeout, 403 or 500 → unverified", async () => {
    for (const status of [403, 500, 502, 429, 301, 401]) {
      const { fetch } = stubFetcher({ status, body: "" });
      const result = await checkLink(URL_OK, fetch);
      expect(result.verdict, String(status)).toBe("unverified");
      expect(result.pageExcerpt).toBeNull();
    }
    const timeout: LinkFetcher = () => Promise.reject(new Error("timed out"));
    expect(await checkLink(URL_OK, timeout)).toEqual({
      verdict: "unverified",
      finalUrl: null,
      pageExcerpt: null,
    });
  });

  it("a malformed URL → unverified without any request", async () => {
    const { fetch, requested } = stubFetcher();
    expect((await checkLink("not a url", fetch)).verdict).toBe("unverified");
    expect(requested).toEqual([]);
  });
});

describe("checkLink with the safe fetcher", () => {
  const empty = () => (async function* () {})();
  const redirecting =
    (to: (n: number) => string): Transport =>
    (req) => {
      const n = Number(req.url.searchParams.get("n") ?? "0");
      return Promise.resolve({
        status: 302,
        headers: { location: to(n + 1) },
        body: empty(),
        close: () => undefined,
      });
    };
  const lookup = () => Promise.resolve(["93.184.216.34"]);

  it("stops after 5 redirects with unverified", async () => {
    const calls: number[] = [];
    const transport: Transport = (req) => {
      calls.push(1);
      return redirecting((n) => `https://jobs.example/hop?n=${n}`)(req);
    };
    const result = await checkLink(
      "https://jobs.example/hop",
      createSafeFetcher({ lookup, transport }),
    );
    expect(result).toEqual({ verdict: "unverified", finalUrl: null, pageExcerpt: null });
    expect(calls).toHaveLength(6);
  });

  it("a redirect into the metadata address → unverified, and the address is never requested", async () => {
    const hosts: string[] = [];
    const transport: Transport = (req) => {
      hosts.push(req.url.hostname);
      return redirecting(() => "http://169.254.169.254/latest/meta-data/")(req);
    };
    const result = await checkLink(URL_OK, createSafeFetcher({ lookup, transport }));
    expect(result.verdict).toBe("unverified");
    expect(hosts).toEqual(["jobs.example"]);
  });

  it("a host that resolves to a private address → unverified", async () => {
    const transport: Transport = () => Promise.reject(new Error("must not connect"));
    const result = await checkLink(
      URL_OK,
      createSafeFetcher({ lookup: () => Promise.resolve(["10.0.0.7"]), transport }),
    );
    expect(result.verdict).toBe("unverified");
  });
});
