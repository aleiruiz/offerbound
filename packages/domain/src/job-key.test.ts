import { describe, expect, it } from "vitest";
import { atsSlug, jobKey } from "./job-key.js";

const ASHBY = "1b2c3d4e-0000-4000-8000-000000000001";
const LEVER = "0a1b2c3d-1111-4111-8111-111111111111";

const keyRows: [input: string, expected: string | null][] = [
  [`https://jobs.ashbyhq.com/quarry/${ASHBY}/application?utm_source=li`, `ashby:quarry:${ASHBY}`],
  [`https://jobs.lever.co/kestrel/${LEVER}/apply?lever-source=x`, `lever:kestrel:${LEVER}`],
  ["https://boards.greenhouse.io/lumen/jobs/4012345?gh_src=abc", "greenhouse:lumen:4012345"],
  ["https://job-boards.greenhouse.io/lumen/jobs/4012345", "greenhouse:lumen:4012345"],
  ["https://careers.lumen.example/open?gh_jid=4012345", "greenhouse:careers.lumen.example:4012345"],
  [
    "https://acme.wd5.myworkdayjobs.com/en-US/External/job/Remote-Mexico/Senior-Engineer_R-12345",
    "workday:acme:R-12345",
  ],
  ["https://sable.jobs.personio.de/job/998877?language=en", "personio:sable:998877"],
  [
    "https://jobs.smartrecruiters.com/Northwind/743999000123-senior-engineer",
    "smartrecruiters:northwind:743999000123",
  ],
  ["https://apply.workable.com/caldera/j/AB12CD34EF/", "workable:caldera:AB12CD34EF"],
  [
    "https://www.linkedin.com/comm/jobs/view/4020000001/?trackingId=x&refId=y",
    "linkedin:4020000001",
  ],
  ["https://www.linkedin.com/jobs/search/?currentJobId=4020000002", "linkedin:4020000002"],
  ["https://mx.indeed.com/viewjob?jk=abc123def&from=serp", "indeed:abc123def"],
  [
    "https://www.Quarry.example/careers/123/?utm_campaign=z#apply",
    "url:quarry.example/careers/123",
  ],
  ["mailto:jobs@quarry.example", null],
];

const edgeRows: [name: string, input: string, expected: string | null][] = [
  ["empty string", "", null],
  ["not a URL", "not a url", null],
  ["ftp", "ftp://jobs.lever.co/kestrel/x", null],
  ["javascript", "javascript:alert(1)", null],
  [
    "surrounding whitespace",
    `  https://jobs.lever.co/Kestrel/${LEVER.toUpperCase()}  `,
    `lever:kestrel:${LEVER}`,
  ],
  ["org is lower-cased", `https://JOBS.ASHBYHQ.COM/Quarry/${ASHBY}`, `ashby:quarry:${ASHBY}`],
  ["eu lever host", `https://jobs.eu.lever.co/kestrel/${LEVER}`, `lever:kestrel:${LEVER}`],
  ["ashby board root has no job", "https://jobs.ashbyhq.com/quarry", "url:jobs.ashbyhq.com/quarry"],
  [
    "ashby non-uuid segment",
    "https://jobs.ashbyhq.com/quarry/embed",
    "url:jobs.ashbyhq.com/quarry/embed",
  ],
  [
    "greenhouse company on a www host",
    "https://www.lumen.example/jobs?gh_jid=77&utm_source=x",
    "greenhouse:lumen.example:77",
  ],
  [
    "greenhouse path beats gh_jid",
    "https://boards.greenhouse.io/lumen/jobs/1?gh_jid=2",
    "greenhouse:lumen:1",
  ],
  [
    "gh_jid must be numeric",
    "https://careers.lumen.example/open?gh_jid=abc",
    "url:careers.lumen.example/open",
  ],
  [
    "workday apply suffix",
    "https://Acme.wd1.myworkdayjobs.com/External/job/Austin/Data-Lead_JR-9/apply",
    "workday:acme:JR-9",
  ],
  [
    "workday without a req id",
    "https://acme.wd5.myworkdayjobs.com/en-US/External",
    "url:acme.wd5.myworkdayjobs.com/en-US/External",
  ],
  ["personio .com", "https://sable.jobs.personio.com/job/5", "personio:sable:5"],
  [
    "smartrecruiters bare id",
    "https://jobs.smartrecruiters.com/Northwind/743999000123",
    "smartrecruiters:northwind:743999000123",
  ],
  [
    "workable keeps code case",
    "https://apply.workable.com/Caldera/j/ab12CD/apply",
    "workable:caldera:ab12CD",
  ],
  [
    "linkedin slug-id path",
    "https://www.linkedin.com/jobs/view/senior-engineer-at-quarry-4020000003?refId=1",
    "linkedin:4020000003",
  ],
  ["linkedin country host", "https://mx.linkedin.com/jobs/view/4020000004", "linkedin:4020000004"],
  [
    "linkedin without an id",
    "https://www.linkedin.com/jobs/search/?keywords=engineer",
    "url:linkedin.com/jobs/search",
  ],
  [
    "linkedin non-numeric currentJobId",
    "https://www.linkedin.com/jobs/?currentJobId=abc",
    "url:linkedin.com/jobs",
  ],
  ["indeed without jk", "https://www.indeed.com/jobs?q=engineer", "url:indeed.com/jobs"],
  ["root path", "https://Quarry.example/", "url:quarry.example"],
  ["host only", "https://quarry.example", "url:quarry.example"],
  [
    "duplicate slashes and trailing slash",
    "https://quarry.example//careers//1//",
    "url:quarry.example/careers/1",
  ],
  [
    "path case is kept",
    "https://quarry.example/Careers/Senior-Engineer",
    "url:quarry.example/Careers/Senior-Engineer",
  ],
  [
    "tracking parameters are dropped",
    "https://quarry.example/c/1?utm_medium=a&gh_src=b&lever-source=c&source=d&ref=e&refId=f&trk=g&trackingId=h&src=i",
    "url:quarry.example/c/1",
  ],
  [
    "known id parameters are kept, sorted",
    "https://quarry.example/open?utm_source=x&jid=7&id=3&other=1",
    "url:quarry.example/open?id=3&jid=7",
  ],
  ["fragment is dropped", "http://quarry.example/c/1#apply", "url:quarry.example/c/1"],
];

const fixRows: [name: string, input: string, expected: string | null][] = [
  [
    "smartrecruiters slug without an id",
    "https://jobs.smartrecruiters.com/Northwind/senior-engineer",
    "url:jobs.smartrecruiters.com/Northwind/senior-engineer",
  ],
  [
    "smartrecruiters other slug stays distinct",
    "https://jobs.smartrecruiters.com/Northwind/senior-designer",
    "url:jobs.smartrecruiters.com/Northwind/senior-designer",
  ],
  [
    "smartrecruiters oneclick-ui is not an org",
    "https://jobs.smartrecruiters.com/oneclick-ui/company/Northwind/publication/abc",
    "url:jobs.smartrecruiters.com/oneclick-ui/company/Northwind/publication/abc",
  ],
  [
    "greenhouse host with gh_jid uses the org",
    "https://boards.greenhouse.io/Lumen?gh_jid=4012345",
    "greenhouse:lumen:4012345",
  ],
  [
    "greenhouse job-boards host with gh_jid uses the org",
    "https://job-boards.greenhouse.io/lumen/other?gh_jid=4012345",
    "greenhouse:lumen:4012345",
  ],
  [
    "greenhouse embed uses for=",
    "https://boards.greenhouse.io/embed/job_app?for=Lumen&gh_jid=4012345",
    "greenhouse:lumen:4012345",
  ],
  [
    "greenhouse embed without for= falls back to the host",
    "https://boards.greenhouse.io/embed/job_app?gh_jid=4012345",
    "greenhouse:boards.greenhouse.io:4012345",
  ],
  [
    "workday underscore outside the job part",
    "https://acme.wd5.myworkdayjobs.com/External_Careers/job/Austin/Data-Lead",
    "url:acme.wd5.myworkdayjobs.com/External_Careers/job/Austin/Data-Lead",
  ],
  [
    "workday needs a job segment",
    "https://acme.wd5.myworkdayjobs.com/External/Data-Lead_R-1",
    "url:acme.wd5.myworkdayjobs.com/External/Data-Lead_R-1",
  ],
  [
    "linkedin bare numeric path is not a job",
    "https://www.linkedin.com/4020000001",
    "url:linkedin.com/4020000001",
  ],
  [
    "linkedin view slug without an id",
    "https://www.linkedin.com/jobs/view/python3",
    "url:linkedin.com/jobs/view/python3",
  ],
];

describe("jobKey", () => {
  it.each(fixRows)("%s", (_name, input, expected) => {
    expect(jobKey(input)).toBe(expected);
  });

  it.each(keyRows)("%s -> %s", (input, expected) => {
    expect(jobKey(input)).toBe(expected);
  });

  it.each(edgeRows)("%s", (_name, input, expected) => {
    expect(jobKey(input)).toBe(expected);
  });

  it("gives the same key for the same posting on different URLs", () => {
    expect(jobKey(`https://jobs.lever.co/kestrel/${LEVER}`)).toBe(
      jobKey(`https://jobs.lever.co/kestrel/${LEVER}/apply?lever-source=linkedin&utm_source=x`),
    );
  });
});

describe("atsSlug", () => {
  it.each<[string, string | null]>([
    ["https://jobs.ashbyhq.com/quarry/…", "ashby:quarry"],
    ["https://pinecrest.recruitee.com/o/frontend", "recruitee:pinecrest"],
    ["https://kittiwake.teamtailor.com/jobs/1", "teamtailor:kittiwake"],
    ["https://quarry.example/jobs/1", null],
    [`https://jobs.lever.co/Kestrel/${LEVER}`, "lever:kestrel"],
    ["https://boards.greenhouse.io/Lumen/jobs/4012345", "greenhouse:lumen"],
    ["https://boards.greenhouse.io/embed/job_app?for=Lumen&token=1", "greenhouse:lumen"],
    ["https://boards.greenhouse.io/embed/job_app?token=1", null],
    ["https://jobs.smartrecruiters.com/oneclick-ui/company/Northwind/publication/abc", null],
    ["https://job-boards.greenhouse.io/lumen", "greenhouse:lumen"],
    ["https://acme.wd5.myworkdayjobs.com/en-US/External", "workday:acme"],
    ["https://sable.jobs.personio.de/job/998877", "personio:sable"],
    ["https://jobs.smartrecruiters.com/Northwind/743999000123-x", "smartrecruiters:northwind"],
    ["https://apply.workable.com/caldera/j/AB12CD34EF/", "workable:caldera"],
    ["https://careers.lumen.example/open?gh_jid=4012345", null],
    ["https://www.recruitee.com/pricing", null],
    ["https://jobs.ashbyhq.com/", null],
    ["https://www.linkedin.com/jobs/view/4020000001", null],
    ["mailto:jobs@quarry.example", null],
    ["not a url", null],
  ])("%s -> %s", (input, expected) => {
    expect(atsSlug(input)).toBe(expected);
  });
});
