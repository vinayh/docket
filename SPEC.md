# Project Spec: Margin — Research Doc Review & Versioning

## 1. Objective

Margin helps research teams run structured review of Google Docs across drafts, audiences, and orgs without leaving Docs. It addresses three pain points:

- Forking a doc for an external audience while the original keeps evolving, then integrating comments back.
- Maintaining derivative versions with systematic edits (redactions, audience context) re-applicable as the parent changes.
- Coordinating multi-version, multi-reviewer cycles across orgs with a clear record of who reviewed what.

**Non-goal.** GitHub-style branching/merging on rich text. Semantics are: snapshots, overlays, canonical comments projected across versions, lightweight review-request workflows.

## 2. Core concepts

- **Project** — long-lived workspace tied to one canonical Google Doc (the *parent*). Owns versions, comments, overlays, reviews.
- **Version (snapshot)** — frozen Drive copy of the parent at a point in time. Real Google Doc + DB row with parent→child link.
- **Overlay** — named, ordered list of content-addressed edit ops (redact / replace / insert / append) applied to a parent to produce a derivative.
- **Canonical comment** — Margin's own comment-thread representation. Anchored by quoted text + structural context. Projected into Doc versions as native comments. Carries status (open / addressed / wontfix / superseded), origin metadata, history.
- **Review request** — bundle of frozen version + reviewers + deadline + status + Slack/web thread. The unit users interact with.
- **Participant** — Margin user, authed via Google OAuth (light scope) or other. Distinct from *doc owner* (the participant whose Drive token authorizes Margin's operations on a project).

## 3. Architecture overview

Three layers:

- **Backend** — single source of truth. Owns DB, reanchoring engine, Drive OAuth tokens, watch/poll loop, REST API.
- **Surfaces** — read/write views: Slack bot, browser extension (rich UI; in-canvas overlays planned in Phase 6), Workspace add-on (in-doc Cards), web shell (OAuth + Picker + magic links + landing).
- **Google integration layer** — Drive/Docs REST wrappers, OAuth token manager, push-notification subscriptions; lives inside the backend.

**Architectural rule:** *all state lives in the backend.* A comment, version, or overlay is real because the backend says so — not because Google or Slack says so.

## 4. Data model

15 tables (`src/db/schema.ts`):

| Table | Purpose |
|---|---|
| `project` | parent_doc_id, owner_user_id, settings (default reviewers, default overlay) |
| `version` | google_doc_id, parent_version_id, label, snapshot_content_hash, status |
| `overlay` | name, ordered ops (JSON), project |
| `overlay_operation` | type, anchor (quoted text + context), payload, confidence_threshold |
| `derivative` | version_id, overlay_id, google_doc_id, audience_label |
| `canonical_comment` | origin_version_id, origin_user (+ `origin_photo_hash` for display-name disambiguation, §9.8), anchor (text + paragraph hash + structural offset), body, status, parent_comment_id |
| `comment_projection` | canonical_comment_id, version_id, google_comment_id, anchor_match_confidence, projection_status, last_synced_at |
| `review_request` | project, version, status, deadline, slack_thread_ref |
| `review_assignment` | review_request, user, status, responded_at |
| `user` | email, google_subject_id, display_name, home_org, auth_method |
| `drive_credential` | user, scope, encrypted refresh_token — only doc owners |
| `drive_watch_channel` | per-version Drive `files.watch` channel + token (renew + dedup state) |
| `api_token` | per-user `mgn_…` bearer tokens (sha256 hash + preview + revoked_at) |
| `review_action_token` | single-use magic-link tokens issued for review-assignment emails |
| `audit_log` | actor, action, target, before/after for sensitive ops |

The anchor schema is rich enough to resolve to on-screen coordinates without Google's APIs (§9.1).

## 5. Backend services

- **Doc-watcher.** `drive.files.watch` per project + active forks; channel-renewer cron + polling fallback (§9.3). On event → re-export the doc as `.docx` (Drive `files.export`) and parse OOXML for comments, suggestions, and suggestion-thread replies (§9.8). `comments.list` is queried alongside, used only to recover author identity (`me` + `photoLink`) that docx drops.
- **Reanchoring engine.** Given an anchor + target version: exact text match (high) → fuzzy within paragraph (medium, edit distance + structural context) → orphan. Returns confidence; thresholds drive auto-project vs. surface-for-review. Margin owns anchoring end-to-end; Google's kix anchor is one input, never authoritative (§9.1).
- **Comment projection.** Native comments authored by Margin are unanchored from Google's view (§9.1). Body is prefixed `Re: "<quoted snippet>" — <body>`. The add-on layers named ranges for "comments at this paragraph"; the extension layers on-canvas overlays.
- **Overlay applier.** Translates ops to `documents.batchUpdate` (mapping in §9.7). Anchor → index resolution happens upstream. Below-threshold ops surface for review, not silent skip.
- **Review orchestrator.** Lifecycle: create fork, share with reviewers, post Slack thread, notify, aggregate status, close + pull comments back.
- **Notification dispatcher.** Routes events to Slack / add-on / web / email.
- **Auth service.** Google OAuth + token storage/refresh; scope verification (doc owner vs. participant); cross-org identity.

## 6. Surfaces

### 6.1 Slack bot

Primary chat surface for review coordination.

- **Slash commands:** `/review-request <doc-url> @reviewers [--overlay …] [--deadline …] [--audience …]`, `/review-status [project|reviewer]`, `/review-close <id>`.
- **Interactive elements:** review-thread message (version label, reviewer status icons, comment count, deadline, action buttons); home tab ("Reviews waiting on you" / "Your open requests" / activity); DMs for assignment / new comments / reviewer responses.
- **Cross-org:** Slack Connect when both orgs use it; magic-link assignment emails otherwise — comment in the doc, click a link to mark reviewed. Comment content rendered in the Slack thread regardless of authoring path.
- **Drive scope.** Bot must direct user through per-file authorization (add-on or Picker) before backend touches a doc (§9.2).

### 6.2 Workspace add-on

**Deferred.** The popup project surface (§6.4, Phase 3) covers the affordances that were originally targeted at the add-on — tracked-state lookup, sync trigger, first-time onboarding via Picker. The add-on stays in scope for users who can't install the extension (managed devices, contexts where extension installs are blocked) but is off the MVP critical path. When it ships, it's a Unified Workspace Add-on (CardService; *not* the legacy Editor add-on) covering:

- **On project parent:** version list + status per version, active reviews, pending reanchorings, buttons (Request review / Checkpoint / Open in extension).
- **On fork:** banner ("This is v2 of [project] for [audience]" or "Author is editing v3 in [link]"), reviewer status, buttons (Mark reviewed / Open Slack thread / Back to parent).
- **On unknown doc:** onboarding card. Granting scope here triggers `onFileScopeGranted` → Margin gains `drive.file` for that doc (§9.2).
- **Auth.** Apps Script identity token verified backend-side; Drive scope held by Margin OAuth client (per §8).
- **Constraints.** CardService widgets only — no HTML/JS, no selection access (§9.4, §9.5).
- **Comment visualization.** Side panel renders canonical threads + projection status + reply chains. Cross-references named ranges to render per-section comment counts and "jump to next."

### 6.3 Web entry points

Deliberately minimal — the rich UI is in the extension.

- **OAuth callback handlers** for Google sign-in + Drive scope grants.
- **Drive Picker host page** (`/picker`) — small HTML loading Google's Picker iframe. Acts as the Firefox-MV3 fallback for the in-popup sandboxed Picker (§6.4); on Chromium the popup hosts the same Picker inline and this page is unused.
- **Magic-link handlers** — `/r/<token>` style, one-click state changes for external reviewers; rendered confirmation page.
- **Public landing page** — marketing/explainer with install CTAs.

Project dashboards, diff viewer, reconciliation UI, overlay editor, settings live in the extension (§6.4), not on the web.

**Mobile is out of scope.** Slack mobile covers review actions; mobile-authored comments ingest through Drive.

### 6.4 Browser extension

Chrome / Firefox / Edge extension — popup + options + side panel + Picker sandbox. The extension is a **pure UI surface**: ingestion happens server-side via docx export (§9.8), so the manifest has no content script and no `host_permissions` on `docs.google.com`. Roles across phases:

- **Project surface (Phase 3 — shipped).** The popup is the primary "is this doc tracked, what state is it in, sync it now, add it as a new project" surface. Reads `tab.title` (stripped of the locale `" - Google Docs"` suffix) → backend `/api/extension/doc-state`, branches into onboarding / tracked views. "Add to Margin" mounts a sandboxed Drive Picker iframe inline on Chromium (Firefox MV3: opens the backend `/picker` page in a tab as fallback). "Sync now" calls `/api/extension/doc-sync` to re-ingest comments. No Workspace add-on required.
- **Rich UI (Phase 4 — shipped).** Preact app in the side panel: project dashboard (versions, derivatives, review history, reviewer participation), structured side-by-side version diff, comment reconciliation list. Talks to backend with per-user API token via the SW.
- **Visualization (Phase 6).** Highlights overlaid on the doc body, gutter markers, hover previews, right-click "comment on selection," native-comment-rail integration. Doc body is `<canvas>` (§9.6) — needs accessibility-DOM mirror or selection-event hooks. **This is the only future role that touches the doc page**; if it ships, it will reintroduce `host_permissions` on `docs.google.com/*` and a content script, but only to read selection events / a11y-mirror coordinates — never comment data.
- **Capture (Phase 2 — retired).** Originally scraped suggestion-thread replies from the discussion sidebar (the public Drive/Docs APIs didn't surface them). The docx-export ingest path (§9.8) recovers the same data server-side with exact anchors and ISO timestamps, so the `MutationObserver`, SW capture queue, `/api/extension/captures` endpoint, and the `host_permissions` on `docs.google.com/*` were all removed in Phase 4.

Implementation detail (popup state machine, sandboxed-Picker handshake, manifest permissions, cross-browser shim) lives in [`surfaces/extension/README.md`](./surfaces/extension/README.md). Conventions for working on this surface: [`AGENTS.md`](./AGENTS.md#browser-extension-surfacesextension).

**Out of scope:** mobile / iPad Docs.

## 7. Workflows

### 7.1 Single-org review
1. Author runs `/review-request` (Slack) or sidebar action (add-on).
2. Backend verifies `drive.file` for the doc; if missing, prompt add-on flow or Picker (§9.2).
3. Backend snapshots a version (`files.copy`), applies overlay if any, sets reviewer sharing.
4. Backend creates review request, posts Slack thread, DMs reviewers.
5. Reviewers comment in Docs; doc-watcher ingests → canonical store → projects to version.
6. Slack thread updates as comments arrive (configurable: per-comment vs. batched).
7. Reviewers click "Mark reviewed" (Slack / sidebar / web).
8. Author runs `/review-close` (or auto-close on full reviewer set). Comments project onto current parent via reanchoring engine; clean → auto-sync, ambiguous → reconciliation UI.

### 7.2 Cross-org review
Same as 7.1, with:

- External reviewer accesses via shared Drive doc link.
- Status updated by magic-link email button or Slack Connect.
- Comments still ingested via doc owner's Drive token (external reviewers grant no Drive scope).

### 7.3 Derivative with overlay
1. Author defines overlay ops in extension or add-on.
2. Save + name + assign to project.
3. Run "Create derivative" → backend copies parent, applies overlay via `documents.batchUpdate`, records derivative.
4. Share derivative with audience.
5. On parent update: "Refork" → re-copy + re-apply; non-matching ops surface for review.

### 7.4 Multi-version review cycle
1. v1 reviewed; canonical comments anchored to v1.
2. Author edits parent.
3. Author requests v2 review. v1 comments project onto v2: clean → "still open from v1"; changed → "likely addressed — confirm?"; deleted-text → "previous-version context" (sidebar only, not a native comment).
4. v2 reviewers comment.
5. Author marks v1 comments addressed. Replies on v2 link to canonical comments by ID — reply chains compose across versions.
6. v3 review repeats.

## 8. Authentication and authorization

| Role | Mechanism |
|---|---|
| Doc owner | Google OAuth, scope `drive.file` (per-file, §9.2); refresh token encrypted at rest |
| Participant | Google OAuth identity-only / SSO (SAML, OIDC) / magic-link email |
| Slack identity | Slack OAuth + email match against `user.email` |

**Authorization model.** Project-scoped roles: owner / collaborator / reviewer / observer. External reviewers added per-review-request, scoped to that version.

**Data isolation.** Projects belong to a tenant (org). Cross-org review = invite users from other tenants to a specific request.

## 9. Google Workspace API constraints

### 9.1 Anchored comments cannot be authored via API
Drive `comments.create` accepts `anchor`, but for Docs editor files anchored comments authored via the API are not supported. Apps Script `DocumentApp` has no comment-creation method. The kix anchor blob is unstable.

**Implications:** Margin owns anchoring. Native comments produced by Margin are unanchored from Google's view; quoted snippet inlined in the body. Reading anchored comments authored in the UI works fully — only the outbound projection path is constrained.

### 9.2 `drive.file` scope semantics
Per-file. Granted only via files Margin created OR explicit Picker / Workspace Add-on file-scope flow. Typing a URL into Slack does not grant access.

**Implications:** Every entry surface needs a "first-time authorization" affordance. Cross-org review depends on the *doc owner's* `drive.file` token; external reviewers grant no Drive scope.

### 9.3 Drive push-notification requirements
- HTTPS endpoint, domain verified in Search Console.
- Channel TTL 1–24h (max ~7 days); can drop without notice.
- Push payload is empty (`X-Goog-Resource-State` + channel ID); re-fetch on event.

**Implications:** doc-watcher needs public infra + channel-renewer cron + polling fallback. Only reliable "doc changed" signal — Docs has no `onEdit` analog.

### 9.4 Workspace Add-on UI is Card-only
Unified Workspace Add-on framework renders only via CardService. No arbitrary HTML/CSS/JS. Do not adopt the legacy Editor add-on.

**Implication:** rich UX (diffs, overlay editor, custom rendering) belongs in the extension.

### 9.5 Selection access from the add-on is limited
Unified add-on does not expose selection / cursor. Either ask the user to enter a snippet manually, or defer to the extension.

### 9.6 Canvas-rendered doc body
Docs renders body to `<canvas>`. DOM-overlaying extensions need the accessibility-DOM mirror (Tools → Accessibility) or selection-event hooks.

### 9.7 `documents.batchUpdate` is sufficient for overlays

| Overlay op | Docs API primitive |
|---|---|
| redact  | `deleteContentRange` (or `replaceAllText` for a marker) |
| replace | `replaceAllText` (anchored) or `deleteContentRange` + `insertText` |
| insert  | `insertText` at index |
| append  | `insertText` at end |

Anchor → index resolution happens upstream.

### 9.8 Docx export is the canonical ingest source

Drive `files.export?mimeType=…wordprocessingml.document` returns the doc as OOXML zip. Empirically verified to surface every piece of annotation state we need, several of which the public Drive / Docs APIs do not:

| Signal | `comments.list` | `documents.get` | docx export |
|---|---|---|---|
| Plain comment + body | ✅ | — | ✅ |
| Exact anchor coords | ❌ (opaque `kix.*`) | — | ✅ via `<w:commentRangeStart/End>` at run boundaries |
| Disjoint multi-range comment | ❌ (only first span) | — | ✅ as N `<w:comment>` rows sharing `(w:author, w:date, body)` |
| Multi-paragraph contiguous range | ✅ (quoted spans `\n`) | — | ✅ range crosses paragraphs |
| Suggested insert/delete content | — | ✅ | ✅ via `<w:ins>` / `<w:del>` |
| Suggestion author + timestamp | — | ❌ (deferred to `revisions.list`) | ✅ on `<w:ins>` / `<w:del>` |
| **Suggestion-thread replies** | ❌ | ❌ | ✅ as `<w:comment>` whose range overlaps the `<w:ins>`/`<w:del>` |
| Author identity discriminator | ✅ via `me` + `photoLink` | — | ❌ display-name only |
| Parent-reply linkage | ✅ nested `replies[]` | — | ❌ flat; reconstruct by same-anchor + `w:date` |

**Implication.** Ingest is docx-driven; `comments.list` is queried alongside purely to recover `me` + `photoLink` for author disambiguation (two users with the same display name are indistinguishable in OOXML). The extension's Phase-2 capture role becomes redundant and is retired in Phase 4. §9.1 still holds — Margin authors unanchored comments outbound; the docx path is inbound only.

**Reply-on-suggestion detection rule.** A `<w:comment>` whose `commentRangeStart`/`End` interval overlaps a `<w:del>` or `<w:ins>` element is a reply on that suggestion's thread. No `paraIdParent` or equivalent in Google's export — linkage is purely positional.

## 10. Privacy and security

- Drive refresh tokens encrypted at rest (envelope encryption: KEK → per-row DEK → ciphertext).
- Audit log on sensitive ops (sharing, version delete, overlay apply, comment projection).
- Doc content fetched on demand; canonical store holds quoted snippets, not full bodies.
- Per-tenant data residency (EU-only deploy option).
- Refuse to operate on docs whose Workspace policy forbids 3rd-party app access.
- Add-on uses minimal scopes; backend never asks participants for broad Drive access.

## 11. Out-of-scope for v1

- Real-time merge of edits across versions (only comments + overlays reconcile).
- Image- / table-anchored comment reanchoring (orphans, manual placement).
- Deep suggesting-mode integration. v1 ingests insert/delete suggestions as `canonical_comment` rows tagged `kind=suggestion_*`, anchored on affected text. Walks all regions (body, headers, footers, footnotes). Style-only suggestions (`suggestedTextStyleChanges`) deferred to Phase 6. Suggestion **author/timestamp** and **suggestion-thread replies** ingest via the docx export path (§9.8); the `revisions.list` cross-reference originally planned for these is no longer needed.
- Authoring **anchored** native Google Docs comments.
- Native mobile UI / responsive web.
- Public Workspace Marketplace listing (private/domain install only at v1).

## 12. Build sequence

Phases 1–4 = MVP. Phase 5 adds Slack. Phase 6 = cross-org polish + extension visualization. Phase 7 = Workspace add-on + marketplace + advanced. Each phase has a `Status:` line — keep it current as work lands.

### Phase 1 — Core engine
**Status: shipped.** ✅

Headless backend + CLI. Drizzle schema (15 tables) on `bun:sqlite` WAL; envelope-encrypted refresh tokens; Google OAuth + per-user `TokenProvider`; Drive/Docs REST wrappers; domain primitives (`createProject`, `createVersion`); canonical comment ingest; reanchoring engine with confidence scoring; overlay applier; doc-watcher with channel renewer + polling fallback; `bun margin <subcommand>` CLI dispatcher.

### Phase 2 — Backend HTTP API + browser extension (capture) + minimal web entry points
**Status: shipped; capture role removed in Phase 4 (replaced by §9.8 docx ingest).** ✅

Fly.io deploy + GitHub Actions auto-deploy on `main`. `bun margin serve` HTTP host: `/healthz`, `/oauth/{start,callback}`, `/picker` (real Drive Picker iframe with GIS-backed tokens, gated on `GOOGLE_API_KEY` + `GOOGLE_PROJECT_NUMBER`), `/webhooks/drive`, `/api/picker/register-doc`. Per-user opaque API tokens with bearer middleware. MV3 extension (Chrome / Edge / Firefox, single codebase). Auto-subscribe of Drive `files.watch` per new version + in-process renew + polling loops, gated on `MARGIN_PUBLIC_BASE_URL`.

The original capture-role components — `/api/extension/captures`, `domain/capture.ts`, sidebar scraper + `MutationObserver`, SW capture queue + flush alarm, the `canonical_comment.{kix_discussion_id, external_id}` columns, and the `host_permissions: ["https://docs.google.com/*"]` manifest entry — were all deleted in Phase 4 once the docx-export ingest path (§9.8) was running. The extension is now a pure UI surface; ingestion lives entirely in the backend.

### Phase 3 — Extension popup as project surface
**Status: shipped.** ✅

Replaces the Workspace add-on as the lightweight "I'm in a doc, what does Margin know about it?" surface (§6.4). Same affordances, no Apps Script / CardService dependency, no separate install. The Workspace add-on is deferred to Phase 7 as a managed-device fallback.

New backend routes:

- `POST /api/extension/doc-state` — tracked? state for the open doc. Owner-scoped (cross-user reads return `tracked: false`).
- `POST /api/extension/doc-sync` — "Sync now" — re-runs `ingestVersionComments` on the relevant version and returns refreshed state.
- `GET /api/picker/config` — public, exposes the same Picker config the inline `/picker` page already inlines. Lets the in-popup sandboxed Picker boot without an API-token round-trip. Not a secret.
- CORS allow-list extended to chromium / firefox extension origins on `/api/extension/*` and `/api/picker/*`.

Popup state machine + sandboxed-Picker mechanics live in [`surfaces/extension/README.md`](./surfaces/extension/README.md). Notable design choices: popup never holds the API token (everything routes through the SW); sandboxed Picker on Chromium runs at `null` origin and postMessages back to the popup; Firefox MV3 falls back to opening the backend `/picker` tab because `sandbox.pages` isn't supported yet.

**Delivers:** the popup owns the entire "track → check state → sync now" loop. New users never see a Margin-hosted page after OAuth.

### Phase 4 — Extension rich UI + docx-export ingest + magic-link action handlers
**Status: shipped.** ✅

Builds on the Phase-3 popup project surface. The popup retains the lightweight read-only view; the side-panel / options page hosts the rich React app.

Shipped:

- Preact side-panel scaffold + project dashboard (`POST /api/extension/project`).
- Structured side-by-side version diff (`POST /api/extension/version-diff`): client renders against `documents.get` structural content (paragraphs + runs + `textStyle` + `namedStyleType` + bullet/table). Two-pass diff: (1) paragraph-level alignment keyed by `(hash(plaintext), namedStyleType)`, (2) intra-paragraph run diff preserving style boundaries; style-only changes render distinctly.
- Read-only comment reconciliation list (`POST /api/extension/version-comments`).
- **Docx-export ingest (§9.8).** `ingestVersionComments` exports the doc as `.docx`, parses OOXML via `src/google/docx.ts` (fflate + fast-xml-parser, `preserveOrder: true`), and writes canonical_comment / comment_projection rows directly from the parsed annotations. Recovers disjoint multi-range comments (collapsed by `(author, date, body)` onto `anchor.additionalRanges`), exact anchor coordinates, suggestion-thread replies (linked via `parent_comment_id` to the canonical suggestion row), and suggestion author + timestamp. `comments.list` retained alongside *only* to (a) reconstruct plain-comment reply trees that OOXML flattens and (b) recover `me` + `photoLink` for author-identity disambig (stored as `canonical_comment.origin_photo_hash`).
- **Extension capture-role retirement.** The capture pipeline was deleted end-to-end: `/api/extension/captures`, `src/domain/capture.ts`, the sidebar `MutationObserver` + scraper, the SW capture queue + `chrome.alarms` flush loop, the `canonical_comment.{kix_discussion_id, external_id}` columns, the docs.google.com `host_permissions`, the `alarms` permission, the per-doc title cache, and `src/domain/suggestions.ts`. Migrations 0000–0005 collapsed to a single fresh schema. The doc-watcher's webhook handler re-runs `ingestVersionComments` on `files.watch` events. Since most comments now arrive with exact coordinates, the reanchoring engine's fuzzy / orphan paths matter only for cross-version projection — first-version ingest is clean by construction.

Shipped in Phase 4 round 2:

- **Comment reconciliation actions.** `POST /api/extension/comment-action` for `accept_projection`, `reanchor`, `mark_resolved`, `mark_wontfix`, `reopen`. Side-panel action menu on each row applies results in place. Audit-logged via `audit_log` rows tagged `canonical_comment.*` / `comment_projection.*`.
- **Settings.** `POST /api/extension/settings` (load + patch) over `project.settings`. Side-panel Settings view covers notification prefs, default reviewer emails, Slack workspace linking (free-form placeholder until Phase 5 wires the bot). Patches are diff-applied; `audit_log` records the before/after JSON.
- **Magic-link `/r/<token>` handlers.** New `review_action_token` table (`tokenHash`, `reviewRequestId`, `assigneeUserId`, `action`, `issuedAt`, `expiresAt`, `usedAt`). `GET /r/<token>` on the secured (non-CORS) side of the API renders an HTML confirmation and transitions the matching `review_assignment.status`. Single-use; expired/used tokens render a friendly error page. Actions: `mark_reviewed`, `decline`, `request_changes`, `accept_reconciliation`.

The overlay applier + domain helpers stay shipped (§5, `src/domain/overlay.ts`); the editor surface is stretch (§13.3).

**Delivers:** MVP. Cross-org workflows become possible via one-click email actions; the extension stops being a data pipe and is purely a UI surface.

### Phase 5 — Slack bot
**Status: not started.**

- Event subscriptions, slash commands, interactive payloads against Phase-2 API.
- Slack OAuth + workspace-linking flow.
- `notification_dispatcher` Slack channel.
- Identity link `user.email` ↔ Slack `user.profile.email`.
- Slack-side drive-scope onboarding affordance for unauthorized docs (§9.2).

**Delivers:** `/review-request`, `/review-status`, `/review-close` (§6.1); per-reviewer DMs; thread updates; home-tab dashboards.

### Phase 6 — Cross-org polish + extension visualization
**Status: not started.**

- Slack Connect for shared review channels across orgs.
- External-reviewer onboarding via magic-link auth + identity verification (OAuth `sub`/email vs. share list).
- Friendly errors when org policy blocks third-party app access (§10).
- Extension visualization: in-canvas highlights / gutter markers (accessibility-DOM mirror or selection-event hooks; §9.6); hover previews; right-click "comment on selection"; native-comment-rail integration. The content script returns here — but reading selection events / a11y coords, not comment data.

### Phase 7 — Workspace add-on, marketplace listings, advanced features
**Status: not started.**

- **Workspace add-on (deferred from earlier MVP plan).** Unified Workspace Add-on (CardService UI; §9.4) covering the same affordances as the Phase-3 popup, for users on managed devices or in environments that block extension installs. `onFileScopeGranted` integrates per-file `drive.file` with Margin's token store (§9.2). Apps Script identity-token verification on the backend. Named-range bookkeeping in the overlay applier — powers add-on "comments at this paragraph" affordances.
- Workspace Marketplace listing (OAuth verification + security assessment).
- Slack App Directory listing.
- Browser-extension store listings (Chrome Web Store, Firefox Add-ons, Edge Add-ons).
- Advanced overlay primitives: conditional ops, parameterized snippets, overlay composition.
- Style-only suggestion ingestion (`suggestedTextStyleChanges`).
- Automated comment classification ("does this look resolved by the latest edit?").

## 13. Stretch goals

Not scheduled. Listed so they inform schema/API decisions today.

### 13.1 External read API + webhooks
Scoped, versioned, read-mostly HTTPS API over canonical comments + projections + review state. Distinct from internal `/api/extension/*`. Same `mgn_` token auth.

- `GET /api/v1/projects`
- `GET /api/v1/projects/:id/comments?version=&status=&since=`
- `GET /api/v1/projects/:id/versions/:vid/diff` — plaintext + comment anchors
- `POST /api/v1/projects/:id/comments/:cid/status`
- Webhooks per project: `comment.created`, `comment.replied`, `projection.resolved`, `review_request.closed`. Stable cursor for downtime backfill.

### 13.2 MCP server
Thin shell over `src/domain/*` exposing canonical state as MCP resources + tools.

- **Resources:** project summary, version diffs, comment threads (one URI per thread, paginated indexes per project).
- **Tools:** `search_comments`, `summarize_review_request`, `mark_comment_addressed`, `create_version_checkpoint`, `request_review`. Side-effects scoped to caller; same authorization model as §8.
- **Auth:** same `mgn_` per-user tokens, exchanged on first MCP handshake.

### 13.3 Overlay editor + derivative UX
Side-panel editor for the existing overlay primitives (`redact` / `replace` / `insert` / `append`, §9.7), with live preview against the current parent rendered through the structured-diff component. The overlay applier + `applyOverlayAsDerivative` already exist in `src/domain/overlay.ts`; this is purely the UI + thin HTTP wrappers.

- Overlay-list left rail per project (CRUD over `overlay` + `overlay_operation`).
- Per-op edit form with anchor picker (paragraph + quoted text, reanchor-confidence hint).
- Preview: backend simulates the planned `batchUpdate` requests in-memory against the parent doc and returns paragraph summaries in the same shape as `version-diff`; client diffs through the existing `alignParagraphs` renderer. No Drive write per keystroke.
- "Apply as derivative" CTA wired to `applyOverlayAsDerivative`.

Phase 7's advanced overlay primitives (conditional ops, parameterized snippets, composition) sit downstream of this.

### 13.4 In-browser AI tools
Extension side-panel chat with the canonical store wired in as live context (via §13.2 MCP, or directly via the Phase-4 React app's API client).

- **Triage assist** — "which v2 comments are addressed by the v2→v3 diff?"
- **Reply drafting** — LLM drafts a reply grounded in surrounding doc text + prior thread; user edits before posting back as a regular Drive comment.
- **Author co-review** — flag passages likely to draw the same kinds of comments past reviewers left on this project.
- **"Explain this comment in context"** — pulls parent suggestion + surrounding paragraph + cross-version replies into a single summary.

Privacy: LLM only sees what the calling user can already see. Doc body fetched fresh per turn through Margin's `drive.file`-scoped credentials. Provider choice (Claude / OpenAI / local) in extension settings; default "ask before sending."
