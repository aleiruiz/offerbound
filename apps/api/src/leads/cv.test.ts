import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError } from "../http/errors.js";
import { DOCX_MIME, extractCvText, PDF_MIME } from "./cv.js";
import { assertZipWithinLimits, ZipLimitError } from "./cv-zip.js";
import {
  buildZip,
  patchEnd,
  pdfBomb,
  withGapBeforeEnd,
  zip64RedirectZip,
  zipBomb,
} from "./cv-test-support.js";

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe("assertZipWithinLimits", () => {
  const small = (): Buffer => buildZip([{ name: "a.txt", data: Buffer.from("x") }]);

  it("accepts an ordinary zip", async () => {
    await expect(assertZipWithinLimits(small())).resolves.toBeUndefined();
    await expect(
      assertZipWithinLimits(readFileSync(new URL("./__fixtures__/cv.docx", import.meta.url))),
    ).resolves.toBeUndefined();
  });

  it("rejects an end record that under-counts the real central directory", async () => {
    // The parser would walk both records and inflate the 200 MB one.
    const hidden = buildZip([
      { name: "a.txt", data: Buffer.from("x") },
      { name: "word/document.xml", data: Buffer.alloc(200 * 1024 * 1024, 0x20) },
    ]);
    await expect(
      assertZipWithinLimits(patchEnd(hidden, { entriesOnDisk: 1, entryCount: 1 })),
    ).rejects.toBeInstanceOf(ZipLimitError);
  });

  it("rejects a zip64 redirect that hides a directory from the validator", async () => {
    // Disk number 0xFFFF makes JSZip follow the zip64 record in the comment to a directory that
    // lists a 50 MB word/document.xml; the ordinary end record shows only a tiny a.txt.
    await expect(assertZipWithinLimits(zip64RedirectZip(50 * 1024 * 1024))).rejects.toBeInstanceOf(
      ZipLimitError,
    );
  });

  it.each([
    ["disk number", { diskNumber: 1 }],
    ["disk number at its maximum", { diskNumber: 0xffff }],
    ["disk with the central directory", { diskWithCentralDir: 1 }],
    ["disk with the central directory at its maximum", { diskWithCentralDir: 0xffff }],
    ["entries on this disk at its maximum", { entriesOnDisk: 0xffff }],
    ["total entries at its maximum", { entryCount: 0xffff }],
    ["central directory size at its maximum", { centralSize: 0xffffffff }],
    ["central directory offset at its maximum", { centralOffset: 0xffffffff }],
  ])("rejects an end record with %s", async (_name, fields) => {
    await expect(assertZipWithinLimits(patchEnd(small(), fields))).rejects.toBeInstanceOf(
      ZipLimitError,
    );
  });

  it("rejects a per-disk count that differs from the total", async () => {
    await expect(
      assertZipWithinLimits(patchEnd(small(), { entriesOnDisk: 0 })),
    ).rejects.toBeInstanceOf(ZipLimitError);
  });

  it("rejects bytes between the central directory and the end record", async () => {
    await expect(
      assertZipWithinLimits(withGapBeforeEnd(small(), Buffer.from("anything"))),
    ).rejects.toBeInstanceOf(ZipLimitError);
  });
});

describe("extractCvText", () => {
  it("reads the text of a PDF", async () => {
    const text = await extractCvText(fixture("cv.pdf"), PDF_MIME);
    expect(text).toContain("Senior Platform Engineer");
    expect(text).toContain("Northwind Example");
  });

  it("reads the text of a DOCX", async () => {
    const text = await extractCvText(fixture("cv.docx"), DOCX_MIME);
    expect(text).toContain("Senior Platform Engineer");
    expect(text).toContain("Contoso Sample");
  });

  it("returns an empty string for a PDF with no text", async () => {
    expect((await extractCvText(fixture("blank.pdf"), PDF_MIME)).trim()).toBe("");
  });

  it("a PNG declared as a PDF → unsupported_file", async () => {
    const error = await rejection(extractCvText(fixture("image.png"), PDF_MIME));
    expect(error.code).toBe("unsupported_file");
    expect(error.status).toBe(422);
  });

  it("a PDF declared as a DOCX, and a DOCX declared as a PDF → unsupported_file", async () => {
    expect((await rejection(extractCvText(fixture("cv.pdf"), DOCX_MIME))).code).toBe(
      "unsupported_file",
    );
    expect((await rejection(extractCvText(fixture("cv.docx"), PDF_MIME))).code).toBe(
      "unsupported_file",
    );
  });

  it("any other MIME type is refused even when the bytes are a PDF", async () => {
    const error = await rejection(extractCvText(fixture("cv.pdf"), "application/octet-stream"));
    expect(error.code).toBe("unsupported_file");
  });

  it("a PDF header with nothing parseable behind it → unsupported_file", async () => {
    const error = await rejection(extractCvText(Buffer.from("%PDF-1.7 not really"), PDF_MIME));
    expect(error.code).toBe("unsupported_file");
  });

  it("a zip that is not a Word document → unsupported_file", async () => {
    const zipHeaderOnly = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    const error = await rejection(extractCvText(zipHeaderOnly, DOCX_MIME));
    expect(error.code).toBe("unsupported_file");
  });

  it("ignores MIME parameters and case", async () => {
    const text = await extractCvText(fixture("cv.pdf"), "Application/PDF; charset=binary");
    expect(text).toContain("Senior Platform Engineer");
  });

  it("a DOCX whose header understates its size but inflates past the cap → unsupported_file", async () => {
    const started = Date.now();
    const error = await rejection(extractCvText(zipBomb(200 * 1024 * 1024), DOCX_MIME));
    expect(error.code).toBe("unsupported_file");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("a DOCX that declares more than the cap → unsupported_file", async () => {
    const honest = buildZip([
      { name: "word/document.xml", data: Buffer.alloc(25 * 1024 * 1024, 0x20) },
    ]);
    expect((await rejection(extractCvText(honest, DOCX_MIME))).code).toBe("unsupported_file");
  });

  it("a DOCX with too many entries → unsupported_file", async () => {
    const many = buildZip(
      Array.from({ length: 1001 }, (_, i) => ({ name: `f${i}.xml`, data: Buffer.from("x") })),
    );
    expect((await rejection(extractCvText(many, DOCX_MIME))).code).toBe("unsupported_file");
  });

  it("a DOCX whose per-disk count differs from the total → unsupported_file", async () => {
    const zip = buildZip([{ name: "a.txt", data: Buffer.from("x") }]);
    const odd = patchEnd(zip, { entriesOnDisk: 0 });
    expect((await rejection(extractCvText(odd, DOCX_MIME))).code).toBe("unsupported_file");
  });

  it("a DOCX with bytes between the central directory and the end record → unsupported_file", async () => {
    const zip = buildZip([{ name: "a.txt", data: Buffer.from("x") }]);
    const gap = withGapBeforeEnd(zip, Buffer.from("hidden records could live here"));
    expect((await rejection(extractCvText(gap, DOCX_MIME))).code).toBe("unsupported_file");
  });

  it("a DOCX whose end record claims a shorter central directory → unsupported_file", async () => {
    const zip = buildZip([
      { name: "a.txt", data: Buffer.from("x") },
      { name: "b.txt", data: Buffer.from("y") },
    ]);
    const eocd = zip.length - 22;
    const size = zip.readUInt32LE(eocd + 12);
    const short = patchEnd(zip, { centralSize: size - 10 });
    expect((await rejection(extractCvText(short, DOCX_MIME))).code).toBe("unsupported_file");
  });

  it("a PDF whose stream inflates to a few hundred MB is stopped by the timeout → unsupported_file", async () => {
    const started = Date.now();
    const error = await rejection(
      extractCvText(pdfBomb(300 * 1024 * 1024), PDF_MIME, { timeoutMs: 1_500 }),
    );
    expect(error.code).toBe("unsupported_file");
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);

  it("the API keeps answering while a hostile PDF is being read", async () => {
    const pending = extractCvText(pdfBomb(300 * 1024 * 1024), PDF_MIME, { timeoutMs: 1_500 }).catch(
      () => undefined,
    );
    // A main-thread parse would starve this timer for the whole parse.
    const ticks: number[] = [];
    const timer = setInterval(() => ticks.push(Date.now()), 100);
    await pending;
    clearInterval(timer);
    const gaps = ticks.slice(1).map((t, i) => t - (ticks[i] ?? t));
    expect(Math.max(0, ...gaps)).toBeLessThan(1_000);
  }, 60_000);
});
