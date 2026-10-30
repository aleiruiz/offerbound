import fs from "node:fs";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiErrorBodySchema,
  CvProfileSchema,
  CvUploadFailedSchema,
  type CvProfile,
} from "@offerbound/contracts";
import { FakeLlmProvider } from "../llm/fake-provider.js";
import { LlmError } from "../llm/provider.js";
import { buildTestApp, signIn, testEnv } from "../../test/app.js";
import { resetDb, testPrisma } from "../../test/db.js";
import { DOCX_MIME, extractCvText, PDF_MIME } from "./cv.js";
import { zipBomb } from "./cv-test-support.js";

const prisma = testPrisma();
const CSRF = { "x-offerbound-request": "1" };
const fixture = (name: string): Buffer =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));

const PROFILE: CvProfile = {
  headline: "Senior platform engineer",
  yearsExperience: 9,
  coreSkills: ["TypeScript", "Kubernetes"],
  secondarySkills: ["Go"],
  domains: ["developer tooling"],
  recentRoles: [{ title: "Staff Platform Engineer", company: "Northwind Example", years: "4" }],
  leadership: "Led a team of five",
  languages: ["English", "Spanish"],
  location: "Springfield, Exampleland",
  workAuthorization: null,
};

function multipart(
  filename: string,
  mime: string,
  content: Buffer,
  field = "file",
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----offerbound-test-boundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, content, tail]),
    headers: { ...CSRF, "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

let app: FastifyInstance;
let cookie: string;
let llm: FakeLlmProvider;
let logged: string[];

beforeEach(async () => {
  await resetDb(prisma);
  llm = FakeLlmProvider.fromFixtures({ emails: [], leadBatches: [] });
  logged = [];
  const logStream = new Writable({
    write(chunk: Buffer, _enc, done) {
      logged.push(chunk.toString());
      done();
    },
  });
  const built = await buildTestApp({ llm, env: testEnv({ LOG_LEVEL: "debug" }) }, { logStream });
  app = built.app;
  cookie = await signIn(app, built.deps);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function upload(name: string, mime: string, content: Buffer, field = "file") {
  const { payload, headers } = multipart(name, mime, content, field);
  return app.inject({
    method: "POST",
    url: "/api/v1/cv",
    headers: { ...headers, cookie },
    payload,
  });
}

async function registerProfileFor(name: string, mime: string): Promise<void> {
  const text = await extractCvText(fixture(name), mime);
  llm.register("cv_profile", text, PROFILE);
}

describe("POST /cv", () => {
  it("a PDF with text → 201 with the profile; the previous profile becomes inactive", async () => {
    await registerProfileFor("cv.pdf", PDF_MIME);
    const first = await upload("cv.pdf", PDF_MIME, fixture("cv.pdf"));
    expect(first.statusCode).toBe(201);
    expect(CvProfileSchema.parse(first.json())).toEqual(PROFILE);

    const second = await upload("cv.pdf", PDF_MIME, fixture("cv.pdf"));
    expect(second.statusCode).toBe(201);

    const rows = await prisma.candidateProfile.findMany({ orderBy: { uploadedAt: "asc" } });
    expect(rows.map((r) => r.isActive)).toEqual([false, true]);
    const active = rows[1];
    expect(active?.profileStatus).toBe("ok");
    expect(active?.fileName).toBe("cv.pdf");
    expect(active?.mimeType).toBe(PDF_MIME);
    expect(active?.sizeBytes).toBe(fixture("cv.pdf").length);
    expect(active?.textContent).toContain("Senior Platform Engineer");
    expect(active?.model).toBe("fake");
    expect(llm.calls.filter((c) => c.purpose === "cv_profile")).toHaveLength(2);
  });

  it("a DOCX works the same way", async () => {
    await registerProfileFor("cv.docx", DOCX_MIME);
    const res = await upload("cv.docx", DOCX_MIME, fixture("cv.docx"));
    expect(res.statusCode).toBe(201);
    expect(CvProfileSchema.parse(res.json())).toEqual(PROFILE);
    const row = await prisma.candidateProfile.findFirstOrThrow({ where: { isActive: true } });
    expect(row.mimeType).toBe(DOCX_MIME);
    expect(row.textContent).toContain("Contoso Sample");
  });

  it("a PNG renamed .pdf → 422 unsupported_file", async () => {
    const res = await upload("cv.pdf", PDF_MIME, fixture("image.png"));
    expect(res.statusCode).toBe(422);
    expect(ApiErrorBodySchema.parse(res.json()).error.code).toBe("unsupported_file");
    expect(await prisma.candidateProfile.count()).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });

  it("an unsupported MIME type → 422 unsupported_file even if the bytes are a PDF", async () => {
    const res = await upload("cv.pdf", "text/plain", fixture("cv.pdf"));
    expect(res.statusCode).toBe(422);
    expect(ApiErrorBodySchema.parse(res.json()).error.code).toBe("unsupported_file");
  });

  it("a PDF without text → 422 cv_no_text", async () => {
    await registerProfileFor("cv.pdf", PDF_MIME);
    await upload("cv.pdf", PDF_MIME, fixture("cv.pdf"));
    const res = await upload("blank.pdf", PDF_MIME, fixture("blank.pdf"));
    expect(res.statusCode).toBe(422);
    expect(ApiErrorBodySchema.parse(res.json()).error.code).toBe("cv_no_text");
    // A rejected upload leaves the current CV alone.
    const rows = await prisma.candidateProfile.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isActive).toBe(true);
  });

  it("a 6 MB file → 413 too_large", async () => {
    const big = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(6 * 1024 * 1024)]);
    const res = await upload("big.pdf", PDF_MIME, big);
    expect(res.statusCode).toBe(413);
    expect(ApiErrorBodySchema.parse(res.json()).error.code).toBe("too_large");
    expect(await prisma.candidateProfile.count()).toBe(0);
  });

  it("a request without a file field → 400 validation_failed", async () => {
    const res = await upload("cv.pdf", PDF_MIME, fixture("cv.pdf"), "document");
    expect(res.statusCode).toBe(400);
    expect(ApiErrorBodySchema.parse(res.json()).error.code).toBe("validation_failed");
  });

  it("a request that is not multipart → 400 validation_failed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cv",
      headers: { ...CSRF, cookie, "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(400);
    expect(ApiErrorBodySchema.parse(res.json()).error.code).toBe("validation_failed");
  });

  it("an LLM failure stores the text with profile null and returns 202 profileStatus failed; retry-profile fills it", async () => {
    await registerProfileFor("cv.pdf", PDF_MIME);
    expect((await upload("cv.pdf", PDF_MIME, fixture("cv.pdf"))).statusCode).toBe(201);

    llm.failNext("cv_profile", new LlmError("upstream", "model unavailable", { retryable: true }));
    const failed = await upload("cv.pdf", PDF_MIME, fixture("cv.pdf"));
    expect(failed.statusCode).toBe(202);
    expect(CvUploadFailedSchema.parse(failed.json())).toEqual({
      profileStatus: "failed",
      profile: null,
    });
    expect(failed.json()).toEqual({ profileStatus: "failed", profile: null });

    // The previous CV is deactivated and the new text is stored without a profile.
    const rows = await prisma.candidateProfile.findMany({ orderBy: { uploadedAt: "asc" } });
    expect(rows.map((r) => r.isActive)).toEqual([false, true]);
    expect(rows[1]?.profile).toBeNull();
    expect(rows[1]?.profileStatus).toBe("failed");
    expect(rows[1]?.textContent).toContain("Senior Platform Engineer");

    const current = await app.inject({ method: "GET", url: "/api/v1/cv", headers: { cookie } });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toBeNull();

    // Retry fails once more: 502, nothing changes.
    llm.failNext("cv_profile", new LlmError("timeout", "slow", { retryable: true }));
    const stillFailing = await app.inject({
      method: "POST",
      url: "/api/v1/cv/retry-profile",
      headers: { ...CSRF, cookie },
    });
    expect(stillFailing.statusCode).toBe(502);
    expect(ApiErrorBodySchema.parse(stillFailing.json()).error.code).toBe("upstream_error");
    expect(
      (await prisma.candidateProfile.findFirstOrThrow({ where: { isActive: true } })).profile,
    ).toBeNull();

    const retried = await app.inject({
      method: "POST",
      url: "/api/v1/cv/retry-profile",
      headers: { ...CSRF, cookie },
    });
    expect(retried.statusCode).toBe(200);
    expect(CvProfileSchema.parse(retried.json())).toEqual(PROFILE);

    const after = await prisma.candidateProfile.findFirstOrThrow({ where: { isActive: true } });
    expect(after.profileStatus).toBe("ok");
    expect(after.profile).toEqual(PROFILE);
    expect(after.model).toBe("fake");
    expect(await prisma.candidateProfile.count({ where: { isActive: true } })).toBe(1);

    const got = await app.inject({ method: "GET", url: "/api/v1/cv", headers: { cookie } });
    expect(CvProfileSchema.parse(got.json())).toEqual(PROFILE);
  });

  it("a file name with control characters is stored cleaned, not a 500", async () => {
    const res = await upload("my\u0000 cv\u0007.pdf", PDF_MIME, fixture("cv.pdf"));
    expect(res.statusCode).toBe(201);
    const row = await prisma.candidateProfile.findFirstOrThrow({ where: { isActive: true } });
    expect(row.fileName).toBe("my cv.pdf");
  });

  it("a DOCX that inflates to far more than its size → 422 unsupported_file, quickly", async () => {
    const started = Date.now();
    const res = await upload("bomb.docx", DOCX_MIME, zipBomb(100 * 1024 * 1024));
    expect(res.statusCode).toBe(422);
    expect(ApiErrorBodySchema.parse(res.json()).error.code).toBe("unsupported_file");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await prisma.candidateProfile.count()).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });

  it("never writes the file to disk", async () => {
    const spies = [
      vi.spyOn(fs, "writeFile"),
      vi.spyOn(fs, "writeFileSync"),
      vi.spyOn(fs, "createWriteStream"),
      vi.spyOn(fs, "appendFile"),
      vi.spyOn(fs, "appendFileSync"),
      vi.spyOn(fs.promises, "writeFile"),
      vi.spyOn(fs.promises, "appendFile"),
      vi.spyOn(fs.promises, "open"),
    ];
    expect((await upload("cv.pdf", PDF_MIME, fixture("cv.pdf"))).statusCode).toBe(201);
    expect((await upload("cv.docx", DOCX_MIME, fixture("cv.docx"))).statusCode).toBe(201);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("replacing the CV doesn't re-rank existing leads", async () => {
    const company = await prisma.company.create({
      data: { name: "Fabrikam Example", normalizedName: "fabrikam example", createdSource: "test" },
    });
    const batch = await prisma.intakeBatch.create({ data: { kind: "search_run", counts: {} } });
    const rankedAt = new Date("2026-09-30T10:00:00.000Z");
    const lead = await prisma.lead.create({
      data: {
        companyId: company.id,
        intakeBatchId: batch.id,
        title: "Platform engineer",
        source: "search_agent",
        statusChangedAt: rankedAt,
        fitScore: 77,
        fitReason: "Strong match",
        rankedAt,
        pipelineState: "ready",
      },
    });
    const before = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });

    expect((await upload("cv.pdf", PDF_MIME, fixture("cv.pdf"))).statusCode).toBe(201);
    expect((await upload("cv.docx", DOCX_MIME, fixture("cv.docx"))).statusCode).toBe(201);

    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toEqual(before);
    expect(llm.calls.map((c) => c.purpose)).toEqual(["cv_profile", "cv_profile"]);
  });

  it("never logs the CV text or the profile", async () => {
    await registerProfileFor("cv.pdf", PDF_MIME);
    await upload("cv.pdf", PDF_MIME, fixture("cv.pdf"));
    llm.failNext("cv_profile", new LlmError("upstream", "boom", { retryable: true }));
    await upload("cv.pdf", PDF_MIME, fixture("cv.pdf"));
    await upload("blank.pdf", PDF_MIME, fixture("blank.pdf"));
    const output = logged.join("");
    // The capture works (a vacuous check would pass on empty output) and holds the failure line.
    expect(output).toContain("cv profile failed");
    expect(output.length).toBeGreaterThan(200);
    for (const secret of ["Jordan Example", "Northwind", "Contoso", PROFILE.headline]) {
      expect(output).not.toContain(secret);
    }
  });
});

describe("authentication", () => {
  it("an unauthenticated multipart POST → 401 before the body is parsed", async () => {
    // A body that cannot be parsed as multipart: parsing first would give a 4xx other than 401.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cv",
      headers: { ...CSRF, "content-type": "multipart/form-data; boundary=x" },
      payload: "this is not a multipart body",
    });
    expect(res.statusCode).toBe(401);
    expect(ApiErrorBodySchema.parse(res.json()).error.code).toBe("unauthenticated");
    expect(await prisma.candidateProfile.count()).toBe(0);
  });

  it("an unauthenticated upload of a valid file → 401 and nothing is stored or sent to the model", async () => {
    const { payload, headers } = multipart("cv.pdf", PDF_MIME, fixture("cv.pdf"));
    const res = await app.inject({ method: "POST", url: "/api/v1/cv", headers, payload });
    expect(res.statusCode).toBe(401);
    expect(await prisma.candidateProfile.count()).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });

  it("an unauthenticated oversize upload → 401, not 413", async () => {
    const big = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(6 * 1024 * 1024)]);
    const { payload, headers } = multipart("big.pdf", PDF_MIME, big);
    const res = await app.inject({ method: "POST", url: "/api/v1/cv", headers, payload });
    expect(res.statusCode).toBe(401);
  });

  it("GET /cv and POST /cv/retry-profile need a session", async () => {
    const get = await app.inject({ method: "GET", url: "/api/v1/cv" });
    expect(get.statusCode).toBe(401);
    const retry = await app.inject({
      method: "POST",
      url: "/api/v1/cv/retry-profile",
      headers: CSRF,
    });
    expect(retry.statusCode).toBe(401);
  });

  it("POST /cv without the CSRF header → 403 csrf_header_missing", async () => {
    const { payload, headers } = multipart("cv.pdf", PDF_MIME, fixture("cv.pdf"));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cv",
      headers: { "content-type": headers["content-type"] ?? "", cookie },
      payload,
    });
    expect(res.statusCode).toBe(403);
    expect(ApiErrorBodySchema.parse(res.json()).error.code).toBe("csrf_header_missing");
  });
});

describe("GET /cv and retry-profile", () => {
  it("GET /cv with no CV → 200 null", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/cv", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
  });

  it("GET /cv → the active profile, bare", async () => {
    await registerProfileFor("cv.pdf", PDF_MIME);
    await upload("cv.pdf", PDF_MIME, fixture("cv.pdf"));
    const res = await app.inject({ method: "GET", url: "/api/v1/cv", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(CvProfileSchema.parse(res.json())).toEqual(PROFILE);
  });

  it("retry-profile with no CV → 404 not_found", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cv/retry-profile",
      headers: { ...CSRF, cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(ApiErrorBodySchema.parse(res.json()).error.code).toBe("not_found");
  });
});
