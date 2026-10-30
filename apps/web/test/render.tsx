import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import type { Me } from "@offerbound/contracts";
import { queryKeys } from "../src/api/hooks";
import { createOfferboundTheme } from "../src/theme";
import { setViewport } from "./match-media";

export interface RenderOptions {
  route?: string;
  mode?: "light" | "dark";
  /** Viewport width in px; 1280 (md and up) by default. */
  width?: number;
  /** Emulates `prefers-reduced-motion: reduce`. */
  reducedMotion?: boolean;
  /**
   * The signed-in account, put in the cache as `RequireSession` leaves it. Demo-aware controls read
   * the mode from there without asking again; without it the app is in private mode.
   */
  me?: Me;
}

export type ProvidersResult = RenderResult & { queryClient: QueryClient };

export function renderWithProviders(
  ui: ReactElement,
  { route = "/", mode = "light", width = 1280, reducedMotion = false, me }: RenderOptions = {},
): ProvidersResult {
  setViewport({ width, dark: mode === "dark", reducedMotion });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: true },
      mutations: { retry: false },
    },
  });
  if (me) queryClient.setQueryData(queryKeys.me, me);
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={createOfferboundTheme(mode, { touch: width < 600 })}>
        <CssBaseline />
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return Object.assign(result, { queryClient });
}
