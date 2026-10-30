import { describe, expect, it } from "vitest";
import indexHtml from "../../../index.html?raw";
import faviconDark from "../../../public/favicon-dark.svg?raw";
import favicon from "../../../public/favicon.svg?raw";
import lockupDark from "./lockup-dark.svg?raw";
import lockup from "./lockup.svg?raw";
import markDark from "./mark-dark.svg?raw";
import mark from "./mark.svg?raw";

const FILES = { favicon, faviconDark, lockup, lockupDark, mark, markDark };

describe("brand artwork", () => {
  it.each(Object.entries(FILES))(
    "%s is a static svg without scripts, references or fonts",
    (_n, svg) => {
      expect(svg.trimStart().startsWith("<svg ")).toBe(true);
      expect(svg).not.toMatch(/<script|<style|<image|<foreignObject|<use|<metadata|<!ENTITY/i);
      expect(svg).not.toMatch(/\son[a-z]+\s*=/i);
      expect(svg).not.toMatch(
        /href\s*=|url\(|@import|font|data:|https?:\/\/(?!www\.w3\.org\/2000\/svg)/i,
      );
      expect(svg).not.toMatch(/<text/i);
      expect(svg.length).toBeLessThan(10_000);
    },
  );

  it("the dark variants differ from the light ones", () => {
    expect(markDark).not.toBe(mark);
    expect(lockupDark).not.toBe(lockup);
    expect(faviconDark).not.toBe(favicon);
  });
});

describe("index.html favicon", () => {
  it("links the light favicon by default and the dark one under prefers-color-scheme: dark", () => {
    expect(indexHtml).toMatch(/<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg" \/>/);
    expect(indexHtml).toMatch(
      /href="\/favicon-dark\.svg"\s+media="\(prefers-color-scheme: dark\)"/,
    );
  });
});
