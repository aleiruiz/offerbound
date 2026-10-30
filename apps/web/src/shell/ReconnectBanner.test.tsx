import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { queryKeys } from "../api/hooks";
import { makeSyncStatus } from "../../test/factories";
import { mockApi } from "../../test/mock-api";
import { renderWithProviders } from "../../test/render";
import { ReconnectBanner } from "./ReconnectBanner";

describe("ReconnectBanner", () => {
  it.each(["needs_reauth", "missing_scope"] as const)(
    "%s shows the banner and Reconnect Gmail links to the Google start URL",
    async (connection) => {
      mockApi({ "GET /api/v1/gmail/status": () => makeSyncStatus({ connection }) });
      renderWithProviders(<ReconnectBanner />);
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Gmail needs reconnecting.");
      expect(alert).toHaveTextContent("Your records are safe.");
      expect(screen.getByRole("link", { name: "Reconnect Gmail" })).toHaveAttribute(
        "href",
        "/api/v1/auth/google/start",
      );
    },
  );

  it.each(["active", "not_connected", "disconnected"] as const)(
    "%s shows no banner",
    async (connection) => {
      const api = mockApi({ "GET /api/v1/gmail/status": () => makeSyncStatus({ connection }) });
      const { queryClient } = renderWithProviders(<ReconnectBanner />);
      await waitFor(() =>
        expect(queryClient.getQueryState(queryKeys.syncStatus)?.status).toBe("success"),
      );
      expect(api.calls).toHaveLength(1);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );
});
