import { describe, expect, it } from "vitest";
import type { CompanyIndex, CompanyRef } from "./company.js";
import { groupMembers, normalizeCompanyName, resolveCompany, tokenSetJaccard } from "./company.js";

function company(id: string, name: string, extra: Partial<CompanyRef> = {}): CompanyRef {
  return {
    id,
    name,
    normalizedName: normalizeCompanyName(name),
    aliases: [],
    domains: [],
    atsSlugs: [],
    groupId: null,
    ...extra,
  };
}

const noInput = { senderEmail: null, extractedName: null, websiteDomain: null, jobUrl: null };

describe("normalizeCompanyName", () => {
  const rows: [input: string, expected: string][] = [
    ["Acme, Inc.", "acme"],
    ["Café Ñandú S.A. de C.V.", "cafe nandu"],
    ["Smith & Sons GmbH", "smith and sons"],
    ["Acme Company Inc", "acme"],
    ["Company", "company"],
    ["Kestrel S. de R.L. de C.V.", "kestrel"],
    ["  Lumen   Labs  LLC ", "lumen labs"],
    ["Quarry AI", "quarry ai"],
    ["Inc.", "inc"],
    ["Rolls-Royce Holdings plc", "rolls royce holdings"],
    ["Ａcme Ｃorp", "acme"],
    ["", ""],
    ["...", ""],
  ];
  it.each(rows)("%j → %j", (input, expected) => {
    expect(normalizeCompanyName(input)).toBe(expected);
  });

  it("is idempotent", () => {
    for (const [input] of rows) {
      const once = normalizeCompanyName(input);
      expect(normalizeCompanyName(once)).toBe(once);
    }
  });
});

describe("tokenSetJaccard", () => {
  it("scores overlap on normalised tokens", () => {
    expect(tokenSetJaccard("Quarry AI", "Quarry AI Labs")).toBeCloseTo(2 / 3, 10);
    expect(tokenSetJaccard("Acme, Inc.", "ACME")).toBe(1);
    expect(tokenSetJaccard("Acme", "Lumen")).toBe(0);
  });
  it("is 0 when either side has no tokens", () => {
    expect(tokenSetJaccard("", "")).toBe(0);
    expect(tokenSetJaccard("Acme", "...")).toBe(0);
  });
});

describe("resolveCompany", () => {
  const index: CompanyIndex = {
    companies: [
      company("c-contact", "Contact Co Labs"),
      company("c-domain", "Quarry AI", { domains: ["quarry.example"] }),
      company("c-ats", "Kestrel", { atsSlugs: ["lever:kestrel"] }),
      company("c-name", "Lumen Systems", { aliases: ["Lumen Sys"] }),
    ],
    contacts: [
      { email: "ana@contact.example", companyId: "c-contact" },
      { email: "orphan@orphan.example", companyId: null },
    ],
  };

  it("resolves by contact, then sender domain, then ATS slug, then normalised name or alias", () => {
    // 1. contact wins over a matching domain, ATS slug and name
    expect(
      resolveCompany(
        {
          senderEmail: "Ana <ANA@quarry.example>",
          extractedName: "Lumen Systems",
          websiteDomain: null,
          jobUrl: "https://jobs.lever.co/kestrel/0a1b2c3d-1111-4111-8111-111111111111",
        },
        { ...index, contacts: [{ email: "ana@quarry.example", companyId: "c-contact" }] },
      ),
    ).toEqual({ kind: "existing", companyId: "c-contact", via: "contact" });

    // 2. sender domain (subdomain resolves to the registrable domain) wins over ATS slug and name
    expect(
      resolveCompany(
        {
          senderEmail: "jobs@mail.quarry.example",
          extractedName: "Lumen Systems",
          websiteDomain: null,
          jobUrl: "https://jobs.lever.co/kestrel/0a1b2c3d-1111-4111-8111-111111111111",
        },
        index,
      ),
    ).toEqual({ kind: "existing", companyId: "c-domain", via: "domain" });

    // 3. ATS slug wins over name
    expect(
      resolveCompany(
        {
          senderEmail: "no-reply@greenhouse-mail.io",
          extractedName: "Lumen Systems",
          websiteDomain: null,
          jobUrl: "https://jobs.lever.co/Kestrel/0a1b2c3d-1111-4111-8111-111111111111",
        },
        index,
      ),
    ).toEqual({ kind: "existing", companyId: "c-ats", via: "ats_slug" });

    // 4. normalised name, then alias
    expect(resolveCompany({ ...noInput, extractedName: "LUMEN SYSTEMS, Inc." }, index)).toEqual({
      kind: "existing",
      companyId: "c-name",
      via: "name",
    });
    expect(resolveCompany({ ...noInput, extractedName: "Lumen Sys GmbH" }, index)).toEqual({
      kind: "existing",
      companyId: "c-name",
      via: "name",
    });
  });

  it("falls through a contact without a company", () => {
    expect(
      resolveCompany(
        { ...noInput, senderEmail: "orphan@orphan.example", extractedName: "Kestrel" },
        index,
      ),
    ).toEqual({ kind: "existing", companyId: "c-ats", via: "name" });
  });

  it("returns none when there is no name and nothing matched", () => {
    expect(resolveCompany(noInput, index)).toEqual({ kind: "none" });
    expect(
      resolveCompany({ ...noInput, senderEmail: "x@unknown.example", extractedName: "  " }, index),
    ).toEqual({ kind: "none" });
  });

  it("creates a new company with sender domain, website domain and ATS slug", () => {
    expect(
      resolveCompany(
        {
          senderEmail: "talent@mail.sable.example",
          extractedName: "Sable Robotics, Inc.",
          websiteDomain: "https://www.sable-robotics.example/careers",
          jobUrl: "https://jobs.ashbyhq.com/sable/1b2c3d4e-0000-4000-8000-000000000001",
        },
        index,
      ),
    ).toEqual({
      kind: "new",
      company: {
        name: "Sable Robotics, Inc.",
        normalizedName: "sable robotics",
        domains: ["sable.example", "sable-robotics.example"],
        atsSlugs: ["ashby:sable"],
        websiteDomain: "sable-robotics.example",
      },
      possibleDuplicateOf: [],
    });
  });

  it("creates a new company with no slug when the ATS URL has none", () => {
    const result = resolveCompany(
      {
        ...noInput,
        extractedName: "Caldera",
        jobUrl: "https://job-boards.greenhouse.io/embed/job_app?token=123",
      },
      index,
    );
    expect(result).toMatchObject({ kind: "new", company: { atsSlugs: [], domains: [] } });
  });

  it("never stores generic or ATS domains", () => {
    for (const senderEmail of ["ana@gmail.com", "x@greenhouse-mail.io", "jobs@linkedin.com"]) {
      const result = resolveCompany(
        { senderEmail, extractedName: "Orchid Works", websiteDomain: null, jobUrl: null },
        index,
      );
      expect(result).toMatchObject({ kind: "new", company: { domains: [], websiteDomain: null } });
    }
    // an extracted website that is a generic or ATS domain is dropped too
    for (const websiteDomain of ["gmail.com", "boards.greenhouse.io", "https://lever.co/x"]) {
      const result = resolveCompany(
        { senderEmail: null, extractedName: "Orchid Works", websiteDomain, jobUrl: null },
        index,
      );
      expect(result).toMatchObject({ kind: "new", company: { domains: [], websiteDomain: null } });
    }
  });

  it("ignores a generic sender domain when matching", () => {
    const polluted: CompanyIndex = {
      companies: [company("c-bad", "Polluted", { domains: ["gmail.com", "greenhouse.io"] })],
      contacts: [],
    };
    expect(resolveCompany({ ...noInput, senderEmail: "any@gmail.com" }, polluted)).toEqual({
      kind: "none",
    });
    expect(
      resolveCompany(
        { ...noInput, senderEmail: "x@boards.greenhouse.io", extractedName: "Other" },
        polluted,
      ),
    ).toMatchObject({ kind: "new" });
  });

  it("flags possible duplicates at Jaccard >= 0.8 or whole-word containment", () => {
    const dupIndex: CompanyIndex = {
      companies: [
        company("c-robotics", "Acme Robotics"),
        company("c-unrelated", "Lumen Systems"),
        company("c-near", "Northwind Trading Holdings Group Partners"),
        company("c-partial", "Acmeron"),
      ],
      contacts: [],
    };
    // whole-word containment: "Acme" inside "Acme Robotics"
    expect(resolveCompany({ ...noInput, extractedName: "Acme" }, dupIndex)).toMatchObject({
      kind: "new",
      possibleDuplicateOf: ["c-robotics"],
    });
    // the other direction
    expect(
      resolveCompany({ ...noInput, extractedName: "The Acme Robotics Group" }, dupIndex),
    ).toMatchObject({ kind: "new", possibleDuplicateOf: ["c-robotics"] });
    // Jaccard 4/5 = 0.8 without containment (word order differs)
    expect(
      resolveCompany({ ...noInput, extractedName: "Group Northwind Holdings Trading" }, dupIndex),
    ).toMatchObject({ kind: "new", possibleDuplicateOf: ["c-near"] });
    // Jaccard 3/5 = 0.6 stays below the threshold
    expect(
      resolveCompany({ ...noInput, extractedName: "Group Northwind Holdings" }, dupIndex),
    ).toMatchObject({ kind: "new", possibleDuplicateOf: [] });
    // substring that is not a whole word does not count
    expect(resolveCompany({ ...noInput, extractedName: "Acme Rob" }, dupIndex)).toMatchObject({
      kind: "new",
      possibleDuplicateOf: [],
    });
  });
});

describe("groupMembers", () => {
  const companies = [
    company("root", "Acme Holding"),
    company("child-1", "Acme Robotics", { groupId: "root" }),
    company("child-2", "Acme Labs", { groupId: "root" }),
    company("other-root", "Lumen"),
    company("other-child", "Lumen Systems", { groupId: "other-root" }),
    company("alone", "Sable"),
  ];

  it("returns every company that shares the root", () => {
    const expected = new Set(["root", "child-1", "child-2"]);
    expect(groupMembers("root", companies)).toEqual(expected);
    expect(groupMembers("child-1", companies)).toEqual(expected);
    expect(groupMembers("child-2", companies)).toEqual(expected);
    expect(groupMembers("other-child", companies)).toEqual(new Set(["other-root", "other-child"]));
  });

  it("returns just the company when it has no group", () => {
    expect(groupMembers("alone", companies)).toEqual(new Set(["alone"]));
  });

  it("returns the id itself when the company is unknown", () => {
    expect(groupMembers("missing", companies)).toEqual(new Set(["missing"]));
  });
});
