import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Demo smoke test (TECHNICAL_SPEC §15; AC-16.2 to 16.4, 16.6): the demo loads Today without a
 * sign-in, and *Simulate an incoming email* changes an application's status and adds a timeline
 * entry. Runs against `DEMO_BASE_URL` (see playwright.config.ts). All data in the demo is made up.
 */

interface ApplicationRow {
  id: string;
  status: string;
}
interface ApplicationsPage {
  items: ApplicationRow[];
}
interface ApplicationRecord {
  id: string;
  status: string;
  company: { name: string };
  timeline: unknown[];
}

const ENTRY_COUNT = (record: ApplicationRecord) => record.timeline.length;

/** Every application with its status and the number of timeline entries. */
async function snapshot(request: APIRequestContext): Promise<Map<string, ApplicationRecord>> {
  const list = await request.get("/api/v1/applications?limit=100");
  expect(list.ok()).toBe(true);
  const { items } = (await list.json()) as ApplicationsPage;
  const records = await Promise.all(
    items.map(async ({ id }) => {
      const res = await request.get(`/api/v1/applications/${encodeURIComponent(id)}`);
      expect(res.ok()).toBe(true);
      return (await res.json()) as ApplicationRecord;
    }),
  );
  return new Map(records.map((record) => [record.id, record]));
}

/** The application whose status moved between two snapshots, with the one it was, or null. */
function moved(
  before: Map<string, ApplicationRecord>,
  after: Map<string, ApplicationRecord>,
): { was: ApplicationRecord; now: ApplicationRecord } | null {
  for (const [id, now] of after) {
    const was = before.get(id);
    if (was && was.status !== now.status) return { was, now };
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

  test("Simulate an incoming email changes a status and adds a timeline entry", async ({
    page,
    request,
  }) => {
    const before = await snapshot(request);
    expect(before.size).toBeGreaterThan(0);

    await page.goto("/today");
    await page.getByRole("button", { name: "Simulate an incoming email" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Simulated an email" })).toBeVisible();

    // The pipeline runs inline (TECHNICAL_SPEC §12); allow for a slow demo before giving up.
    await expect
      .poll(async () => moved(before, await snapshot(request)) !== null, { timeout: 30_000 })
      .toBe(true);
    const change = moved(before, await snapshot(request));
    if (!change) throw new Error("no application changed status");

    // The record carries the new entry, and the page shows it.
    expect(ENTRY_COUNT(change.now)).toBeGreaterThan(ENTRY_COUNT(change.was));
    await page.goto(`/applications/${encodeURIComponent(change.now.id)}`);
    await expect(
      page.getByRole("heading", { level: 1, name: change.now.company.name }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
    const entries = page.getByRole("list", { name: "Application timeline" }).getByRole("listitem");
    await expect(entries).toHaveCount(ENTRY_COUNT(change.now));
  });
});
