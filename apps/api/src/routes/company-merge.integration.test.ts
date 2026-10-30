import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompanySchema, type ApiErrorBody } from "@offerbound/contracts";
import { buildTestApp, signIn } from "../../test/app.js";
import { resetDb, testPrisma } from "../../test/db.js";

const prisma = testPrisma();
const CSRF = { "x-offerbound-request": "1" };
const MISSING = "6f9619ff-8b86-4011-b42d-00c04fc964ff";

const apps: FastifyInstance[] = [];
async function setup() {
  const built = await buildTestApp();
  apps.push(built.app);
  const cookie = await signIn(built.app, built.deps);
  const merge = (id: string, payload: object) =>
    built.app.inject({
      method: "POST",
      url: `/api/v1/companies/${id}/merge`,
      headers: { cookie, ...CSRF },
      payload,
    });
  return { ...built, cookie, merge };
}

beforeEach(async () => {
  await resetDb(prisma);
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const seedCompany = (name: string, domains: string[] = []) =>
  prisma.company.create({
    data: { name, normalizedName: name.toLowerCase(), domains, createdSource: "manual" },
  });
const errorOf = (body: string) => (JSON.parse(body) as ApiErrorBody).error;

describe("POST /companies/:id/merge", () => {
  it("moves the records into the target, deletes the source and answers the target company", async () => {
    const { merge } = await setup();
    const source = await seedCompany("Quarry Labs", ["quarry-labs.example"]);
    const target = await seedCompany("Quarry AI", ["quarry.example"]);
    const application = await prisma.application.create({
      data: {
        companyId: source.id,
        title: "Platform Engineer",
        status: "applied",
        statusChangedAt: new Date("2026-09-20T10:00:00.000Z"),
        source: "manual",
      },
    });

    const res = await merge(source.id, { intoId: target.id });

    expect(res.statusCode).toBe(200);
    const dto = CompanySchema.parse(JSON.parse(res.body));
    expect(dto.id).toBe(target.id);
    expect(dto.domains.sort()).toEqual(["quarry-labs.example", "quarry.example"]);
    expect(dto.aliases).toContain("quarry labs");
    expect(await prisma.company.findUnique({ where: { id: source.id } })).toBeNull();
    expect(
      (await prisma.application.findUniqueOrThrow({ where: { id: application.id } })).companyId,
    ).toBe(target.id);
  });

  it("refuses to merge a company into itself with 400", async () => {
    const { merge } = await setup();
    const company = await seedCompany("Quarry AI");
    const res = await merge(company.id, { intoId: company.id });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.body).code).toBe("validation_failed");
    expect(await prisma.company.count()).toBe(1);
  });

  it("answers 403 csrf_header_missing without the request header", async () => {
    const { app, cookie } = await setup();
    const company = await seedCompany("Quarry AI");
    const other = await seedCompany("Quarry Labs");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/companies/${company.id}/merge`,
      headers: { cookie },
      payload: { intoId: other.id },
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res.body).code).toBe("csrf_header_missing");
    expect(await prisma.company.count()).toBe(2);
  });

  it("answers 404 for an unknown source or target, and 400 for a missing intoId", async () => {
    const { merge } = await setup();
    const company = await seedCompany("Quarry AI");

    const noSource = await merge(MISSING, { intoId: company.id });
    expect(noSource.statusCode).toBe(404);
    expect(errorOf(noSource.body).code).toBe("not_found");

    const noTarget = await merge(company.id, { intoId: MISSING });
    expect(noTarget.statusCode).toBe(404);
    expect(errorOf(noTarget.body).code).toBe("not_found");

    const notAnId = await merge("not-an-id", { intoId: company.id });
    expect(notAnId.statusCode).toBe(404);

    expect((await merge(company.id, {})).statusCode).toBe(400);
    expect(await prisma.company.count()).toBe(1);
  });

  it("answers 401 without a session", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/companies/${MISSING}/merge`,
      headers: CSRF,
      payload: { intoId: MISSING },
    });
    expect(res.statusCode).toBe(401);
  });
});
