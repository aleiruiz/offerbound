import type { LeadSource, Ranking, Seniority, Verification, WorkMode } from "@offerbound/contracts";

/**
 * One lead as it arrives at intake (TECHNICAL_SPEC §7.1), whatever the source. `ref` names the lead
 * inside its batch so a plan can point at it (for example from `link_thread`); `order` is its
 * position in the source. T6.1 adds the intake functions to this file.
 */
export type IncomingLead = {
  ref: string;
  order: number;
  source: LeadSource;
  companyName: string;
  companyDomain: string | null;
  title: string;
  jobUrl: string | null;
  locationText: string | null;
  country: string | null;
  workMode: WorkMode;
  compensationText: string | null;
  sponsorshipText: string | null;
  postedAt: Date | null;
  seniority: Seniority | null;
  ranking: Ranking | null;
  verification: Verification | null;
  pageExcerpt: string | null;
  sheetStatus: "to_research" | "cancelled" | null;
  notes: string | null;
  contactEmail: string | null;
};
