# Spec: Research Doc Review & Versioning Tool

Working name: 'Docket' (Referred to below as "the service.")

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
- Slack bot (primary interaction surface for review coordination)
- Browser extension (rich UI: dashboards, diff viewer, comment reconciliation, overlay editor, settings; in-doc capture of API-blind annotations like suggestion-thread replies; later: in-canvas visualization)
- Google Workspace add-on (contextual Card-based sidebar inside Docs for users without the extension)
- Web entry points (minimal hosted shell — OAuth callbacks, Drive Picker host, magic-link action handlers, public landing page)

**Google integration layer** within the backend, handling Drive/Docs API calls, OAuth token management, and Drive push-notification subscriptions.

The architectural rule: **all state lives in the backend.** Surfaces are views. A comment, version, or overlay is real because the backend says so, not because Google or Slack says so.

## 4. Data model

Approximate schema, normalized:

**`project`**: id, parent_doc_id (Google), owner_user_id, created_at, settings (default reviewers, default overlay, etc.).

**`version`**: id, project_id, google_doc_id (the copy), parent_version_id (nullable), label (e.g., "v2"), created_at, created_by_user_id, snapshot_content_hash, status (active / archived).

**`overlay`**: id, project_id, name, ordered list of operations (JSON), created_at.

**`overlay_operation`**: type (redact / replace / insert / append), anchor (quoted text + context for content-addressed matching), payload (replacement text, inserted content), confidence_threshold.

**`derivative`**: id, project_id, version_id (the source snapshot), overlay_id, google_doc_id (the produced copy), audience_label, created_at.

**`canonical_comment`**: id, project_id, origin_version_id, origin_user_id, origin_timestamp, anchor (quoted text + paragraph hash + structural position), body, status, parent_comment_id (for replies). The anchor schema is rich enough to resolve to on-screen coordinates without help from Google's APIs — see §9.1.

**`comment_projection`**: canonical_comment_id, version_id, google_comment_id, anchor_match_confidence, projection_status (clean / fuzzy / orphaned / manually-resolved), last_synced_at.

**`review_request`**: id, project_id, version_id, status (open / closed / cancelled), deadline, slack_thread_ref, created_at, created_by_user_id.

**`review_assignment`**: review_request_id, user_id, status (pending / reviewed / changes_requested / declined), responded_at.

**`user`**: id, email, google_subject_id (OAuth `sub`), display_name, home_org (derived from email domain), auth_method.

**`drive_credential`**: user_id, scope, refresh_token (encrypted), associated_project_ids — only doc owners need these.

**`audit_log`**: actor, action, target, before/after snapshots for sensitive operations (sharing changes, version deletions, overlay applications).

## 5. Backend services

**Doc-watcher.** For each project, subscribes to Drive push notifications on the parent and all active forks. Falls back to polling if the watch channel expires or fails. On change events, fetches comments via the Drive API and updates the canonical comment store. Operationally: requires verified HTTPS endpoint, channel-renewer cron, and missed-event reconciliation. See §9.3.

**Reanchoring engine.** Given a canonical comment with an anchor and a target version, finds the best match in the target. Algorithm: exact text match (high confidence) → fuzzy match within paragraph (medium, scored by edit distance and structural context) → no match (orphan, surfaced for human review). Returns a match with confidence score; backend decides automatic projection vs. manual reconciliation based on configurable thresholds.

The service owns anchoring **end-to-end**. Canonical comment anchors are persisted in Docket's own schema (quoted text + paragraph hash + structural offset) rather than depending on the editor-internal anchor blob returned by the Drive API. Native comments returned by `drive.comments.list` carry an opaque kix anchor; Docket reads it as one input to reanchoring but never as an authoritative position. See §9.1 for why.

**Comment projection strategy.** Projecting a canonical comment back into a Google Doc as a native comment cannot produce an anchored comment via any public API (§9.1). Native comments produced by Docket are therefore unanchored from Google's perspective — they appear in the comment side panel without an in-doc highlight. To preserve context for readers, the comment body is prefixed with the anchor's quoted text:

> `Re: "the actual quoted snippet" — <canonical comment body>`

For richer in-context UX, the add-on sidebar layers on a "comments at this paragraph" affordance backed by Docs API named ranges (`createNamedRange`) inserted at the projected location. Named ranges are invisible to readers but let Docket-aware surfaces render highlights, gutter markers, and click-to-jump UI. The browser extension surface (§6.4) extends this further with on-canvas overlays.

**Overlay applier.** Given an overlay and a target doc, translates each operation into a `documents.batchUpdate` request via the Docs API. Anchor-to-index resolution happens before the batch update — that's the reanchoring engine's job. Operations whose anchors don't match cleanly are surfaced for review rather than silently skipped. See §9.7 for the operation-to-API mapping.

**Review orchestrator.** Manages review-request lifecycles: creating forks, sharing with reviewers, posting Slack threads, sending notifications, computing aggregate status, closing requests and triggering comment pull-back.

**Notification dispatcher.** Routes events to surfaces: Slack messages, add-on UI updates (via push or polling), web-app real-time updates, email fallback for users without Slack.

**Auth service.** Handles Google OAuth flows, token storage and refresh, scope verification (especially the Workspace doc-owner flow vs. the lightweight participant flow), and identity verification across orgs.

## 6. The surfaces

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

**Cross-org behavior:** uses Slack Connect channels when both orgs have Slack and a shared channel exists. Falls back to assignment emails with magic-link actions for external reviewers without Slack access — they comment in the Google Doc directly and click a link to mark reviewed. Comment content is rendered in the Slack thread with proper attribution, regardless of how it was authored in the doc.

**Drive scope note:** when a user references a doc URL in Slack that they have not previously opened with the Docket Workspace Add-on (and that Docket did not itself create), the backend has no `drive.file` access to it. The bot must direct the user through the per-file authorization flow (open the doc with the add-on, or pick it via the Drive Picker entry page) before proceeding. See §9.2.

### 6.2 Workspace add-on

Sidebar inside Google Docs, contextual to the open doc. Built as a **unified Google Workspace Add-on** (the HTTP-backed framework — not the legacy Apps Script Editor add-on) with a UI built from CardService widgets and backed by Docket's HTTP API.

**When the open doc is a project parent:**
- Version list, with status per version.
- Active review requests on each version.
- Pending comment reanchoring (when a review was just closed and comments need merging in).
- Buttons: "Request review," "Create version checkpoint," "Open project in extension."

**When the open doc is a fork (review version or derivative):**
- Banner: "This is v2 of [project], for [audience]" or "This is the v2 review fork — author is editing v3 in [link]."
- Reviewer status summary.
- Buttons: "Mark reviewed," "Open Slack thread," "Back to parent."

**When the open doc is unknown to the service:**
- Onboarding card: "Track this doc with [service]?" with a button to create a new project. This is also how `drive.file` is granted for the doc — opening the add-on triggers the `onFileScopeGranted` flow, after which Docket's OAuth client gains Drive access to that specific file.

The add-on's HTTPS calls to the Docket backend carry an Apps Script identity token; the backend verifies and authorizes per-user. The add-on does not hold Drive scopes on its own — Drive access is held by the Docket OAuth client and is granted per-file through the file-scope flow described above. Per §8, this is the only Drive access Docket holds at any time.

**Scope of the surface.** The CardService UI is constrained to predefined widgets (text, buttons, sections, decorated text, selection inputs, dropdowns); arbitrary HTML/JS is not available, so deeper visualizations (side-by-side diffs, rich highlight overlays) live in the browser extension (§6.4). Selection / cursor access is also limited in the unified Card model — features that depend on capturing the user's current selection (e.g., "comment on this highlighted passage") fall back to manual snippet entry in the add-on, or are deferred to the browser-extension surface. See §9.4 and §9.5.

**Comment visualization.** The add-on side panel renders canonical comment threads with quoted-text snippets, projection status, and reply chains. Native comments produced by Docket appear in Google's comment side panel (unanchored, with the snippet inlined per §5). For richer "which paragraph has comments" affordance, the add-on cross-references named ranges to render a per-section comment count and a "jump to next comment" action.

**Degradation:** if the user's org hasn't installed the add-on, all functionality remains available via Slack and the browser extension.

### 6.3 Web entry points

A deliberately minimal hosted surface. The rich UI lives in the browser extension (§6.4); the web surface is just the bits that *must* be reachable via a public URL.

- **OAuth callback handlers** for Google sign-in and Drive scope grants.
- **Drive Picker host page** — a small HTML page that loads Google's Picker iframe; the canonical entry point for authorizing additional docs with `drive.file` (per §9.2). Linked from Slack onboarding and the extension popup.
- **Magic-link action handlers** — one-click endpoints like `/r/<token>` that fire a single state change (mark assignment reviewed, decline, request changes, accept reconciliation, etc.) and render a confirmation page. Used in assignment emails so external reviewers can act without an account.
- **Public landing page** — marketing/explainer for the Docket project; "install the extension" / "connect your Google account" CTAs.

Project dashboards, side-by-side diff viewer, comment reconciliation UI, overlay editor, and user settings live in the browser-extension surface (§6.4), not on the web. Rationale: anyone using Docket non-trivially has the extension installed (it's required to capture suggestion-thread replies and other API-blind annotations), so duplicating a rich UI on the web for users who don't have it adds maintenance cost without serving a real population. External reviewers and other non-installed users interact via Slack messages, magic-link actions in email, and Google Docs itself — no full web SPA needed.

**Mobile.** A native mobile UI (and a mobile-responsive web app) is out of scope. Slack mobile covers review actions on phones; mobile-authored doc comments still ingest through the Drive API. Mobile reviewers can still author suggestion-thread replies — those replies are recovered by any later desktop viewer with the extension installed (capture is opportunistic, not author-side). The honest gap is docs whose reviewers are entirely mobile or extension-less; revisit if real-world loss rates justify a mobile companion.

### 6.4 Browser extension

A Chrome / Firefox / Edge extension running on `docs.google.com/*` plus its own popup / options pages. It is the rich-UI surface for Docket; the hosted web shell (§6.3) intentionally does not duplicate any of this. The extension's responsibilities span three roles, delivered across three phases:

- **Capture role (MVP — Phase 2).** The Docs UI surfaces a class of annotations that the public Drive/Docs APIs do not expose — verified empirically. Confirmed gap: replies typed into a suggestion's sidebar entry. Without an extension, this data is invisible to Docket and is permanently lost when the doc moves on. The extension is the only signal path. Each suggestion + comment + reply visible in the discussion sidebar (which is regular DOM, not canvas) is scraped, matched to the corresponding canonical_comment via the kix discussion ID embedded in DOM attributes (preferred) or by quoted-text + author + timestamp (fallback), and POSTed to the backend.
- **Rich-UI role (Phase 4 — closes MVP).** The extension's popup / side-panel / options pages host:
  - **Project dashboard** — versions, derivatives, review history, reviewer participation graph.
  - **Side-by-side version diff** — rendered HTML view of two versions with diffs highlighted, comments visible in the gutter. (Rendered locally in the extension; reuses Diff/Match algorithms over plaintext extracted from `documents.get`.)
  - **Comment reconciliation UI** — for fuzzy / orphan projections produced by the reanchoring engine (§5).
  - **Overlay editor** — author and edit overlays, dry-run them against the current parent, see which ops resolve cleanly.
  - **Settings** — notification prefs, default reviewers, Slack workspace linking, Google account connection.
  All of this runs locally as a React app served from extension origin, talking to the Docket backend over HTTPS using the per-user API token issued in Phase 2.
- **Visualization role (Phase 6).** Highlights overlaid on the doc body, gutter markers at anchor positions, hover previews, right-click "comment on selection." The doc body is `<canvas>`-rendered (§9.6), so this requires the accessibility-DOM mirror or selection-event hooks — meaningfully heavier and on a different maintenance cadence than capture/UI. Acceptable fallbacks exist for users without the extension (add-on named-range bookkeeping, in-extension diff viewer) so this can wait.

The extension does not replace the Workspace Add-on. The add-on (§6.2) remains the install-free in-doc surface for users who don't or can't install a browser extension (enterprise IT block, mobile, etc.); they get a degraded experience for suggestion-thread data but full functionality for the comment-driven review workflow.

**Capture-role responsibilities (Phase 2):**
- Watch the discussion sidebar with a `MutationObserver`, treating it as the source of truth for annotations the API misses.
- Scrape each visible reply on a suggestion's sidebar entry: author, timestamp, body, and the kix discussion ID it belongs to.
- Match each scraped entry to Docket's canonical state: kix discussion ID from DOM attributes (preferred), falling back to quoted-text + author + timestamp.
- POST to the backend; backend inserts a `canonical_comment` (`kind=comment`, `parent_comment_id` pointing at the suggestion's row). Idempotency keyed on the DOM-side stable ID.
- Maintain a "seen IDs" set in extension storage to avoid duplicate POSTs across page reloads.

**Rich-UI-role responsibilities (Phase 4):** see the bullet list above — dashboards, diff, reconciliation, overlay editor, settings. React app served from the extension origin; talks to the Docket backend with the user's API token; reads canonical state from the same backend that capture writes to.

**Visualization-role responsibilities (Phase 6):**
- Render highlights and gutter markers anchored to canonical comment positions.
- Capture user selection (which the unified add-on cannot do natively) for "comment on this passage" flows.
- Inject UI into Google's native comment rail to link native and canonical threads.

**Implementation cost.** Capture-role DOM selectors are exposed to Google's UI churn — budget ~4–8 hours/month for selector fixups + larger refactors when Docs reships (~quarterly). Rich-UI is a normal React app and isn't exposed to that churn. Visualization is the heaviest line: the doc body is `<canvas>` (§9.6), so coordinate mapping needs either Google's accessibility-friendly DOM mirror (Tools → Accessibility settings) or selection-event hooks. Plan quarterly visualization-side refactors when that ships.

**Architectural prerequisite already met.** Docket's `CommentAnchor` schema (quoted text + paragraph hash + structural offset + region) is rich enough to resolve to on-screen coordinates without API help, so the extension can render highlights from canonical data alone. No extension-specific schema additions are needed.

**Out of scope for the extension:** mobile / iPad Docs (browser extensions don't run on those clients).

## 7. Workflows

### 7.1 Single-org review request

1. Author runs `/review-request` in Slack with a doc URL and reviewer list.
2. Backend verifies the author has connected their Google account with `drive.file` scope on the doc; if not, prompts them to authorize (open with the add-on, or use the hosted Drive Picker entry — see §9.2).
3. Backend creates a Version: copies the doc via `files.copy`, applies any specified overlay, sets sharing permissions for reviewers.
4. Backend creates a Review Request, posts a Slack thread, DMs each reviewer.
5. Reviewers comment natively in Google Docs. Doc-watcher ingests comments into canonical store, projecting them onto the version with proper attribution.
6. Slack thread updates as comments arrive (configurable: per-comment notifications, or batched summaries).
7. Reviewers click "Mark reviewed" in Slack/sidebar/web. Status updates aggregate.
8. Author runs `/review-close` (or backend auto-closes when all reviewers are done). Comments are projected onto the current parent via the reanchoring engine; clean matches sync automatically, ambiguous/orphan comments surface in the reconciliation UI.

### 7.2 Cross-org review

Same as above, with these differences:

- The shared Google Doc cross-org sharing is what gives external reviewers access to read and comment.
- External reviewer marks review status by clicking a magic-link button in their assignment email (one click per action: reviewed / changes_requested / declined), or by accepting a Slack Connect invite if both orgs are on Slack. Identity is verified by matching the Google OAuth `sub`/email against the doc's share list.
- Comments are still ingested via the doc owner's Drive token (no need for the external reviewer to grant any Drive scopes).
- If the external reviewer's org has not installed the add-on, they comment in the doc directly and use magic-link actions to confirm review state.

### 7.3 Derivative with overlay

1. Author opens overlay editor in the browser extension or the Workspace add-on sidebar, defines operations (redact section X, append context Y).
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

**Doc owners** authorize the service with Google OAuth, scope `drive.file`, granting access to the specific docs they want managed. The service stores and refreshes tokens. This is the only Google scope the service ever holds for active doc operations. See §9.2 for the per-file semantics of `drive.file`.

**Participants** sign into the service. Acceptable methods:
- Google OAuth with no Drive scope (just identity)
- SSO (SAML/OIDC) for enterprise customers
- Magic-link email auth (fallback for external reviewers without Google accounts)

**Slack identity** is linked to service identity via Slack OAuth + email match.

**Authorization model in the service** is project-scoped. Each project has owner / collaborator / reviewer / observer roles. External reviewers are added per-review-request with reviewer-scope access to that version only.

**Data isolation:** projects belong to a tenant (org). Cross-org review is modeled as inviting users from other tenants to a specific review request, not as merging tenants.

## 9. Google Workspace API constraints

This architecture is shaped by several constraints in the public Google Workspace APIs. Engineers planning related features must know these in advance — they determine what each surface can and cannot do.

### 9.1 Anchored comments cannot be authored via API

Drive API `comments.create` accepts an `anchor` field, but Google's official documentation states that **for Google Docs editor files, comments authored via the API are treated as unanchored regardless of any anchor value supplied** ("Anchored comments on blob files or Google Docs editor files aren't supported"). The Python sample in the Drive guide showing a `{ region: { kind: 'drive#commentRegion', line, rev: 'head' } }` anchor format applies to line-rendered blob files (raw text, source code), not to Google Docs.

There is no escape hatch:
- Apps Script's `DocumentApp` does not expose a comment-creation method.
- The Apps Script advanced Drive service routes through the same REST API.
- The undocumented kix anchor blob can be reverse-engineered but is unstable across Docs releases — unsafe for production.

**Implications:**
- Docket owns canonical comment anchoring end-to-end (§5). Native comments produced by the service are unanchored from Google's perspective; the quoted snippet is included in the comment body as a fallback.
- Richer in-context UX (highlights, gutter markers) is rendered in the add-on sidebar via named-range bookkeeping or in the browser extension (§6.4) via on-canvas overlays.
- **Reading** anchored comments authored through the Docs UI works fully — only the outbound projection path is constrained.

### 9.2 `drive.file` scope semantics

The `drive.file` scope grants access only to files (a) the OAuth client created or (b) explicitly shared with it via the Drive Picker or the Workspace Add-on file-scope-granted flow. It does **not** grant access to a doc just because the user types its URL into Slack.

**Implications:**
- Onboarding flows must establish per-file access before the backend tries to read or copy a doc. Supported entry points: opening the doc with the Docket Workspace Add-on, selecting it via the hosted Drive Picker entry page, or re-using files Docket itself created (versions, derivatives).
- Every entry surface (Slack, extension, add-on) needs a "first time you reference a doc, here's how to authorize it" affordance.
- Cross-org review depends on the **doc owner's** `drive.file` token; external reviewers don't grant any Drive scope.

### 9.3 Drive push-notification requirements

`drive.files.watch` requires:
- An HTTPS endpoint with a domain verified in Search Console.
- A renewable channel (typical 1–24 hour TTL; max ~7 days). Channels can drop without notice.
- Watcher logic that re-fetches state on event, since the push payload itself is empty (`X-Goog-Resource-State` + channel ID, no body).

**Implications:**
- The doc-watcher service requires public infrastructure and a channel-renewer cron.
- A polling fallback is required for when channels expire or drop.
- The watcher is the only reliable signal for "the doc changed" — Google Docs has no real-time edit trigger comparable to Sheets' `onEdit`.

### 9.4 Workspace Add-on UI is Card-only

The unified Workspace Add-on framework (the one new add-ons should target) renders UI through CardService — text, buttons, sections, decorated text, selection inputs, dropdowns. It does **not** support arbitrary HTML, custom CSS, JavaScript-driven UIs, or custom client-side rendering. The legacy Editor add-on framework (Apps Script + HTMLService) supports arbitrary HTML sidebars but is being deprecated in favor of the unified framework — new code should not adopt it.

**Implication.** Side-by-side diff viewers, rich overlay editors, and any custom-rendered UX belong in the browser-extension surface.

### 9.5 Selection access from the add-on is limited

The unified Workspace Add-on does not expose the user's current selection or cursor position to the Card UI. Features that need "what is the user looking at right now" must either:
- Ask the user to enter the snippet manually,
- Defer to the browser extension surface (§6.4), which has full DOM/selection access.

### 9.6 Canvas-rendered doc body

Since 2021, Google Docs renders text into `<canvas>` rather than the DOM. The text body is not addressable as DOM elements. Browser extensions that overlay the doc body must derive coordinates from either Google's accessibility-friendly DOM mirror (a setting users enable manually under Tools → Accessibility settings) or from selection-event hooks. Production-grade extensions (Grammarly, LanguageTool) use both. This is the principal cost driver for the browser extension surface (§6.4).

### 9.7 `documents.batchUpdate` is sufficient for overlays

All four overlay operation types map cleanly to `documents.batchUpdate` primitives:

| Overlay op | Docs API primitive |
|---|---|
| redact | `deleteContentRange` (or `replaceAllText` for a redaction marker) |
| replace | `replaceAllText` (anchored variant) or `deleteContentRange` + `insertText` |
| insert | `insertText` at index |
| append | `insertText` at end |

Anchor-to-index resolution happens before the batch update — that's the reanchoring engine's job. The API itself does not constrain overlays.

## 10. Privacy and security

- Drive refresh tokens encrypted at rest with envelope encryption.
- Audit log for all sensitive operations (sharing changes, version creation/deletion, overlay applications, comment projections).
- Doc content is fetched on demand and cached only as long as needed for reanchoring; canonical comment store holds quoted snippets, not full doc bodies.
- Configurable data residency per tenant (EU-only deployment option for projects with that requirement).
- The service refuses to operate on docs whose Workspace policies forbid third-party app access.
- The add-on uses minimal scopes; the backend never asks participants for broad Drive access.

## 11. Out-of-scope for v1

- Real-time merge of edits across versions (only comments and overlays are reconciled; doc text edits aren't auto-merged).
- Image- or table-anchored comment reanchoring (handled as orphans, surfaced for manual placement).
- Deep integration with Google Docs suggesting-mode (tracked changes) — v1 ingests insert/delete suggestions as canonical_comment rows tagged `kind=suggestion_insert|suggestion_delete`, anchored on the affected text. The ingester walks all doc regions (body, headers, footers, footnotes) so footer/header suggestions are first-class. Author/timestamp resolution for the suggestion (via Drive `revisions.list` cross-reference) and style-only suggestions (`suggestedTextStyleChanges`) are deferred to Phase 6. **Reply threads attached to a suggestion in the Docs UI** (the comment box on the suggestion's sidebar entry) are stored internally by Google and are not exposed by `drive.comments.list`, `documents.get`, or any other documented public API — verified empirically. The browser extension (§6.4, MVP — Phase 2) is the only way to recover this data: the discussion sidebar is regular DOM, scrapeable via MutationObserver. The extension is also the long-term hedge for other API gaps (style-only suggestions, mobile-authored annotations, future surface changes Google may make).
- Authoring **anchored** native Google Docs comments (impossible per §9.1; use quoted-text-in-body fallback).
- A native mobile UI and a mobile-responsive web app. Slack mobile is the supported phone surface for review actions; mobile-authored Drive comments and suggestion-thread replies are recovered opportunistically — the next extension-equipped desktop viewer captures replies regardless of where they were authored (§6.4). The actual gap is docs whose reviewer pool is entirely mobile or extension-less; deferred until evidence of meaningful loss.
- Workspace Marketplace public listing (private/domain installation only at v1).

## 12. Build sequence

Each phase delivers a coherent, demoable slice. **Phases 1–4 are the MVP** — both stated pain points and the multi-version review workflow work end-to-end, driven from the in-doc Workspace add-on (Phase 3) plus magic-link action handlers (Phase 4) for external reviewers, and the public-API gap around suggestion-thread replies closed by the browser extension's capture role. The Slack bot lands in Phase 5 once teams want a chat-driven coordination surface; phases 5–6 are polish that materially improves UX in real research contexts. Phase 7 is "after we've seen how teams actually use it."

The browser extension is part of the MVP. Rationale: Google's public Docs/Drive APIs have known and likely-growing gaps (suggestion-thread replies confirmed missing; future surface changes Google ships could expose more). Treating the extension as a first-class capture surface from the start gives the project long-term flexibility as the API surface evolves. Visualization features (canvas overlays, selection capture) stay deferred to Phase 6 — they're costlier and have acceptable fallbacks.

Per-phase progress is tracked in [`README.md` §"Build phases"](./README.md#build-phases).

### Phase 1 — Core engine

The headless backend that owns all Docket state. No user-facing surface yet; tested end-to-end via CLI.

**Components**
- Drizzle schema for the 12 tables in §4, on `bun:sqlite` with WAL.
- Envelope-encrypted refresh-token storage (`auth/encryption.ts`, `auth/credentials.ts`).
- Google OAuth flow + per-user `TokenProvider` with cached + auto-refreshed access tokens.
- Drive + Docs REST wrappers (`google/drive.ts`, `google/docs.ts`) — endpoint-shaped, typed.
- Domain primitives: `createProject`, `createVersion` (Drive copy + plaintext-hash snapshot fingerprint).
- Canonical comment ingestion (read-side: Drive `comments.list` → `canonical_comment` + `comment_projection`).
- Reanchoring engine (§5) with confidence scoring.
- Overlay model + applier translating overlay ops to `documents.batchUpdate` (§9.7).
- Doc-watcher: `drive.files.watch` subscription, channel-renewer cron, polling fallback (§9.3).
- CLI dispatcher (`bun docket <subcommand>`) wrapping every domain function for dev/test.

**Features delivered**
- Connect a Google account with `drive.file`.
- Register a parent doc as a project; snapshot versions on demand.
- Ingest comments from any version into the canonical store.
- Project canonical comments across versions with confidence scoring; fuzzy/orphan comments queued for reconciliation.
- Author overlays in the DB and apply them to produce derivatives.
- Receive change events from Drive and refresh canonical state automatically.

### Phase 2 — Backend HTTP API + browser extension (capture) + minimal web entry points

The first deployable artifact beyond the CLI. Backend comes online as a network service; the extension's capture role ships, closing the suggestion-thread-reply gap (§11); the web shell is just the glue needed for OAuth + Drive Picker.

**Components**
- HTTP API on `Bun.serve` with per-user opaque API tokens (issued initially via the CLI).
- OAuth callback handler (already exists in CLI; ports into the HTTP server).
- Drive Picker host page (a small static HTML page loading Google's Picker iframe).
- Manifest V3 browser-extension scaffold — Chrome, Edge, and Firefox sharing one codebase. Safari deferred (separate Xcode build).
- Content script on `docs.google.com/*` watching the discussion sidebar via `MutationObserver`.
- Sidebar-scraping logic: each visible reply yields author, timestamp, body, kix discussion ID (from DOM data attributes when available), with a quoted-text + author + timestamp fallback.
- Backend ingest endpoint: resolves (docId, kix discussion ID) → existing canonical_comment (`kind=suggestion_*`) and inserts a new canonical_comment (`kind=comment`, `parent_comment_id` pointing to the suggestion). Idempotent on the scraped reply's stable ID.
- Service-worker queue + local-storage dedupe for retry across tab/session.

**Features delivered**
- Suggestion-thread replies in the canonical store, parented to the suggestion they belong to.
- A backend HTTP API surface ready to be consumed by the Workspace add-on (Phase 3), the extension's rich UI (Phase 4), and the Slack bot (Phase 5).
- Drive Picker available as the entry point for `drive.file` authorization on existing docs.

**Operational notes**
- DOM selectors in the Docs UI are not part of any contract; budget ~4–8 hours/month for selector fixups + larger refactors when Google reships the UI (~quarterly historical cadence).
- Capture is opportunistic: it happens whenever any extension-equipped browser session views the doc. Authoring medium (mobile vs. desktop, extension vs. no extension) doesn't matter — the reply enters Google's sidebar DOM the same way for everyone, and the next extension-equipped viewer captures it. The only real loss case is a doc whose reviewers are *entirely* mobile or extension-less. Active review cycles guarantee at least one extension-equipped viewer; passive long-running docs are riskier.
- Enterprise IT may block third-party Docs extensions; the Workspace Add-on (Phase 3) plus a "comment instead of reply-to-suggestion" UX nudge in the add-on banner are the fallback paths for those tenants.

### Phase 3 — Workspace add-on

In-Doc surface so users don't have to leave the writing experience to use Docket. Lands before the Slack bot because it's testable solo (no Slack workspace required) and unlocks the per-file `drive.file` flow for arbitrary docs the user already owns.

**Components**
- Unified Workspace Add-on (CardService UI; §9.4).
- `onFileScopeGranted` trigger handler that integrates per-file `drive.file` grants with Docket's existing token store (§9.2).
- Apps Script identity-token verification on the backend.
- `review_orchestrator` service (§5) — minimum surface needed to create a review request from the sidebar and project comments back on close.
- `notification_dispatcher` service (§5), email channel — the Slack channel lands in Phase 5.
- Named-range bookkeeping in the overlay applier so the add-on can render "comments at this paragraph" affordances.
- UX banner on docs with active suggestions: nudges reviewers to leave a regular comment rather than typing into the suggestion's reply box, hardening the data-capture path for users without the extension installed.

**Features delivered**
- Inside any open Google Doc: see project status, version list, active reviews.
- Trigger snapshots and review requests from the sidebar.
- View canonical comment threads in the side panel; jump to the project in the browser extension.
- First-time-doc onboarding: opening a previously-unknown doc with the add-on registers it and grants `drive.file`.
- Per §9.4 and §9.5, in-doc highlights and selection-driven flows are deferred to Phase 6's extension visualization layer.

### Phase 4 — Extension rich UI + magic-link action handlers

Closes out the MVP. The browser extension grows from a capture-only background process into the full Docket UI: dashboards, diff viewer, reconciliation, overlay editor, settings. The web shell adds a thin set of magic-link handlers so external reviewers can confirm review actions without an account.

**Components**
- React app served from the extension's options / popup / side-panel surfaces.
- Project dashboard: versions, derivatives, review history, reviewer participation.
- Side-by-side version diff renderer (HTML, computed locally from `documents.get` plaintext + diff library).
- Comment reconciliation UI for fuzzy / orphan projections produced by the reanchoring engine (§5).
- Overlay editor with live preview against the current parent.
- Settings: notification prefs, default reviewers, Slack workspace linking.
- Web entry-point additions: magic-link action handlers (`/r/<token>` style) for "mark reviewed", "decline", "request changes", reconciliation acceptance — single endpoints that fire a state change and render a confirmation page. Token issued to external reviewers in their assignment email.

**Features delivered**
- Manually reconcile fuzzy/orphan comment projections inside the extension.
- View version diffs side-by-side with comments in the gutter.
- Author and test overlays interactively.
- External reviewers without Docket accounts can act via one-click email links — cross-org workflows become possible.
- Phases 1–4 together cover the MVP.

### Phase 5 — Slack bot

Adds chat-driven review coordination for teams that work in Slack. The MVP (phases 1–4) already supports the full review cycle via the add-on + magic-link flow; Slack is layered on as an additional surface, not a prerequisite.

**Components**
- Slack event subscriptions, slash commands, and interactive payloads consuming the Phase-2 HTTP API.
- Slack OAuth + workspace-linking flow.
- `notification_dispatcher` Slack channel (the email channel shipped in Phase 3).
- Identity-linking: `user.email` ↔ Slack `user.profile.email`.
- Drive-scope onboarding affordance for Slack flows that reference unauthorized docs (§9.2).

**Features delivered**
- `/review-request`, `/review-status`, `/review-close` (§6.1).
- Per-reviewer DMs and review-thread updates.
- Home tab dashboards.
- Slack as an alternate entry point for the same single-org review cycle the add-on drives in Phase 3.

### Phase 6 — Cross-org polish + extension visualization

Cross-org reviews become first-class; the browser extension grows beyond capture into in-canvas visualization and selection-driven authoring.

**Components**
- Slack Connect support for shared review channels across orgs.
- External-reviewer onboarding flow: magic-link auth, identity verification via OAuth `sub`/email match against the doc's share list.
- Sharing-policy error handling: friendly errors when org policy blocks third-party app access (§10).
- Browser-extension visualization layer: in-canvas highlights and gutter markers (via accessibility-DOM mirror or selection-event hooks; §9.6), hover previews, right-click "comment on selection," native-comment-rail integration.
- Drive `revisions.list` cross-reference to populate author/timestamp on `kind=suggestion_*` rows ingested from `documents.get`.

**Features delivered**
- Cross-org reviews work without external reviewers needing Slack workspace membership or installing the add-on.
- Helpful errors instead of cryptic API failures when org policy prevents Docket from operating.
- With the extension installed: canonical comments appear as highlights in the doc body; users can author canonical comments from the doc's selection; native comment rail links into Docket threads.
- Suggestion rows carry author + timestamp instead of being null-author/ingestion-time.

### Phase 7 — Marketplace + advanced features

Public availability + the long-tail features that make sense after we've watched real teams use Docket.

**Components**
- Google Workspace Marketplace listing — OAuth verification, security assessment for sensitive scopes.
- Slack App Directory listing.
- Browser-extension store listings (Chrome Web Store, Firefox Add-ons, Edge Add-ons).
- Advanced overlay primitives: conditional ops, parameterized snippets, overlay composition.
- Style-only suggestion ingestion (`suggestedTextStyleChanges`) and richer suggesting-mode signals.
- Automated comment classification ("does this comment look resolved by the latest edit?").

**Features delivered**
- Public installation outside the original tenant.
- Richer overlay authoring.
- Bold/italic/color suggestions flow into the canonical comment store as first-class entries.
- Heuristics that pre-classify comments during multi-version review cycles.
