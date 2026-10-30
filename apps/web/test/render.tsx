import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { createOfferboundTheme } from "../src/theme";
import { setViewport } from "./match-media";

export interface RenderOptions {
  route?: string;
  mode?: "light" | "dark";
  /** Viewport width in px; 1280 (md and up) by default. */
  width?: number;
}

export type ProvidersResult = RenderResult & { queryClient: QueryClient };

export function renderWithProviders(
  ui: ReactElement,
  { route = "/", mode = "light", width = 1280 }: RenderOptions = {},
): ProvidersResult {
  setViewport({ width, dark: mode === "dark" });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: true },
      mutations: { retry: false },
    },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={createOfferboundTheme(mode)}>
        <CssBaseline />
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return Object.assign(result, { queryClient });
}
