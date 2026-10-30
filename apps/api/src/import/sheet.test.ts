import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { localMidnightUtc } from "@offerbound/domain";
import { parseSheetCsv } from "./sheet.js";

function fixture(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)));
}

const BOM = String.fromCharCode(0xfeff);
const csv = (text: string): Buffer => Buffer.from(text, "utf8");

const HEADER = "Company,Role,Country,City / modality,Date applied,Status";

describe("parseSheetCsv", () => {
  it("finds the header row below a title row", () => {
    const { rows, errors, headerLine } = parseSheetCsv(
      csv(`Applications 2026,,,\n,,,\n${HEADER}\nAcme Example,Engineer,Mexico,Remote,,Applied\n`),
    );
    expect(headerLine).toBe(3);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ line: 4, company: "Acme Example", role: "Engineer" });
  });

  it("accepts a header cell that ends with Company and reads every column", () => {
    const { rows, errors } = parseSheetCsv(fixture("sample.csv"));
    expect(errors.map((e) => e.line)).toEqual([7, 8]);
    expect(rows[1]).toEqual({
      line: 3,
      company: "Birch Systems Example",
      role: "Platform Engineer",
      country: "Canada",
      cityModality: "Hybrid - Toronto",
      dateApplied: "2026-09-20",
      status: "interview",
      salary: "CAD 120k",
      sponsorship: "Visa sponsorship offered",
      jobLink: "https://jobs.lever.co/birchsystems/aaaa-1111",
      notes: null,
    });
  });

  it("reports a file with no Company, Role and Status header", () => {
    const result = parseSheetCsv(fixture("no-header.csv"));
    expect(result.headerLine).toBeNull();
    expect(result.rows).toEqual([]);
  });

  it("handles a UTF-8 BOM, CRLF, quoted commas, quoted newlines and blank rows", () => {
    const text = fixture("quirks.csv").toString("utf8").replace(/\n/g, "\r\n");
    const { rows, errors, headerLine } = parseSheetCsv(Buffer.from(`${BOM}${text}`, "utf8"));
    expect(errors).toEqual([]);
    expect(headerLine).toBe(3);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      line: 4,
      company: "Northwind Traders Example",
      role: "Engineer, Platform",
      salary: "USD 90,000-110,000",
      notes: "First call went well,\nsecond call booked",
    });
    // The quoted newline spans lines 4-5; the blank rows are lines 6-7.
    expect(rows[1]).toMatchObject({
      line: 8,
      company: "Contoso Labs Example",
      status: "interview",
    });
  });

  it("maps the five statuses and reports an unknown status as a row error", () => {
    const { rows, errors } = parseSheetCsv(fixture("sample.csv"));
    expect(rows.map((r) => r.status)).toEqual([
      "applied",
      "interview",
      "rejected",
      "to_research",
      "cancelled",
      "applied",
      "to_research",
    ]);
    expect(errors.find((e) => e.line === 8)?.message).toContain("On hold");
  });

  it("matches statuses ignoring case and spacing", () => {
    const { rows } = parseSheetCsv(
      csv(`${HEADER}\nA Example,R,,,,  to   RESEARCH \nB Example,R,,,,cancelled\n`),
    );
    expect(rows.map((r) => r.status)).toEqual(["to_research", "cancelled"]);
  });

  it("keeps Date applied as YYYY-MM-DD; '10/5/2026' is a row error", () => {
    const { rows, errors } = parseSheetCsv(fixture("sample.csv"));
    expect(rows[0]?.dateApplied).toBe("2026-10-05");
    expect(errors.find((e) => e.line === 7)?.message).toContain("YYYY-MM-DD");
    expect(rows.some((r) => r.company === "Fir Logistics Example")).toBe(false);
  });

  it("rejects a date that is not on the calendar", () => {
    const { rows, errors } = parseSheetCsv(csv(`${HEADER}\nA Example,R,,,2026-02-30,Applied\n`));
    expect(rows).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("reports a row without a company or role", () => {
    const { rows, errors } = parseSheetCsv(
      csv(`${HEADER}\n,Engineer,,,,Applied\nA Example,,,,,Applied\n`),
    );
    expect(rows).toEqual([]);
    expect(errors.map((e) => e.line)).toEqual([2, 3]);
  });

  it("stores Date applied 2026-10-05 as 2026-10-05T06:00:00.000Z", () => {
    const { rows } = parseSheetCsv(fixture("sample.csv"));
    const date = rows[0]?.dateApplied;
    expect(date).toBe("2026-10-05");
    expect(localMidnightUtc(date ?? "", "America/Monterrey").toISOString()).toBe(
      "2026-10-05T06:00:00.000Z",
    );
  });

  it("returns an error, not a throw, for a file that is not valid CSV", () => {
    const result = parseSheetCsv(csv(`${HEADER}\n"unterminated,Engineer,,,,Applied\n`));
    expect(result.rows).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
