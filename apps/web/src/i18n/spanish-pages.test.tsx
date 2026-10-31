import type { Page } from "@offerbound/contracts";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  makeAiUsage,
  makeApplication,
  makeApplicationDetail,
  makeCvProfile,
  makeEvent,
  makeInterview,
  makeLead,
  makeNavCounts,
  makeReviewItem,
  makeSearchRun,
  makeSettings,
  makeSyncStatus,
  makeToday,
} from "../../test/factories";
import { mockApi } from "../../test/mock-api";
import { renderWithProviders } from "../../test/render";
import { App } from "../App";
import { ColorModeProvider } from "../ColorModeProvider";
import { es } from "./es";

/**
 * Every page, rendered in Spanish with realistic data, must show no English the app knows how to
 * translate: a label kept in a module-level constant, or a string that skipped `t()`, would show
 * here as its English text.
 */

const ME = {
  mode: "private",
  email: "owner@example.test",
  onboardingCompleted: true,
  timezone: "America/Monterrey",
};

const page = <T,>(items: T[]): Page<T> => ({ items, nextCursor: null });

function mockEverything(me: object = ME) {
  return mockApi({
    "GET /api/v1/me": () => me,
    "GET /api/v1/gmail/status": () => makeSyncStatus(),
    "GET /api/v1/nav-counts": () => makeNavCounts(),
    "GET /api/v1/today": () => makeToday(),
    "GET /api/v1/settings": () => makeSettings(),
    "GET /api/v1/applications": () =>
      page([makeApplication(), makeApplication({ id: "a2", status: "interviewing" })]),
    "GET /api/v1/applications/a1": () =>
      makeApplicationDetail({
        interviews: [makeInterview()],
        timeline: [makeEvent()],
      }),
    "GET /api/v1/leads": () => page([makeLead(), makeLead({ id: "l2", status: "shortlisted" })]),
    "GET /api/v1/search/runs": () => [makeSearchRun()],
    "GET /api/v1/interviews": () => page([makeInterview()]),
    "GET /api/v1/review-items": () => page([makeReviewItem()]),
    "GET /api/v1/cv": () => makeCvProfile(),
    "GET /api/v1/ai-usage": () => makeAiUsage(),
    "GET /api/v1/companies/exclusion-list": () => "Kestrel\nNorthwind\n",
  });
}

/** English messages whose Spanish differs, longest first, so a sentence wins over a word in it. */
const ENGLISH = Object.entries(es)
  .filter(([en, spanish]) => en !== spanish && !/\{\w+\}/.test(en) && en.length > 2)
  .map(([en]) => en);
const ENGLISH_SET = new Set(ENGLISH);

/** Text nodes and the attributes people read or hear, from the whole document. */
function visibleTexts(): string[] {
  const texts: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent?.trim();
    if (text) texts.push(text);
  }
  for (const el of document.body.querySelectorAll("[aria-label], [title], [placeholder], [alt]")) {
    for (const name of ["aria-label", "title", "placeholder", "alt"]) {
      const value = el.getAttribute(name)?.trim();
      if (value) texts.push(value);
    }
  }
  return texts;
}

function englishLeft(): string[] {
  return [...new Set(visibleTexts().filter((text) => ENGLISH_SET.has(text)))];
}

describe("the app in Spanish", () => {
  it.each([
    ["/today", "Hoy"],
    ["/applications", "Postulaciones"],
    ["/applications/a1", "Northwind Robotics"],
    ["/leads", "Vacantes"],
    ["/interviews", "Entrevistas"],
    ["/review", "Revisión"],
    ["/settings/gmail", "Configuración"],
    ["/settings/search", "Configuración"],
    ["/settings/cv", "Configuración"],
    ["/settings/targets", "Configuración"],
    ["/settings/timers", "Configuración"],
    ["/settings/automation", "Configuración"],
    ["/settings/import", "Configuración"],
    ["/settings/ai-usage", "Configuración"],
    ["/settings/data", "Configuración"],
    ["/leads/import", "Importar un reporte"],
  ])("%s shows no English", async (route, title) => {
    mockEverything();
    renderWithProviders(
      <ColorModeProvider>
        <App />
      </ColorModeProvider>,
      { route, locale: "es" },
    );
    expect(await screen.findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    // Let every query on the page answer before reading it.
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
    expect(englishLeft()).toEqual([]);
  });

  it("the sign-in page shows no English", async () => {
    mockApi({
      "GET /api/v1/me": () =>
        new Response(JSON.stringify({ error: { code: "unauthenticated", message: "x" } }), {
          status: 401,
        }),
    });
    renderWithProviders(<App />, { route: "/login", locale: "es" });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Qué bueno verte de nuevo" }),
    ).toBeInTheDocument();
    expect(englishLeft()).toEqual([]);
  });

  it("onboarding shows no English", async () => {
    mockEverything({ ...ME, onboardingCompleted: false });
    renderWithProviders(<App />, { route: "/onboarding", locale: "es" });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Configura Offerbound" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
    expect(englishLeft()).toEqual([]);
  });
});
