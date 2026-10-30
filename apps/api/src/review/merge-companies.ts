import type { Prisma } from "@prisma/client";
import { normalizeCompanyName } from "@offerbound/domain";
import { ApiError } from "../http/errors.js";

/**
 * Merges company `sourceId` into `intoId` (TECHNICAL_SPEC §6.2; AC-5.2 *Merge*). The caller holds
 * the intake lock.
 *
 * - Leads, applications and contacts move to the target; so do the timeline events and review
 *   items that name the source company (the review item being resolved among them: a company
 *   delete would otherwise cascade to it).
 * - The source's name and aliases become aliases of the target (normalised, once each, never the
 *   target's own name); domains and ATS slugs are unioned; the target keeps its website domain,
 *   or takes the source's when it has none.
 * - Corporate groups stay one level deep: the source's members join the target's group (or the
 *   target when it is a root), and a target that was a member of the source's group takes the
 *   source's own group.
 * - Moved applications and leads get a new `version` (they changed under their owner), so an undo
 *   of an earlier event on them answers `changed_since` rather than reviving the old company.
 * - The source company is deleted.
 */
export async function mergeCompanies(
  tx: Prisma.TransactionClient,
  sourceId: string,
  intoId: string,
): Promise<void> {
  if (sourceId === intoId) {
    throw new ApiError(400, "validation_failed", "A company can't be merged into itself.");
  }
  const [source, target] = await Promise.all([
    tx.company.findUnique({ where: { id: sourceId } }),
    tx.company.findUnique({ where: { id: intoId } }),
  ]);
  if (source === null || target === null) throw new ApiError(404, "not_found", "No such company.");

  const now = new Date();
  const moved = { companyId: intoId, updatedAt: now, version: { increment: 1 } };
  await tx.application.updateMany({ where: { companyId: sourceId }, data: moved });
  await tx.lead.updateMany({ where: { companyId: sourceId }, data: moved });
  await tx.contact.updateMany({ where: { companyId: sourceId }, data: { companyId: intoId } });
  await tx.event.updateMany({ where: { companyId: sourceId }, data: { companyId: intoId } });
  await tx.reviewItem.updateMany({ where: { companyId: sourceId }, data: { companyId: intoId } });

  // Groups.
  const targetGroup =
    target.groupId === sourceId
      ? source.groupId
      : (target.groupId ?? (source.groupId === intoId ? null : source.groupId));
  const root = targetGroup ?? intoId;
  await tx.company.updateMany({
    where: { groupId: sourceId, id: { not: intoId } },
    data: { groupId: root },
  });

  const unique = (values: string[]): string[] => [...new Set(values)];
  const aliases = unique(
    [
      ...target.aliases,
      ...source.aliases,
      source.normalizedName,
      normalizeCompanyName(source.name),
    ].filter((alias) => alias !== "" && alias !== target.normalizedName),
  );
  // The source row goes first: its aliases and domains may collide with nothing, but its name
  // index must be free before anything else could take it.
  await tx.company.delete({ where: { id: sourceId } });
  await tx.company.update({
    where: { id: intoId },
    data: {
      aliases,
      domains: unique([...target.domains, ...source.domains]),
      atsSlugs: unique([...target.atsSlugs, ...source.atsSlugs]),
      websiteDomain: target.websiteDomain ?? source.websiteDomain,
      groupId: targetGroup,
      updatedAt: now,
      version: { increment: 1 },
    },
  });
}
