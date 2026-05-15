import {
  parseReviewActionKind,
  redeemReviewActionToken,
  type RedeemOutcome,
} from "../domain/review-action.ts";
import type { ReviewActionKind } from "../db/schema.ts";
import { renderPage } from "./render.ts";
import { ReviewActionPage } from "./pages/ReviewActionPage.tsx";
import {
  ReviewActionChooserPage,
  type ChooserAction,
} from "./pages/ReviewActionChooserPage.tsx";

/**
 * GET /r/<token>?action=<kind> — magic-link review action handler
 * (SPEC §6.3 + §12 Phase 4). External reviewers receive emails with one
 * link per assignment that includes a `?action=` query string per button
 * ("Mark reviewed", "Decline", "Request changes", "Accept reconciliation").
 *
 * Tokens are multi-use until expiry: the reviewer can re-click a different
 * action to change their response, and replaying the same action is a
 * no-op state-wise (the audit log still records the click).
 *
 * Sits on the secured (non-CORS) side of the API — these URLs are
 * navigated to from email clients, not fetched cross-origin. Render an
 * HTML confirmation page so the recipient sees a result, not a JSON blob.
 *
 * Hitting `/r/<token>` without `?action=` renders a friendly chooser page
 * with one button per action — handles email clients that strip query
 * strings or reviewers who paste the URL without the query intact.
 */
export async function handleReviewActionGet(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = extractToken(url.pathname);
  if (!token) return renderResult({ status: 404, kind: "missing" });

  const action = parseReviewActionKind(url.searchParams.get("action"));
  if (!action) {
    return renderChooser(token, url.searchParams.get("action"));
  }

  const outcome = await redeemReviewActionToken(token, action);
  return renderResult(toPage(outcome));
}

function extractToken(pathname: string): string | null {
  // Pathname is `/r/<token>` (Bun.serve route registration). Be defensive
  // against trailing slashes and stray segments.
  const m = /^\/r\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  return decodeURIComponent(m[1]!);
}

type PageState =
  | { status: 200; kind: "success"; action: ReviewActionKind }
  | { status: 404; kind: "missing" | "invalid" | "expired" }
  | { status: 409; kind: "assignment_missing" };

function toPage(outcome: RedeemOutcome): PageState {
  if (outcome.ok) {
    return { status: 200, kind: "success", action: outcome.action };
  }
  if (outcome.reason === "assignment_missing") {
    return { status: 409, kind: "assignment_missing" };
  }
  return { status: 404, kind: outcome.reason };
}

interface PageCopy {
  title: string;
  body: string;
  tone: "ok" | "err";
}

function copyFor(page: PageState): PageCopy {
  switch (page.kind) {
    case "success":
      return {
        title: actionTitle(page.action),
        body: actionBody(page.action),
        tone: "ok",
      };
    case "missing":
    case "invalid":
      return {
        title: "Link not recognized",
        body: "This link doesn't look like a Margin action URL. Check the original email — links are case-sensitive and shouldn't be edited.",
        tone: "err",
      };
    case "expired":
      return {
        title: "Link expired",
        body: "This action link is no longer valid. Ask the requester to resend the review request, or sign in to the Margin web app to respond directly.",
        tone: "err",
      };
    case "assignment_missing":
      return {
        title: "Assignment unavailable",
        body: "The review assignment this link points to is no longer available — it may have been cancelled. Contact the requester for an updated link.",
        tone: "err",
      };
  }
}

function actionTitle(action: ReviewActionKind): string {
  switch (action) {
    case "mark_reviewed":
      return "Marked as reviewed";
    case "decline":
      return "Declined";
    case "request_changes":
      return "Changes requested";
    case "accept_reconciliation":
      return "Reconciliation accepted";
  }
}

function actionBody(action: ReviewActionKind): string {
  switch (action) {
    case "mark_reviewed":
      return "Thanks — Margin recorded your review. You can change your response by re-clicking a different action link until the request expires.";
    case "decline":
      return "Recorded — you've declined this review. You can change your response by re-clicking a different action link until the request expires.";
    case "request_changes":
      return "Recorded — Margin has flagged that you've requested changes on this version. You can change your response by re-clicking a different action link until the request expires.";
    case "accept_reconciliation":
      return "Confirmed — Margin has acknowledged the cross-version comment match.";
  }
}

const STATIC_CSP =
  "default-src 'none'; style-src 'self'; font-src 'self'; frame-ancestors 'none'";

function renderResult(page: PageState): Response {
  const copy = copyFor(page);
  return renderPage(
    <ReviewActionPage title={copy.title} body={copy.body} tone={copy.tone} />,
    { csp: STATIC_CSP, status: page.status },
  );
}

const CHOOSER_ACTIONS: readonly ChooserAction[] = [
  { kind: "mark_reviewed", label: "Mark reviewed" },
  { kind: "request_changes", label: "Request changes" },
  { kind: "decline", label: "Decline" },
  { kind: "accept_reconciliation", label: "Accept reconciliation" },
];

function renderChooser(token: string, rawParam: string | null): Response {
  const status = rawParam ? 400 : 200;
  return renderPage(
    <ReviewActionChooserPage
      token={token}
      rejectedAction={rawParam ?? undefined}
      actions={CHOOSER_ACTIONS}
    />,
    { csp: STATIC_CSP, status },
  );
}
