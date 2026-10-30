import { describe, expect, it } from "vitest";
import { stripQuotedHistory } from "./dequote.js";

describe("stripQuotedHistory", () => {
  it("cuts at 'On Tue, Oct 27, 2026 at 10:00 AM Ana Ruiz <ana@quarry.example> wrote:'", () => {
    const text = [
      "Thanks, Thursday works for me.",
      "",
      "On Tue, Oct 27, 2026 at 10:00 AM Ana Ruiz <ana@quarry.example> wrote:",
      "Can you do Thursday?",
    ].join("\n");
    expect(stripQuotedHistory(text)).toBe("Thanks, Thursday works for me.");
  });

  it("cuts when the attribution line is wrapped onto two lines", () => {
    const text = [
      "Sounds good.",
      "",
      "On Tue, Oct 27, 2026 at 10:00 AM Ana Ruiz",
      "<ana@quarry.example> wrote:",
      "Old text",
    ].join("\n");
    expect(stripQuotedHistory(text)).toBe("Sounds good.");
  });

  it("cuts at 'El mar, 27 oct 2026 a las 10:00, Ana Ruiz <ana@quarry.example> escribió:'", () => {
    const text = [
      "Gracias, el jueves me viene bien.",
      "",
      "El mar, 27 oct 2026 a las 10:00, Ana Ruiz <ana@quarry.example> escribió:",
      "¿Puedes el jueves?",
    ].join("\n");
    expect(stripQuotedHistory(text)).toBe("Gracias, el jueves me viene bien.");
  });

  it("cuts at '-----Original Message-----' and at 'From: …' after a blank line, but not at a From: on the first line", () => {
    expect(stripQuotedHistory("Reply\n\n-----Original Message-----\nFrom: x\nold")).toBe("Reply");
    expect(
      stripQuotedHistory("Reply\n\nFrom: Ana Ruiz <ana@quarry.example>\nSent: Monday\nold"),
    ).toBe("Reply");
    expect(stripQuotedHistory("From: Ana Ruiz <ana@quarry.example>\nHello there")).toBe(
      "From: Ana Ruiz <ana@quarry.example>\nHello there",
    );
    // a From: line glued to the previous paragraph is not a header block
    expect(stripQuotedHistory("Reply\nFrom: the team at Quarry\nmore")).toBe(
      "Reply\nFrom: the team at Quarry\nmore",
    );
  });

  it("cuts at a run of lines starting with '>'", () => {
    const text = [
      "Looks good.",
      "",
      "> earlier line one",
      "> earlier line two",
      ">",
      "",
      "Best, Sam",
    ].join("\n");
    expect(stripQuotedHistory(text)).toBe("Looks good.");
  });

  it("cuts at 'El … ha escrito:'", () => {
    const text =
      "Perfecto.\n\nEl mar, 27 oct 2026, Ana Ruiz <ana@quarry.example> ha escrito:\n> hola";
    expect(stripQuotedHistory(text)).toBe("Perfecto.");
  });

  it("does not cut at an ordinary sentence that starts with On or El", () => {
    const text = "On Monday we wrote: nothing.\nEl lunes escribió algo";
    expect(stripQuotedHistory(text)).toBe(text);
  });

  it("collapses whitespace", () => {
    const text = "Hi  there,\r\n\r\n\r\n\r\n   spaced \t out   ​\r\nbye   \n";
    expect(stripQuotedHistory(text)).toBe("Hi there,\n\nspaced out\nbye");
  });

  it("truncates the result to 15,000 characters", () => {
    const out = stripQuotedHistory("a".repeat(20_000));
    expect(out).toHaveLength(15_000);
  });

  it("does not leave half a surrogate pair at the cut", () => {
    const out = stripQuotedHistory("a".repeat(14_999) + "😀😀");
    expect(out).toBe("a".repeat(14_999));
  });

  it("returns an empty string for empty or whitespace-only input", () => {
    expect(stripQuotedHistory("")).toBe("");
    expect(stripQuotedHistory("  \n\n ")).toBe("");
  });

  it("stays fast on a very long single line", () => {
    const started = Date.now();
    stripQuotedHistory("On " + "wrote: ".repeat(200_000));
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("stays fast on adversarial lines", () => {
    const started = Date.now();
    stripQuotedHistory("On " + " ".repeat(200_000));
    stripQuotedHistory(("El " + "a ".repeat(150) + "\n").repeat(5_000));
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
