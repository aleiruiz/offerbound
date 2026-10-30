import { Prisma, type PrismaClient } from "@prisma/client";
import type { Company as CompanyDto, CompanyPatch } from "@offerbound/contracts";
import { normalizeCompanyName } from "@offerbound/domain";
import { ApiError } from "../http/errors.js";
import { toCompanyDto } from "./dto.js";
import { assertId, VersionConflictError } from "./owner-actions.js";

function invalid(message: string, field: string, reason: string): ApiError {
  return new ApiError(400, "validation_failed", message, { [field]: reason });
}

/** Aliases are kept normalised (DATA_MODEL §3.1), once each, never repeating the company's own name. */
function cleanAliases(aliases: readonly string[], ownName: string): string[] {
  const kept: string[] = [];
  for (const alias of aliases) {
    const normalized = normalizeCompanyName(alias);
    if (normalized !== "" && normalized !== ownName && !kept.includes(normalized)) {
      kept.push(normalized);
    }
  }
  return kept;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * `PATCH /companies/:id`: rename, set aliases, and join or leave a corporate group (§3.1, §6.1).
 * An owner edit: no lock, the `version` guards it (stale → `VersionConflictError`).
 *
 * - `name` must still normalise to something and to a name no other company has.
 * - `groupId` names any company of the group; the company joins that company's root (a root has
 *   no group of its own). Joining a group moves the company's own members to the new root, so a
 *   group is never two levels deep. `null` leaves the group; a root with members stays a root.
 * - A patch that changes nothing leaves the version alone.
 */
export async function patchCompany(
  prisma: PrismaClient,
  id: string,
  body: CompanyPatch,
  now: Date,
): Promise<CompanyDto> {
  assertId(id, "company");
  const company = await prisma.company.findUnique({ where: { id } });
  if (company === null) throw new ApiError(404, "not_found", "No such company.");
  if (company.version !== body.version) throw new VersionConflictError(toCompanyDto(company));

  const data: Prisma.CompanyUncheckedUpdateManyInput = {};
  let normalizedName = company.normalizedName;

  if (body.name !== undefined && body.name.trim() !== company.name) {
    const name = body.name.trim();
    normalizedName = normalizeCompanyName(name);
    if (normalizedName === "") throw invalid("Enter a company name.", "name", "required");
    if (normalizedName !== company.normalizedName) {
      const taken = await prisma.company.findFirst({
        where: { normalizedName, id: { not: id } },
        select: { id: true },
      });
      if (taken !== null) {
        throw invalid("Another company already has that name.", "name", "already_exists");
      }
    }
    data.name = name;
    data.normalizedName = normalizedName;
  }

  // The aliases are checked against the name the company will have, also when only the name changes.
  const aliases = cleanAliases(body.aliases ?? company.aliases, normalizedName);
  if (!sameList(aliases, company.aliases)) data.aliases = aliases;

  let newRoot: string | null | undefined;
  if (body.groupId !== undefined) {
    if (body.groupId === null) {
      newRoot = null;
    } else {
      if (body.groupId === id)
        throw invalid("A company can't be its own group.", "groupId", "invalid");
      const target = await prisma.company.findUnique({
        where: { id: body.groupId },
        select: { id: true, groupId: true },
      });
      if (target === null) throw invalid("That group doesn't exist.", "groupId", "not_found");
      const root = target.groupId ?? target.id;
      // Naming one of its own members is naming itself.
      if (root === id) throw invalid("A company can't be its own group.", "groupId", "invalid");
      newRoot = root;
    }
    if (newRoot !== company.groupId) data.groupId = newRoot;
  }

  if (Object.keys(data).length === 0) return toCompanyDto(company);

  try {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.company.updateMany({
        where: { id, version: body.version },
        data: { ...data, updatedAt: now, version: { increment: 1 } },
      });
      if (count === 0) throw new VersionConflictError(null);
      if (typeof newRoot === "string") {
        await tx.company.updateMany({ where: { groupId: id }, data: { groupId: newRoot } });
      }
    });
  } catch (error) {
    if (error instanceof VersionConflictError) {
      const fresh = await prisma.company.findUniqueOrThrow({ where: { id } });
      throw new VersionConflictError(toCompanyDto(fresh));
    }
    // Two edits racing for the same name: the unique index decides.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw invalid("Another company already has that name.", "name", "already_exists");
    }
    throw error;
  }
  return toCompanyDto(await prisma.company.findUniqueOrThrow({ where: { id } }));
}
