import "@fontsource/overpass/400.css";
import "@fontsource/overpass/600.css";
import "@fontsource/overpass/700.css";
import "@fontsource/overpass/800.css";
import "@fontsource/overpass/900.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { ColorModeProvider } from "./ColorModeProvider";
import { createQueryClient } from "./api/query-client";
import { LocaleProvider } from "./i18n";

const queryClient = createQueryClient();
const container = document.getElementById("root");
if (!container) throw new Error("index.html has no #root element");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ColorModeProvider>
        <LocaleProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </LocaleProvider>
      </ColorModeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
