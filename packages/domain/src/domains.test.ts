import { describe, expect, it } from "vitest";
import {
  ATS_DOMAINS,
  GENERIC_MAILBOX_DOMAINS,
  JOB_ALERT_SENDERS,
  JOB_BOARD_DOMAINS,
  isAtsSender,
  registrableDomain,
} from "./domains.js";

describe("registrableDomain", () => {
  it.each([
    ["ana@mail.quarry.example", "quarry.example"],
    ["quarry.example", "quarry.example"],
    ["careers.mail.quarry.example", "quarry.example"],
    ["Ana <ana@Mail.Quarry.Example>", "quarry.example"],
    ["jo@dept.example.co.uk", "example.co.uk"],
    ["x@ats.rippling.com", "rippling.com"],
    ["", null],
    ["not an address", null],
    ["a@", null],
  ])("%s -> %s", (input, expected) => {
    expect(registrableDomain(input)).toBe(expected);
  });
});

describe("isAtsSender", () => {
  it.each([
    ["noreply@greenhouse-mail.io", true],
    ["no-reply@us.greenhouse-mail.io", true],
    ["jobs@lever.co", true],
    ["x@ats.rippling.com", true],
    ["x@rippling.com", false],
    ["x@mail.rippling.com", false],
    ["x@notgreenhouse.io", false],
    ["ana@quarry.example", false],
    ["ana@gmail.com", false],
  ])("%s -> %s", (email, expected) => {
    expect(isAtsSender(email)).toBe(expected);
  });
});

describe("domain lists", () => {
  it("ATS list matches the spec", () => {
    expect(ATS_DOMAINS).toEqual([
      "greenhouse.io",
      "greenhouse-mail.io",
      "lever.co",
      "ashbyhq.com",
      "myworkday.com",
      "myworkdayjobs.com",
      "smartrecruiters.com",
      "workable.com",
      "workablemail.com",
      "personio.com",
      "personio.de",
      "icims.com",
      "jobvite.com",
      "bamboohr.com",
      "recruitee.com",
      "teamtailor.com",
      "hirehive.com",
      "successfactors.com",
      "taleo.net",
      "breezy.hr",
      "pinpointhq.com",
      "rippling.com",
      "dover.com",
      "gem.com",
    ]);
  });

  it("job-alert senders match the spec", () => {
    expect(JOB_ALERT_SENDERS).toEqual([
      "jobalerts-noreply@linkedin.com",
      "jobs-noreply@linkedin.com",
      "jobs-listings@linkedin.com",
      "alert@indeed.com",
      "noreply@indeed.com",
      "noreply@glassdoor.com",
      "alerts@glassdoor.com",
      "noreply@wellfound.com",
      "talent@otta.com",
      "noreply@welcometothejungle.com",
    ]);
  });

  it("generic mailbox domains match the spec", () => {
    expect(GENERIC_MAILBOX_DOMAINS).toEqual([
      "gmail.com",
      "googlemail.com",
      "outlook.com",
      "hotmail.com",
      "live.com",
      "yahoo.com",
      "icloud.com",
      "proton.me",
      "protonmail.com",
    ]);
  });

  it("job boards match the plan", () => {
    expect(JOB_BOARD_DOMAINS).toEqual([
      "linkedin.com",
      "indeed.com",
      "glassdoor.com",
      "wellfound.com",
      "otta.com",
      "welcometothejungle.com",
    ]);
  });
});
