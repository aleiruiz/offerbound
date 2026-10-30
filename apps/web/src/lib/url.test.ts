import { describe, expect, it } from "vitest";
import { isHttpUrl, splitLinks } from "./url";

describe("isHttpUrl", () => {
  it("accepts http and https only", () => {
    expect(isHttpUrl("https://a.example/x")).toBe(true);
    expect(isHttpUrl("http://a.example")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("data:text/html,hi")).toBe(false);
    expect(isHttpUrl("ftp://a.example")).toBe(false);
    expect(isHttpUrl("/relative")).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
  });
});

describe("splitLinks", () => {
  it("links http(s) URLs, keeps trailing punctuation as text", () => {
    expect(splitLinks("Go to https://a.example/x?y=1, then stop.")).toEqual([
      { type: "text", text: "Go to " },
      { type: "link", href: "https://a.example/x?y=1", text: "https://a.example/x?y=1" },
      { type: "text", text: ", then stop." },
    ]);
  });
  it("leaves other schemes and plain text alone", () => {
    expect(splitLinks("javascript:alert(1) ftp://x.example")).toEqual([
      { type: "text", text: "javascript:alert(1) ftp://x.example" },
    ]);
    expect(splitLinks("")).toEqual([]);
  });
});
