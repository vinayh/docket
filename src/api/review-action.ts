import {
  redeemReviewActionToken,
  type RedeemOutcome,
} from "../domain/review-action.ts";
import type { ReviewActionKind } from "../db/schema.ts";

/**
 * GET /r/<token> — magic-link review action handler (SPEC §6.3 + §12
 * Phase 4). External reviewers receive emails with four links per
 * assignment ("Mark reviewed", "Decline", "Request changes", "Accept
 * reconciliation"); each link embeds a single-use token issued by
 * `issueReviewActionToken`.
 *
 * Sits on the secured (non-CORS) side of the API — these URLs are
 * navigated to from email clients, not fetched cross-origin. Render an
 * HTML confirmation page so the recipient sees a result, not a JSON blob.
 *
 * Re-clicking a used link is fine: we render a friendly "already
 * recorded" page rather than a 404.
 */
export async function handleReviewActionGet(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = extractToken(url.pathname);
  if (!token) return renderPage({ status: 404, kind: "missing" });

  const outcome = await redeemReviewActionToken(token);
  return renderPage(toPage(outcome));
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
  | { status: 404; kind: "missing" | "invalid" | "expired" | "already_used" }
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
    case "already_used":
      return {
        title: "Already recorded",
        body: "Your response was already recorded against this assignment. No further action needed.",
        tone: "ok",
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
      return "Thanks — Margin recorded your review. The requester has been notified.";
    case "decline":
      return "Recorded — you've declined this review. The requester has been notified.";
    case "request_changes":
      return "Recorded — Margin has flagged that you've requested changes on this version. The requester has been notified.";
    case "accept_reconciliation":
      return "Confirmed — Margin has acknowledged the cross-version comment match.";
  }
}

function renderPage(page: PageState): Response {
  const copy = copyFor(page);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Margin — ${escapeHtml(copy.title)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root { color-scheme: light dark; }
    body { font: 15px/1.55 system-ui, sans-serif; max-width: 480px; margin: 6rem auto; padding: 0 1.5rem; color: #1f2328; }
    h1 { font-size: 20px; margin: 0 0 0.75rem; }
    p  { margin: 0.5rem 0; }
    .tone-ok h1 { color: #0a7d2c; }
    .tone-err h1 { color: #b00020; }
    .footer { margin-top: 2rem; font-size: 12px; opacity: 0.7; }
    @media (prefers-color-scheme: dark) {
      body { color: #e6edf3; background: #0d1117; }
      .tone-ok h1 { color: #46d164; }
      .tone-err h1 { color: #ff7785; }
    }
  </style>
</head>
<body class="tone-${copy.tone}">
  <h1>${escapeHtml(copy.title)}</h1>
  <p>${escapeHtml(copy.body)}</p>
  <p class="footer">Margin · review action handler</p>
</body>
</html>`;
  return new Response(html, {
    status: page.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
