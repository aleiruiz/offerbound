import type { FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { ApiError } from "../http/errors.js";

/**
 * The demo's read-only guard (TECHNICAL_SPEC §12, SECURITY §11, AC-16.6). A shared demo must not
 * let a visitor publish text to the next visitor, so every request that changes data is checked
 * against this table, which has one line for every mutating route:
 *
 * - `allow`: no free text goes in (status changes, shortlist and dismiss, undo, follow-up done,
 *   review actions, rerank, mark applied, *Run search now*, *Simulate an incoming email*).
 * - `block`: free text, a file, or something that needs a mailbox the demo does not have.
 * - `{ patch }`: a PATCH, allowed only while the body carries these keys and no others. A key
 *   outside the list (notes, a title, a URL, a company name) is free text.
 * - `resolve`: the review action route, which carries free text only in `edit_apply`.
 *
 * A mutating route that is not in the table is blocked, so a new route is read-only in the demo
 * until someone decides otherwise; a test walks the registered routes and fails until they do.
 * Reads always pass. Everything is answered with `403 demo_read_only`.
 */
type Rule =
  "allow" | "block" | { patch: readonly string[]; emptyOnly?: readonly string[] } | "resolve";

export const DEMO_RULES: Readonly<Record<string, Rule>> = {
  // Free text, files and manual records.
  "POST /cv": "block",
  "POST /cv/retry-profile": "block",
  "POST /leads": "block",
  "POST /applications": "block",
  "POST /applications/:id/interviews": "block",
  "PUT /settings": "block",
  "POST /data/purge-email-content": "block",
  "POST /import/sheet/preview": "block",
  "POST /import/sheet/commit": "block",
  "POST /leads/import/preview": "block",
  "POST /leads/import/commit": "block",
  "POST /companies/:id/merge": "block",
  // There is no mailbox to connect, and re-reading a message needs the real one.
  "POST /gmail/start": "block",
  "POST /gmail/sync": "block",
  "POST /gmail/disconnect": "block",
  "POST /messages/:id/reprocess": "block",

  // Edits: only the fields that are not text.
  "PATCH /applications/:id": { patch: ["version", "status", "appliedAt", "workMode"] },
  "PATCH /interviews/:id": { patch: ["version", "kind", "status", "startsAt", "endsAt"] },
  // A dismiss reason is text: `""` (no reason) passes.
  "PATCH /leads/:id": {
    patch: ["version", "status", "dismissedReason"],
    emptyOnly: ["dismissedReason"],
  },
  "PATCH /companies/:id": { patch: ["version", "groupId"] },

  // Actions without free text.
  "POST /applications/:id/follow-up-done": "allow",
  "POST /applications/:id/merge": "allow",
  "POST /leads/rerank": "allow",
  "POST /leads/:id/mark-applied": "allow",
  "POST /leads/:id/reconsider": "allow",
  "POST /events/:id/undo": "allow",
  "POST /review-items/:id/resolve": "resolve",
  "POST /daily-activity": "allow",
  "POST /search/run": "allow",
  "POST /onboarding/complete": "allow",
  "POST /demo/simulate-email": "allow",
};

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const API_PREFIX = "/api/v1";

/** `POST /api/v1/leads/:id/reconsider` → `POST /leads/:id/reconsider`. */
export function demoRuleKey(method: string, url: string): string {
  const path = url.startsWith(API_PREFIX) ? url.slice(API_PREFIX.length) : url;
  return `${method.toUpperCase()} ${path}`;
}

const readOnly = (): ApiError =>
  new ApiError(
    403,
    "demo_read_only",
    "The demo is read-only for anything you type. Status changes, shortlisting and undo work.",
  );

function bodyObject(request: FastifyRequest): Record<string, unknown> | null {
  const body: unknown = request.body;
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/** Review actions that would re-read the mailbox, or that carry the visitor's own text. */
const BLOCKED_REVIEW_ACTIONS = new Set(["reprocess", "retry", "edit_apply"]);

/** True when the request may go on. */
function permitted(request: FastifyRequest, rule: Rule | undefined): boolean {
  if (rule === "allow") return true;
  if (rule === undefined || rule === "block") return false;
  const body = bodyObject(request);
  if (rule === "resolve") {
    return (
      body !== null && !BLOCKED_REVIEW_ACTIONS.has(String(body.action)) && body.edits === undefined
    );
  }
  if (body === null) return false;
  return Object.entries(body).every(([name, value]) => {
    if (!rule.patch.includes(name)) return false;
    return !rule.emptyOnly?.includes(name) || value === "" || value === undefined;
  });
}

/** A `preHandler` for the guarded scope of a demo instance; private instances do not register it. */
export function demoReadOnlyGuard(): preHandlerAsyncHookHandler {
  return (request) => {
    if (!MUTATING.has(request.method)) return Promise.resolve();
    const rule = DEMO_RULES[demoRuleKey(request.method, request.routeOptions.url ?? "")];
    return permitted(request, rule) ? Promise.resolve() : Promise.reject(readOnly());
  };
}
