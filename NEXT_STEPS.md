# Next steps — Phase 4

Companion to [`SPEC.md` §12](./SPEC.md#12-build-sequence). Tracks the
in-flight slice of Phase 4 (Extension rich UI + magic-link action
handlers) so the next session can pick up without re-deriving context
from `git log`.

## Where we are (as of 2026-05-11)

Phase 4 is partially landed on `main`. Three commits:

- `50ebcda` — side-panel scaffold + project dashboard + structured diff
  (slices A–D from the plan).
- `767aa5f` — domain CRUD test coverage (project, version, overlay).
- `847acb7` — version-diff DB-path + happy-path test coverage. Lifts
  `src/domain/version-diff.ts` from 69% → 95% lines.

Shipped end-to-end:

- **`POST /api/extension/project`** — owner-gated dashboard payload
  (project header + versions + derivatives + open review requests).
  Composes `src/domain/{project,version,review,user,stats}.ts`.
- **`POST /api/extension/version-diff`** — owner-gated paragraph
  summaries for two versions of the same project. Cross-project +
  cross-tenant diffs collapse to 404.
- **Extension side panel** — `entrypoints/sidepanel/` (Preact). WXT
  config declares `side_panel` on Chromium and `sidebar_action` on
  Firefox; the popup's `Tracked` view opens it via `chrome.sidePanel.open`
  / `sidebar_action.open` feature detection.
- **Project dashboard view** — versions table (label / status / per-version
  comment count / last-synced / per-version Sync via `doc/sync` reusing
  the version's `googleDocId` / Diff button), derivatives list,
  review-request placeholder.
- **Structured diff view** — `entrypoints/sidepanel/diff/align.ts` runs
  two-pass jsdiff: paragraph alignment (custom comparator on
  `(plaintext, namedStyleType)`) → adjacent removed/added blocks
  paired into modified rows → `diffWordsWithSpace` for intra-paragraph
  word diff. Style-only changes (same plaintext + heading, different
  run styles) tagged distinctly. Side-by-side renderer preserves
  heading levels (h1/h2/h3) and run-level styles.
- **Shared UI** — `surfaces/extension/ui/{Header.tsx,sendMessage.ts}` —
  reused by popup + side panel. Per AGENTS.md "pull repeated UI into
  shared on the second consumer."

Test counts: 284 passing locally (+ 6 failing locally that pass in CI —
they require `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` to be present
for `refreshAccessToken` to resolve its config getters even when
`globalThis.fetch` is stubbed; matches `credentials.test.ts`'s pattern).
Coverage: 66.3% lines overall, 95% on the new structured-diff code.

## What's deferred from Phase 4

Per the original slice plan, these are intentionally NOT done:

1. **Comment reconciliation UI** — surfaces fuzzy / orphan projections
   from `commentProjection`. Wants a comment-list view in the dashboard
   first.
2. **Overlay editor with live preview** — preview = "show overlay output
   as a diff against parent," so it builds on the slice-D diff renderer.
3. **Magic-link `/r/<token>` handlers** — needs `review_action_token`
   schema row + `/r/<token>` route + token issuance hook in the
   eventual assignment-email path. Independent slice but pairs
   naturally with Phase 5's notification work; doing it now leaves it
   half-wired.

## Test coverage gaps still open

From the coverage report (2026-05-10):

- **`src/domain/comments.ts`** — 23% lines. `ingestVersionComments` is
  Google-API-coupled; the win is extracting pure planner helpers
  (reply grouping, projection upsert decisions) and unit-testing those.
- **`src/domain/watcher.ts`** — 25% lines. Same shape:
  `subscribeVersionWatch` / `renewExpiringChannels` /
  `pollAllActiveVersions` are Google-bound, but `mapInboundPushToVersion`
  + channel-row helpers extract cleanly.
- **`src/cli/*`** — 0–30% lines. Structurally limited; AGENTS.md says
  "Don't put logic in `src/cli/`." Don't bother.
- **Bun coverage report quirk:** `test/coverage.ts` preloads every
  `src/**` module, so importing a file counts toward its line% even
  if its functions are never invoked. Function-percentage is the more
  honest signal for "is this exercised."

PR 3 from the original plan covers the comments + watcher work but
only worth doing if those modules churn. Hold until they do.

## Pick-up checklist for the next session

When restarting, in order:

1. `git log --oneline -10` to confirm `847acb7` is the tip.
2. `bun run typecheck` + `bun run ext:build` + `bun run ext:build:firefox`
   should all succeed without warnings.
3. `bun test` will report 6 failures locally — they're the
   `tokenProviderForUser` happy-path tests + the two new version-diff
   happy-path tests, all gated on `GOOGLE_CLIENT_ID/SECRET`. CI runs
   them green. Don't try to "fix" them by adding env defaults.
4. Reload the unpacked extension (Chromium: `chrome://extensions` →
   reload) — the side panel only loads on extension install/reload, not
   on tab refresh. Confirm "Open dashboard" from the popup launches
   the side panel against a tracked doc.

## Recommended next slice

**Comment reconciliation UI** is the unblocker for the remaining
Phase-4 work (overlay editor depends on showing comment projections;
review history view wants the comment list as substrate).

Concrete sub-plan:

1. **Backend.** Add `POST /api/extension/version-comments` (or extend
   the project-detail payload) returning canonical comments + their
   projections onto a given version. Owner-gated. Should expose
   `projectionStatus` (`clean | fuzzy | orphaned | manually_resolved`)
   and `anchorMatchConfidence`.
2. **Side panel.** New view: `entrypoints/sidepanel/views/Comments.tsx`,
   wired into the dashboard's review-history section. Renders a list
   of comments with anchor preview, status badge, and an action menu
   for fuzzy / orphan ones (manually accept current placement, manually
   reanchor, mark resolved).
3. **Reanchor action endpoint.** `POST /api/extension/comment-action`
   takes `{ canonicalCommentId, versionId, action }` and dispatches to
   existing domain primitives (`reanchor.ts`).

After that, the overlay editor and magic-link tokens can land in
parallel.
