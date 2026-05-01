# Spec: Research Doc Review & Versioning Tool

Working name: 'docket' (Referred to below as "the service.")

## 1. Purpose

A tool for research teams to manage structured review of Google Docs across drafts, audiences, and organizations — without abandoning Google Docs as the writing surface. It addresses three concrete pain points:

- Forking a doc for an external review audience while the original keeps evolving, then integrating comments back.
- Maintaining derivative versions of a doc with systematic edits (redactions, audience-specific context) that can be re-applied as the parent changes.
- Coordinating multi-version, multi-reviewer feedback cycles across organizations, with a clear record of who reviewed what and when.

It does *not* attempt full GitHub-style branching/merging on rich text. The semantics are: snapshots, overlays, canonical comments projected across versions, and lightweight review-request workflows, perhaps using `git` as the mechanism for tracking/computing these changes.

## 2. Core concepts

**Project.** A long-lived workspace tied to a single canonical Google Doc (the *parent*). Owns the version history, comment graph, overlays, and review records for that doc.

**Version (snapshot).** A frozen copy of the parent at a moment in time. Created when a review is requested or explicitly checkpointed. Each version is a real Google Doc, copied via the Drive API, with a recorded parent→child relationship in the service's DB.

**Overlay.** A named, ordered list of content-addressed edit operations (redact, replace, insert, append) applied to a parent to produce a derivative. Stored in the service's DB, re-applicable, version-tracked.

**Canonical comment.** The service's own representation of a comment thread. Stored in the DB, anchored by quoted text + structural context, projected into one or more Google Doc versions as native comments. Carries status (open / addressed / wontfix / superseded), origin metadata, and a history of which versions it has been projected into.

**Review request.** A bundle of: a frozen version, a list of reviewers, a deadline, status, and a Slack/web thread for coordination. The unit users interact with when asking for feedback.

**Participant.** A user of the service, authenticated via Google OAuth (light scopes) or other auth. Distinct from "doc owner," who is the participant whose Google credentials authorize the service's Drive operations on a project.

## 3. Architecture overview

Three layers:

**Backend service** (the source of truth). Owns the database, runs the reanchoring engine, holds the Drive OAuth tokens for doc owners, polls/watches docs for changes, exposes a REST/GraphQL API to the surfaces.

**Surfaces** (read/write views onto the backend):
- Slack bot (primary interaction surface)
- Google Workspace add-on (contextual sidebar inside Docs)
- Web app (full UI for diff views, reconciliation, dashboards, settings)

**Google integration layer** within the backend, handling Drive/Docs API calls, OAuth token management, and Drive push-notification subscriptions.

The architectural rule: **all state lives in the backend.** Surfaces are views. A comment, version, or overlay is real because the backend says so, not because Google or Slack says so.

## 4. Data model

Approximate schema, normalized:

**`project`**: id, parent_doc_id (Google), owner_user_id, created_at, settings (default reviewers, default overlay, etc.).

**`version`**: id, project_id, google_doc_id (the copy), parent_version_id (nullable), label (e.g., "v2"), created_at, created_by_user_id, snapshot_content_hash, status (active / archived).

**`overlay`**: id, project_id, name, ordered list of operations (JSON), created_at.

**`overlay_operation`**: type (redact / replace / insert / append), anchor (quoted text + context for content-addressed matching), payload (replacement text, inserted content), confidence_threshold.

**`derivative`**: id, project_id, version_id (the source snapshot), overlay_id, google_doc_id (the produced copy), audience_label, created_at.

**`canonical_comment`**: id, project_id, origin_version_id, origin_user_id, origin_timestamp, anchor (quoted text + paragraph hash + structural position), body, status, parent_comment_id (for replies).

**`comment_projection`**: canonical_comment_id, version_id, google_comment_id, anchor_match_confidence, projection_status (clean / fuzzy / orphaned / manually-resolved), last_synced_at.

**`review_request`**: id, project_id, version_id, status (open / closed / cancelled), deadline, slack_thread_ref, created_at, created_by_user_id.

**`review_assignment`**: review_request_id, user_id, status (pending / reviewed / changes_requested / declined), responded_at.

**`user`**: id, email, google_subject_id (OAuth `sub`), display_name, home_org (derived from email domain), auth_method.

**`drive_credential`**: user_id, scope, refresh_token (encrypted), associated_project_ids — only doc owners need these.

**`audit_log`**: actor, action, target, before/after snapshots for sensitive operations (sharing changes, version deletions, overlay applications).

## 5. Backend services

**Doc-watcher.** For each project, subscribes to Drive push notifications on the parent and all active forks. Falls back to polling if the watch channel expires or fails. On change events, fetches comments via the Drive API and updates the canonical comment store.

**Reanchoring engine.** Given a canonical comment with an anchor and a target version, finds the best match in the target. Algorithm: exact text match (high confidence) → fuzzy match within paragraph (medium, scored by edit distance and structural context) → no match (orphan, surfaced for human review). Returns a match with confidence score; backend decides automatic projection vs. manual reconciliation based on configurable thresholds.

**Overlay applier.** Given an overlay and a target doc, translates each operation into a `documents.batchUpdate` request via the Docs API. Operations whose anchors don't match cleanly are surfaced for review rather than silently skipped.

**Review orchestrator.** Manages review-request lifecycles: creating forks, sharing with reviewers, posting Slack threads, sending notifications, computing aggregate status, closing requests and triggering comment pull-back.

**Notification dispatcher.** Routes events to surfaces: Slack messages, add-on UI updates (via push or polling), web-app real-time updates, email fallback for users without Slack.

**Auth service.** Handles Google OAuth flows, token storage and refresh, scope verification (especially the Workspace doc-owner flow vs. the lightweight participant flow), and identity verification across orgs.

## 6. The three surfaces

### 6.1 Slack bot

Primary interface for review coordination. Slash commands and interactive components.

**Commands:**
- `/review-request <doc-url> @reviewers [--overlay name] [--deadline date] [--audience label]` — creates a fork (with optional overlay), shares with reviewers, posts a tracked thread in the current channel.
- `/review-status [project|reviewer]` — dashboard of open reviews.
- `/review-close <id>` — closes a review, pulls comments back into canonical store, projects onto current parent.

**Interactive elements:**
- Review thread message: shows version label, reviewer list with status icons, comment count, deadline, action buttons (open doc, pull comments now, extend deadline, add reviewer, close).
- Home tab: "Reviews waiting on you" / "Your open requests" / "Recent activity."
- DMs: per-user notifications when assigned to a review, when a comment is added, when a reviewer responds.

**Cross-org behavior:** uses Slack Connect channels when both orgs have Slack and a shared channel exists. Falls back to email + web app notifications for external reviewers without Slack access. Comment content is rendered in the Slack thread with proper attribution, regardless of how it was authored in the doc.

### 6.2 Workspace add-on

Sidebar inside Google Docs, contextual to the open doc. Built as a Google Workspace Add-on (not the older Editor add-on) using CardService.

**When the open doc is a project parent:**
- Version list, with status per version.
- Active review requests on each version.
- Pending comment reanchoring (when a review was just closed and comments need merging in).
- Buttons: "Request review," "Create version checkpoint," "Open project in web app."

**When the open doc is a fork (review version or derivative):**
- Banner: "This is v2 of [project], for [audience]" or "This is the v2 review fork — author is editing v3 in [link]."
- Reviewer status summary.
- Buttons: "Mark reviewed," "Open Slack thread," "Back to parent."

**When the open doc is unknown to the service:**
- Onboarding card: "Track this doc with [service]?" with a button to create a new project.

The add-on calls the backend over HTTPS with an Apps Script identity token; the backend verifies and authorizes per-user. The add-on does not hold Drive scopes itself — it reads the doc's structure via Apps Script's built-in document access, but all metadata about versions/reviews/comments comes from the backend.

**Degradation:** if the user's org hasn't installed the add-on, all functionality remains available via Slack and the web app.

### 6.3 Web app

Full UI for the things Slack and the add-on do badly.

- **Project dashboard:** versions, derivatives, review history, reviewer participation graph.
- **Side-by-side version diff:** rendered HTML view of two versions with diffs highlighted, comments visible in the gutter.
- **Comment reconciliation UI:** when reanchoring is ambiguous or fails, this is where the user accepts/edits/discards proposed projections.
- **Overlay editor:** create and edit overlays, test them against the current parent, see which operations resolve cleanly vs. need attention.
- **Settings:** notification preferences, default reviewers, Slack workspace linking, Google account connection, org/team management.
- **External reviewer landing page:** when an external reviewer is assigned, they get a link to a focused page showing the doc, their assignment, and a "mark reviewed" action.

## 7. Workflows

### 7.1 Single-org review request

1. Author runs `/review-request` in Slack with a doc URL and reviewer list.
2. Backend verifies the author has connected their Google account with `drive.file` scope on the doc; if not, prompts them to authorize.
3. Backend creates a Version: copies the doc via `files.copy`, applies any specified overlay, sets sharing permissions for reviewers.
4. Backend creates a Review Request, posts a Slack thread, DMs each reviewer.
5. Reviewers comment natively in Google Docs. Doc-watcher ingests comments into canonical store, projecting them onto the version with proper attribution.
6. Slack thread updates as comments arrive (configurable: per-comment notifications, or batched summaries).
7. Reviewers click "Mark reviewed" in Slack/sidebar/web. Status updates aggregate.
8. Author runs `/review-close` (or backend auto-closes when all reviewers are done). Comments are projected onto the current parent via the reanchoring engine; clean matches sync automatically, ambiguous/orphan comments surface in the reconciliation UI.

### 7.2 Cross-org review

Same as above, with these differences:

- The shared Google Doc cross-org sharing is what gives external reviewers access to read and comment.
- External reviewer signs into the web app (or accepts a Slack Connect invite) to mark review status. Identity is verified by matching the Google OAuth `sub`/email against the doc's share list.
- Comments are still ingested via the doc owner's Drive token (no need for the external reviewer to grant any Drive scopes).
- If the external reviewer's org has not installed the add-on, they use the web app instead.

### 7.3 Derivative with overlay

1. Author opens overlay editor in web app or sidebar, defines operations (redact section X, append context Y).
2. Author saves overlay, names it, assigns to project.
3. Author runs "Create derivative" with the overlay against the current parent.
4. Backend copies parent, applies overlay via `documents.batchUpdate`, records the derivative with its source version + overlay.
5. Author shares derivative with audience.
6. Later, author updates parent. Author runs "Refork derivative" → backend re-copies new parent, re-applies overlay; operations whose anchors no longer match cleanly are surfaced for review.

### 7.4 Multi-version review cycle

1. v1 is reviewed, comments are ingested as canonical comments anchored to v1.
2. Author edits parent based on feedback.
3. Author requests review on v2. Canonical comments from v1 are projected onto v2 via the reanchoring engine: clean matches show as "still open from v1"; substantially-changed text shows as "likely addressed — confirm?"; deleted-text comments show as "previous-version context" (sidebar only, not native Doc comments).
4. v2 reviewers comment; new canonical comments are created.
5. Author can mark v1 comments as addressed. Replies on v2 are linked to canonical comments by ID, so reply chains compose across versions.
6. v3 review repeats the projection.

## 8. Authentication and authorization

**Doc owners** authorize the service with Google OAuth, scope `drive.file`, granting access to the specific docs they want managed. The service stores and refreshes tokens. This is the only Google scope the service ever holds for active doc operations.

**Participants** sign into the service. Acceptable methods:
- Google OAuth with no Drive scope (just identity)
- SSO (SAML/OIDC) for enterprise customers
- Magic-link email auth (fallback for external reviewers without Google accounts)

**Slack identity** is linked to service identity via Slack OAuth + email match.

**Authorization model in the service** is project-scoped. Each project has owner / collaborator / reviewer / observer roles. External reviewers are added per-review-request with reviewer-scope access to that version only.

**Data isolation:** projects belong to a tenant (org). Cross-org review is modeled as inviting users from other tenants to a specific review request, not as merging tenants.

## 9. Privacy and security

- Drive refresh tokens encrypted at rest with envelope encryption.
- Audit log for all sensitive operations (sharing changes, version creation/deletion, overlay applications, comment projections).
- Doc content is fetched on demand and cached only as long as needed for reanchoring; canonical comment store holds quoted snippets, not full doc bodies.
- Configurable data residency per tenant (EU-only deployment option for projects with that requirement).
- The service refuses to operate on docs whose Workspace policies forbid third-party app access.
- The add-on uses minimal scopes; the backend never asks participants for broad Drive access.

## 10. Out-of-scope for v1

- Real-time merge of edits across versions (only comments and overlays are reconciled; doc text edits aren't auto-merged).
- Image- or table-anchored comment reanchoring (handled as orphans, surfaced for manual placement).
- Deep integration with Google Docs suggesting-mode (tracked changes) — v1 ingests them as orphan-flagged "suggested edit from reviewer" entries.
- A native mobile UI (Slack mobile + web responsive is enough).
- Workspace Marketplace public listing (private/domain installation only at v1).

## 11. Build sequence

A reasonable order of construction:

**Phase 1 — Core engine.** Project/version model, doc-copy + overlay application, canonical comment store, reanchoring engine, Drive doc-watcher. CLI or minimal web UI for testing. No Slack, no add-on yet.

**Phase 2 — Slack bot.** Review request lifecycle, threads, notifications, reviewer status. Slack becomes the primary user-facing surface.

**Phase 3 — Web app.** Reconciliation UI, diff views, overlay editor, dashboards, external reviewer flow. Needed before cross-org meaningfully works.

**Phase 4 — Workspace add-on.** Sidebar in Google Docs, contextual version/review display, action buttons. Adoption-friendly but not blocking.

**Phase 5 — Cross-org polish.** Slack Connect support, external reviewer onboarding flow, identity verification, sharing-policy error handling.

**Phase 6 — Marketplace listing, advanced overlays, suggesting-mode handling, automated comment classification (was this addressed?), and other refinements.**

Phases 1–3 are roughly the MVP — they cover both stated pain points and the multi-version review workflow. Phases 4–5 are polish that materially improves UX in real research contexts. Phase 6 is "after we've seen how teams actually use it."
