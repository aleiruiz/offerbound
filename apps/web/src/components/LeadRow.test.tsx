import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeLead } from "../../test/factories";
import { renderWithProviders } from "../../test/render";
import { LeadRow } from "./LeadRow";

const NOW = new Date("2026-10-29T20:00:00Z");

function renderRow(lead = makeLead(), props: Partial<Parameters<typeof LeadRow>[0]> = {}) {
  return renderWithProviders(
    <ul>
      <LeadRow lead={lead} timezone="America/Monterrey" now={NOW} {...props} />
    </ul>,
  );
}

describe("LeadRow", () => {
  it("shows fit, company, title, chips, reason and gaps", () => {
    renderRow();
    expect(screen.getByText("91")).toBeInTheDocument();
    expect(screen.getByText("fit")).toBeInTheDocument();
    expect(screen.getByText("Tidewater Labs")).toBeInTheDocument();
    expect(screen.getByText("Senior Product Engineer")).toBeInTheDocument();
    expect(screen.getByText("Remote from MX")).toBeInTheDocument();
    expect(screen.getByText("Remote")).toBeInTheDocument();
    expect(screen.getByText("Verified posting")).toBeInTheDocument();
    expect(screen.getByText("US$9.5–11k / month")).toBeInTheDocument();
    expect(screen.getByText("React, TypeScript and Node match your CV.")).toBeInTheDocument();
    expect(screen.getByText("Gaps: Go. Found by the search at 07:04.")).toBeInTheDocument();
    expect(screen.queryByText("Estimate")).not.toBeInTheDocument();
  });

  it("LeadRow shows a separate Estimate chip for estimated compensation", () => {
    const lead = makeLead({
      compensation: {
        min: 95000,
        max: 110000,
        currency: "EUR",
        period: "year",
        isEstimate: true,
        basis: "similar roles",
      },
    });
    renderRow(lead);
    const amount = screen.getByText("€95–110k / year");
    const estimate = screen.getByText("Estimate");
    expect(amount.closest(".MuiChip-root")).not.toBe(estimate.closest(".MuiChip-root"));
    expect(amount.closest(".MuiChip-root")).not.toBeNull();
    expect(estimate.closest(".MuiChip-root")).not.toBeNull();
  });

  it("flags verification states and a company seen before", () => {
    renderRow(makeLead({ verification: "unverifiable", companySeenBefore: true }));
    expect(screen.getByText("LinkedIn only, not checked")).toBeInTheDocument();
    expect(screen.getByText("Company seen before")).toBeInTheDocument();
  });

  it("calls the row actions and opens the posting in a new tab", async () => {
    const user = userEvent.setup();
    const onShortlist = vi.fn();
    const onMarkApplied = vi.fn();
    const onDismiss = vi.fn();
    const lead = makeLead();
    renderRow(lead, { onShortlist, onMarkApplied, onDismiss });
    await user.click(screen.getByRole("button", { name: "Shortlist" }));
    await user.click(screen.getByRole("button", { name: "Mark applied" }));
    await user.click(screen.getByRole("button", { name: "Dismiss lead" }));
    expect(onShortlist).toHaveBeenCalledWith(lead);
    expect(onMarkApplied).toHaveBeenCalledWith(lead);
    expect(onDismiss).toHaveBeenCalledWith(lead);
    const open = screen.getByRole("link", { name: "Open job posting" });
    expect(open).toHaveAttribute("href", "https://jobs.example/tidewater/1");
    expect(open).toHaveAttribute("rel", "noopener noreferrer");
    expect(open).toHaveAttribute("target", "_blank");
  });

  it("offers Reconsider on a dismissed lead and a suppressed reason on a suppressed one", async () => {
    const user = userEvent.setup();
    const onReconsider = vi.fn();
    const { unmount } = renderRow(makeLead({ status: "dismissed" }), { onReconsider });
    expect(screen.queryByRole("button", { name: "Shortlist" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reconsider" }));
    expect(onReconsider).toHaveBeenCalledTimes(1);
    unmount();

    renderRow(makeLead({ status: "suppressed", suppressedReason: "company_already_seen" }), {
      onReconsider,
    });
    expect(screen.getByText("Company already seen")).toBeInTheDocument();
  });

  it("never links a non-http posting URL and marks the focused row", () => {
    renderRow(makeLead({ jobUrl: "javascript:alert(1)" }), { focused: true });
    expect(screen.queryByRole("link", { name: "Open job posting" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("listitem")).getByText("Tidewater Labs")).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveAttribute("aria-current", "true");
  });
});
