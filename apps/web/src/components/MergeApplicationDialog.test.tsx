import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeApplication, makeApplicationDetail } from "../../test/factories";
import { apiError, mockApi, type MockHandler } from "../../test/mock-api";
import { renderWithProviders } from "../../test/render";
import { setValue } from "../../test/speed";
import { MergeApplicationDialog } from "./MergeApplicationDialog";
import { UndoSnackbar } from "./UndoSnackbar";

vi.setConfig({ testTimeout: 15_000 });

const SOURCE = {
  id: "a1",
  company: { id: "c1", name: "Northwind Robotics" },
  title: "Senior Full-stack Engineer",
};
const KESTREL = makeApplication({
  id: "a2",
  company: { id: "c9", name: "Kestrel Payments Ltd" },
  title: "Frontend Engineer",
  status: "interviewing",
});
const HALCYON = makeApplication({
  id: "a3",
  company: { id: "c8", name: "Halcyon Freight" },
  title: "Platform Engineer",
  status: "screening",
});

function setup(routes: Record<string, MockHandler> = {}) {
  const onClose = vi.fn();
  const onMerged = vi.fn();
  const api = mockApi({
    "GET /api/v1/applications": (req) => {
      const q = new URL(req.url).searchParams.get("q");
      const all = [makeApplication({ id: "a1" }), KESTREL, HALCYON];
      const items = q ? all.filter((a) => a.company.name.toLowerCase().includes(q)) : all;
      return { items, nextCursor: null };
    },
    ...routes,
  });
  const rendered = renderWithProviders(
    <>
      <MergeApplicationDialog open source={SOURCE} onClose={onClose} onMerged={onMerged} />
      <UndoSnackbar />
    </>,
  );
  return { api, onClose, onMerged, user: userEvent.setup(), ...rendered };
}

const dialog = () => screen.findByRole("dialog", { name: "Merge into another application" });

describe("MergeApplicationDialog", () => {
  it("lists the other applications on open, never the one being merged, and keeps Merge off until one is picked", async () => {
    setup();
    const d = await dialog();
    expect(
      await within(d).findByRole("radio", { name: /Kestrel Payments Ltd/ }),
    ).toBeInTheDocument();
    expect(within(d).getByRole("radio", { name: /Halcyon Freight/ })).toBeInTheDocument();
    expect(within(d).queryByRole("radio", { name: /Northwind Robotics/ })).not.toBeInTheDocument();
    expect(within(d).getAllByRole("radio")).toHaveLength(2);
    expect(within(d).getByRole("button", { name: "Merge" })).toBeDisabled();
  });

  it("searches by company or role and says so when nothing else matches", async () => {
    const { api } = setup();
    const d = await dialog();
    await within(d).findByRole("radio", { name: /Kestrel/ });
    setValue(within(d).getByRole("searchbox", { name: "Find an application" }), "zzz");
    expect(await within(d).findByText("No other application matches.")).toBeInTheDocument();
    const searched = api.calls.map((c) => new URL(c.url).searchParams.get("q"));
    expect(searched).toContain("zzz");
  });

  it("posts the merge, thanks the owner in a snackbar, hands over the target and closes", async () => {
    const posted: unknown[] = [];
    const { onMerged, onClose, user } = setup({
      "POST /api/v1/applications/a1/merge": async (req) => {
        posted.push(await req.clone().json());
        return makeApplicationDetail({ id: "a2", company: KESTREL.company });
      },
    });
    const d = await dialog();
    await user.click(await within(d).findByRole("radio", { name: /Kestrel/ }));
    await user.click(within(d).getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(posted).toEqual([{ intoId: "a2" }]));
    await waitFor(() => expect(onMerged).toHaveBeenCalledTimes(1));
    expect(onMerged.mock.calls[0]?.[0]).toMatchObject({ id: "a2" });
    expect(onClose).toHaveBeenCalled();
    expect(await screen.findByText("Merged into Kestrel Payments Ltd")).toBeInTheDocument();
  });

  it("stays open and says what went wrong when the target no longer exists (404)", async () => {
    const { onMerged, onClose, user } = setup({
      "POST /api/v1/applications/a1/merge": () =>
        apiError(404, "not_found", "That application no longer exists."),
    });
    const d = await dialog();
    await user.click(await within(d).findByRole("radio", { name: /Halcyon/ }));
    await user.click(within(d).getByRole("button", { name: "Merge" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent(
      "Couldn't merge the applications. That application no longer exists.",
    );
    expect(onMerged).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(within(d).getByRole("button", { name: "Merge" })).toBeEnabled();
  });

  it("falls back to a plain sentence on a network failure", async () => {
    const { user } = setup({
      "POST /api/v1/applications/a1/merge": () => {
        throw new Error("offline");
      },
    });
    const d = await dialog();
    await user.click(await within(d).findByRole("radio", { name: /Halcyon/ }));
    await user.click(within(d).getByRole("button", { name: "Merge" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent(
      "Couldn't merge the applications. Check your connection and try again.",
    );
  });

  it("drops the pick when the search changes, so Merge never acts on a hidden choice", async () => {
    const { user } = setup();
    const d = await dialog();
    await user.click(await within(d).findByRole("radio", { name: /Kestrel/ }));
    expect(within(d).getByRole("button", { name: "Merge" })).toBeEnabled();
    setValue(within(d).getByRole("searchbox", { name: "Find an application" }), "kestrel");
    await waitFor(() => expect(within(d).getByRole("button", { name: "Merge" })).toBeDisabled());
  });

  it("Cancel closes without posting", async () => {
    const { api, onClose, user } = setup();
    const d = await dialog();
    await user.click(within(d).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});
