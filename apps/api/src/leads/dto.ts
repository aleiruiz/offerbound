import type { Prisma } from "@prisma/client";
import {
  ApplicationStatusSchema,
  type ApplicationDetail,
  type Company as CompanyDto,
  type Lead as LeadDto,
} from "@offerbound/contracts";

/** A lead with the company columns `toLeadDto` reads. */
export type LeadRow = Prisma.LeadGetPayload<{
  include: { company: { select: { id: true; name: true } } };
}>;

/** The `include` that gives a `LeadRow`. */
export const LEAD_INCLUDE = { company: { select: { id: true, name: true } } } as const;

/** The `Lead` DTO (TECHNICAL_SPEC §10.2); money columns are decimals in the table, numbers on the wire. */
export function toLeadDto(row: LeadRow): LeadDto {
  return {
    id: row.id,
    version: row.version,
    company: { id: row.company.id, name: row.company.name },
    title: row.title,
    jobUrl: row.jobUrl,
    locationText: row.locationText,
    country: row.country,
    workMode: row.workMode,
    remoteFromHomeCountry: row.remoteFromHomeCountry,
    sponsorship: row.sponsorship,
    relocation: row.relocation,
    sponsorshipText: row.sponsorshipText,
    eligible: row.eligible,
    eligibilityReason: row.eligibilityReason,
    compensationText: row.compensationText,
    compensation: {
      min: row.compMin === null ? null : row.compMin.toNumber(),
      max: row.compMax === null ? null : row.compMax.toNumber(),
      currency: row.compCurrency,
      period: row.compPeriod,
      isEstimate: row.compIsEstimate,
      basis: row.compBasis,
    },
    seniority: row.seniority,
    track: row.track,
    fitScore: row.fitScore,
    fitReason: row.fitReason,
    gaps: row.gaps,
    status: row.status,
    suppressedReason: row.suppressedReason,
    dismissedReason: row.dismissedReason,
    companySeenBefore: row.companySeenBefore,
    verification: row.verification,
    source: row.source,
    foundAt: row.foundAt.toISOString(),
    postedAt: row.postedAt === null ? null : row.postedAt.toISOString(),
    applicationId: row.applicationId,
    notes: row.notes,
  };
}

export type CompanyRow = Prisma.CompanyGetPayload<Record<string, never>>;

export function toCompanyDto(row: CompanyRow): CompanyDto {
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    aliases: row.aliases,
    domains: row.domains,
    websiteDomain: row.websiteDomain,
    groupId: row.groupId,
  };
}

type NewApplicationRow = Prisma.ApplicationGetPayload<{
  include: { company: { select: { id: true; name: true } }; events: true };
}>;

/**
 * The `ApplicationDetail` of an application that was just created from a lead. It has no
 * interviews and no messages yet, so those are empty by construction; the general reader belongs
 * to `GET /applications/:id`.
 */
export function newApplicationDetail(row: NewApplicationRow): ApplicationDetail {
  return {
    id: row.id,
    version: row.version,
    company: { id: row.company.id, name: row.company.name },
    title: row.title,
    status: row.status,
    statusChangedAt: row.statusChangedAt.toISOString(),
    appliedAt: row.appliedAt === null ? null : row.appliedAt.toISOString(),
    lastCompanyActivityAt:
      row.lastCompanyActivityAt === null ? null : row.lastCompanyActivityAt.toISOString(),
    followUpDue: row.followUpDue,
    nextInterviewAt: null,
    workMode: row.workMode,
    country: row.country,
    source: row.source,
    jobUrl: row.jobUrl,
    locationText: row.locationText,
    compensationText: row.compensationText,
    sponsorshipText: row.sponsorshipText,
    notes: row.notes,
    leadId: row.leadId,
    interviews: [],
    messages: [],
    timeline: [...row.events]
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .map((event) => {
        const toStatus =
          typeof event.data === "object" && event.data !== null && "toStatus" in event.data
            ? ApplicationStatusSchema.safeParse(event.data.toStatus)
            : null;
        return {
          id: event.id,
          type: event.type,
          occurredAt: event.occurredAt.toISOString(),
          actor: event.actor,
          summary: event.summary,
          messageId: event.messageId,
          toStatus: toStatus?.success === true ? toStatus.data : null,
          undoable: event.undoable,
          undoneAt: event.undoneAt === null ? null : event.undoneAt.toISOString(),
        };
      }),
  };
}
