import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Demo smoke test (TECHNICAL_SPEC §15; AC-16.2 to 16.4, 16.6): the demo loads Today without a
 * sign-in, and *Simulate an incoming email* changes an application's status or interview and adds
 * a timeline entry. Runs against `DEMO_BASE_URL` (see playwright.config.ts). All data in the demo is
 * made up.
 */

interface ApplicationRow {
  id: string;
  status: string;
  nextInterviewAt: string | null;
}
interface ApplicationsPage {
  items: ApplicationRow[];
}
interface ApplicationRecord extends ApplicationRow {
  company: { name: string };
  timeline: unknown[];
}

/**
 * The public API allows 300 requests a minute per client. The list is one request, so it is what
 * gets polled; a record (one request each) is read only for the applications that changed.
 */
async function listApplications(request: APIRequestContext): Promise<Map<string, ApplicationRow>> {
  const res = await request.get("/api/v1/applications?limit=100");
  expect(res.ok()).toBe(true);
  const { items } = (await res.json()) as ApplicationsPage;
  return new Map(items.map((row) => [row.id, row]));
}

async function readApplication(request: APIRequestContext, id: string): Promise<ApplicationRecord> {
  const res = await request.get(`/api/v1/applications/${encodeURIComponent(id)}`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as ApplicationRecord;
}

/** Polls until `changedId` finds an application: its id, or null after `timeoutMs`. */
async function waitForChange(
  request: APIRequestContext,
  before: Map<string, ApplicationRow>,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const id = changedId(before, await listApplications(request));
    if (id !== null || Date.now() >= deadline) return id;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
}

/**
 * The first application that is new, or whose status or next interview differs, between two
 * lists: its id, or null. (An interview invite for a company without a record creates one.)
 */
function changedId(
  before: Map<string, ApplicationRow>,
  after: Map<string, ApplicationRow>,
): string | null {
  for (const [id, now] of after) {
    const was = before.get(id);
    if (!was || was.status !== now.status || was.nextInterviewAt !== now.nextInterviewAt) return id;
  }
  return null;
}

test.describe("the public demo", () => {
  test("loads Today without signing in, with the demo banner", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
    const banner = page.getByRole("region", { name: "Demo" });
    await expect(banner).toContainText("Demo with made-up data. Everything resets every hour.");
    await expect(banner.getByRole("button", { name: "Simulate an incoming email" })).toBeEnabled();
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  });

  test("free-text controls are disabled", async ({ page }) => {
    await page.goto("/applications");
    await expect(page.getByRole("button", { name: "Add application" })).toBeDisabled();
    await page.goto("/settings/data");
    await expect(page.getByRole("button", { name: "Delete stored email content" })).toBeDisabled();
  });

  test("Simulate an incoming email changes an application and adds a timeline entry", async ({
    page,
    request,
  }) => {
    // The demo walks a fixed list of emails (TECHNICAL_SPEC §12): a reschedule (the interview
    // moves, the status stays), an offer, a rejection, ... Some of them bring a lead or a review
    // item instead of changing an application, and a visitor may have used the first ones already.
    // So send emails until one changes an application's status or interview (an owner follow-up
    // adds a timeline entry only), then check what AC-16.4 asks for: the change the visitor can see
    // and a new timeline entry.
    test.setTimeout(150_000);
    const beforeList = await listApplications(request);
    expect(beforeList.size).toBeGreaterThan(0);
    const beforeRecords = new Map(
      await Promise.all(
        [...beforeList.keys()].map(async (id) => [id, await readApplication(request, id)] as const),
      ),
    );

    await page.goto("/today");
    const simulate = page.getByRole("button", { name: "Simulate an incoming email" });
    let changed: string | null = null;
    for (let sent = 0; sent < 12 && changed === null; sent += 1) {
      await expect(simulate).toBeEnabled();
      // The answer comes after the inline pipeline (triage, extraction, apply) has run.
      const answered = page.waitForResponse(
        (res) => res.url().includes("/demo/simulate-email") && res.request().method() === "POST",
      );
      await simulate.click();
      expect((await answered).status()).toBe(202);
      await expect(
        page.getByRole("status").filter({ hasText: "Simulated an email" }).first(),
      ).toBeVisible();
      // Allow for a slow demo before treating this email as one that changed no application.
      changed = await waitForChange(request, beforeList, 5_000);
    }
    if (changed === null) {
      throw new Error(
        "no simulated email changed an application; the demo's emails may all be used (it resets every hour)",
      );
    }

    const now = await readApplication(request, changed);
    const entriesBefore = beforeRecords.get(changed)?.timeline.length ?? 0;
    expect(now.timeline.length).toBeGreaterThan(entriesBefore);

    // The page shows the entry too.
    await page.goto(`/applications/${encodeURIComponent(now.id)}`);
    await expect(page.getByRole("heading", { level: 1, name: now.company.name })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
    const entries = page.getByRole("list", { name: "Application timeline" }).getByRole("listitem");
    await expect(entries).toHaveCount(now.timeline.length);
  });
});
