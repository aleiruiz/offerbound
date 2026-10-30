import { describe, expect, it, vi } from "vitest";
import type { LinkFetcher } from "./ssrf.js";

vi.mock("html-to-text", () => ({
  convert: () => {
    throw new RangeError("Maximum call stack size exceeded");
  },
}));

const { checkLink } = await import("./link-check.js");

describe("checkLink when the HTML converter fails", () => {
  it("returns unverified instead of rejecting", async () => {
    const fetch: LinkFetcher = (url) =>
      Promise.resolve({
        status: 200,
        finalUrl: url,
        contentType: "text/html",
        body: "<html><body>Backend Engineer</body></html>",
      });
    expect(await checkLink("https://jobs.example/roles/1", fetch)).toEqual({
      verdict: "unverified",
      finalUrl: "https://jobs.example/roles/1",
      pageExcerpt: null,
    });
  });
});
