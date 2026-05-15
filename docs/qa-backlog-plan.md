# QA backlog — implementation plan

Concrete approaches for the open items in [`spec.md` §14](./spec.md#14-qa-backlog).
Status reflects the state of `main` on 2026-05-15. Items already marked **Done**
in spec.md §14 are not repeated here.

Recommended ordering:

1. CORS policy decision (~30 min, decision-only blocker)
2. Multi-use review tokens (~3 hr, fixes the single-use ↔ "lets reviewers
   change responses" mismatch)
3. Parent-as-v1 + project-name decoupling (~7–9 hr, do together)

---

## 1. Multi-use review tokens with action via query param

**Files:** `src/domain/review-action.ts`, `src/api/review-action.ts`,
`src/domain/review.ts`, `src/db/schema.ts`, new migration.

**Today:** `issueReviewActionToken` mints one row per
`(reviewRequestId, assigneeUserId, action)` — three tokens per assignee.
`redeemReviewActionToken` burns `usedAt` on first click; reviewers cannot
change their response. Email body says "each link is single-use", which is
consistent with the implementation but contradicts the design decision saved
to memory.

**Target:** one token per `(reviewRequestId, assigneeUserId)`, multi-use,
with the action passed as `?action=<kind>`. Re-clicking a different action
updates the assignment status until the token expires (30 days).

**Steps:**

1. Schema: drop `reviewActionToken.action` and `reviewActionToken.usedAt`;
   add `lastUsedAt`. The existing
   `review_action_token_assignment_idx (reviewRequestId, assigneeUserId)`
   index becomes the natural lookup key.
2. Migration: dedup the 3-row-per-assignee shape down to 1 row, dropping
   the column. Trivial if no tokens have been issued in prod yet — verify
   before merging.
3. `issueReviewActionToken({ reviewRequestId, assigneeUserId })`:
   `INSERT ... ON CONFLICT DO NOTHING`, then `SELECT` to handle re-issue
   idempotently.
4. `redeemReviewActionToken(token, action)`:
   - Validate `action` against `ReviewActionKind` at the call site.
   - Apply the same `nextAssignmentStatus` transition as today.
   - Update `lastUsedAt` (no `usedAt` gate).
   - Drop the `already_used` outcome.
5. `handleReviewActionGet`: parse `?action=` from query. If missing /
   invalid, render a friendly page listing the four actions as links back
   at the same URL with `?action=...` filled in.
6. `createReviewRequest` (`src/domain/review.ts`): mint one token per
   assignee; build per-action URLs by appending `?action=...` to the same
   `/r/<token>` path. `AssigneeMagicLinks.links` keeps the per-action
   structure (now varying only in query string).
7. Email body: drop "each link is single-use"; replace with "each link
   records your latest response — you can change it until \<expiresAt\>".

**Risk:** schema migration over existing rows. Validate in a dry run before
applying.

**Effort:** ~3 hr including tests.

---

## 2. Parent doc as version (treat parent_doc_id as v1)

**Files:** `src/domain/{project,version,doc-state}.ts`, possibly
`src/domain/comments/ingest.ts`, schema unchanged, Dashboard view.

**Today:** `createProject` registers `parent_doc_id` but does not insert a
`version` row for it. Comments authored on the parent doc are silently
dropped (no version → no `comment_projection`); picker-register leaves the
project with zero versions until the user clicks "Create version".

**Approach:** option B/C — explicit v1 row inserted at `createProject` time.
v1 represents the live editable doc; subsequent versions are snapshots.
The model lines up with the user's mental model and keeps every reader
simple (no "virtual row" branch).

**Steps:**

1. `createProject`: after the project insert, insert a `version` row with
   `googleDocId = parent_doc_id`, `label = "v1"`, `parentVersionId = null`,
   `name = file.name`. Compute `snapshotContentHash` from the parent doc
   (one extra `getDocument` call).
2. Backfill migration: for each existing project with no version rows,
   insert v1 from `parent_doc_id`. Leave `snapshotContentHash = null`;
   the polling loop will populate on next run.
3. `createVersion`'s "auto-link to most recent" already finds v1 as the
   parent of v2. `nextAutoLabel` already returns `v2` once v1 exists.
4. Subscribe a Drive `files.watch` channel on v1 in `createProject` so
   parent-doc comments flow into `ingestVersionComments`.
5. `getDocState`: parent-role branch returns the v1 row directly instead
   of "most recent active or fallback to any" — collapses the two-branch
   `pickRelevantVersion` into one.

**Risk:** the watcher loop already polls every active version; adding v1
gives the parent doc the same treatment, which is the desired behavior.
The backfill insert is the riskiest piece — should be wrapped in a
transaction and tested against a copy of prod data first.

**Effort:** ~6–8 hr including the backfill migration + tests.

---

## 3. Decouple project identity from `parent_doc_id`; render `project.name`

**Files:** `src/db/schema.ts`, `src/domain/project.ts`,
`surfaces/extension/entrypoints/sidepanel/views/Dashboard.tsx:80-83`,
new migration.

**Today:** the `(parent_doc_id, owner_user_id)` unique index ties project
identity to the parent doc URL — swapping the parent isn't possible
without violating the constraint. The Dashboard header literally renders
`<p class="title">Project</p>` followed by the raw `parentDocId`.

**Steps:**

1. Drop `uniqueIndex("project_doc_owner_unique")` from schema. The
   `DuplicateProjectError` path in `createProject` becomes a soft check
   (no DB enforcement). Decide whether to keep the pre-check at all —
   recommend keeping it as a hint for the picker UX but allowing the user
   to override.
2. Generate migration to drop the index. (Index drop is cheap; the data
   itself doesn't need to change.)
3. Dashboard: replace the `"Project"` literal + raw `parentDocId` with
   `{current.project.name ?? "Untitled project"}`. The `name` field
   already flows through `ProjectDetail`.

**Best done alongside item 2** — once parent-as-v1 lands, `project.name`
and v1's `version.name` stay in sync via the same `getFile` call.

**Risk:** dropping a unique index can't be reversed without manual data
dedup. With the pre-check intact at the application layer, day-to-day
behavior is unchanged.

**Effort:** ~1 hr.

---

## 4. CORS policy: explicit decision

**Files:** `src/api/cors.ts`, `docs/extension-qa.md` §13.1.

**Today:** disallowed-origin POSTs return 200 with no
`Access-Control-Allow-Origin`. Browsers block the response per spec, but
bearer-holding curl reads data freely. The behavior is "browser-only
enforcement" — bearer-token confidentiality is the real boundary.

**Two paths — needs a product call:**

- **A. Server-side reject with 403.** In `withCors` and `preflight`,
  return 403 when the request has an `Origin` header that doesn't match
  the allow-list. Bearer-only curl traffic (no `Origin` header) keeps
  working — that's the typical CI / cron pattern. Browser traffic from
  disallowed origins gets a clear server-side reject. Cost: tools that
  send a non-allowlisted `Origin` (e.g. Postman with default config) get
  403 instead of silently-blocked CORS.
- **B. Document and accept.** Update `docs/extension-qa.md` §13.1 to
  clarify CORS is a browser-only mitigation; bearer-token confidentiality
  is the access boundary. No code change.

**Recommendation:** A, with the no-`Origin`-header exemption — defense in
depth without breaking real curl/CI flows. Add a `cors.test.ts` case for
the 403 path.

**Effort:** ~30 min.
