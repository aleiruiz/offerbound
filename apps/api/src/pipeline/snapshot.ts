import type { Prisma } from "@prisma/client";
import type { Extraction } from "@offerbound/contracts";
import type { InterviewRef, PlanMessage, PlanSnapshot } from "@offerbound/domain";

/**
 * Loads what `planChanges` needs about the world for one message (TECHNICAL_SPEC §6.5): the
 * companies and contacts, the applications and open leads with their versions and statuses, the
 * thread's link and every application's interviews. It is read inside the intake lock, so the
 * snapshot is current for every system writer; only an owner edit (which takes no lock) can
 * change a record before the plan is written, and the version checks in `executePlan` catch that.
 *
 * Everything is loaded rather than narrowed to the resolved company: a review decision may attach
 * the email to any candidate, or edit the company name, and the planner throws when a record it
 * names is missing from the snapshot. The owner's data is small (hundreds of rows), and only
 * narrow columns are read.
 *
 * Leads that already became applications are left out, except the one this thread is linked to
 * (the planner reads its company). `m` and `e` are not used to filter; they are part of the
 * signature so a later narrowing needs no caller changes.
 */
export async function loadPlanSnapshot(
  tx: Prisma.TransactionClient,
  m: PlanMessage,
  _e: Extraction,
  ownerTimezone: string,
): Promise<PlanSnapshot> {
  const link = await tx.threadLink.findUnique({ where: { threadId: m.threadId } });
  const [companies, contacts, applications, leads, interviews] = await Promise.all([
    tx.company.findMany({
      select: {
        id: true,
        name: true,
        normalizedName: true,
        aliases: true,
        domains: true,
        atsSlugs: true,
        groupId: true,
      },
    }),
    tx.contact.findMany({ select: { email: true, companyId: true } }),
    tx.application.findMany({
      select: {
        id: true,
        companyId: true,
        title: true,
        status: true,
        jobKey: true,
        version: true,
        statusBeforeAbandon: true,
        followUpDue: true,
        lastCompanyActivityAt: true,
      },
    }),
    tx.lead.findMany({
      where: link?.leadId
        ? { OR: [{ status: { not: "applied" } }, { id: link.leadId }] }
        : { status: { not: "applied" } },
      select: { id: true, companyId: true, title: true, status: true, jobKey: true, version: true },
    }),
    tx.interview.findMany({
      select: {
        id: true,
        applicationId: true,
        version: true,
        kind: true,
        status: true,
        startsAt: true,
        icsUid: true,
      },
    }),
  ]);

  const interviewsByApplication = new Map<string, InterviewRef[]>();
  for (const { applicationId, ...ref } of interviews) {
    const list = interviewsByApplication.get(applicationId) ?? [];
    list.push(ref);
    interviewsByApplication.set(applicationId, list);
  }

  return {
    threadLinks: new Map(
      link === null
        ? []
        : [[link.threadId, { applicationId: link.applicationId, leadId: link.leadId }]],
    ),
    companies,
    companyIndex: { companies, contacts },
    applications: applications.map(({ id, companyId, title, status, jobKey }) => ({
      id,
      companyId,
      title,
      status,
      jobKey,
    })),
    applicationState: new Map(
      applications.map((a) => [
        a.id,
        {
          version: a.version,
          status: a.status,
          statusBeforeAbandon: a.statusBeforeAbandon,
          followUpDue: a.followUpDue,
          lastCompanyActivityAt: a.lastCompanyActivityAt,
        },
      ]),
    ),
    leads: leads.map(({ id, companyId, title, status, jobKey }) => ({
      id,
      companyId,
      title,
      status,
      jobKey,
    })),
    leadState: new Map(leads.map((l) => [l.id, { version: l.version, status: l.status }])),
    interviews: interviewsByApplication,
    ownerTimezone,
  };
}
