# Margin

[![codecov](https://codecov.io/gh/vinayh/margin/graph/badge.svg?token=V4MG527SMV)](https://codecov.io/gh/vinayh/margin)

Structured review of Google Docs across drafts, audiences, and orgs. Snapshot a doc as a versioned project, capture every comment and suggestion against a version, project comments across versions, and generate audience-specific copies with reusable edit recipes. Surfaces today: browser extension (popup + side panel). Slack bot and Workspace Add-on are planned.

See [`docs/spec.md`](./docs/spec.md) for the design and per-phase build status. [§12](./docs/spec.md#12-build-sequence) tracks what's shipped, in-flight, and ahead.

## What works, and what doesn't

For the underlying Google-side constraints that drive these limits, see [`docs/spec.md` §9](./docs/spec.md#9-google-workspace-api-constraints).

**Works today:**

- **Version snapshots.** Freeze a doc at any point and keep the snapshot alongside the live version, fingerprinted so identical content is recognized.
- **Comment + suggestion capture with exact location.** Plain comments, multi-paragraph ranges, disjoint multi-range comments, suggestion inserts and deletes (with author and timestamp), and replies on suggestion threads are all captured with their original anchors preserved.
- **Reply trees and author identity.** Threaded replies stay nested; authors are disambiguated even when display names collide.
- **Cross-version comment projection.** A comment made on v1 follows the same text into v3, with a confidence score. Ambiguous matches surface for review rather than getting silently dropped.
- **Audience-specific derivatives.** Reusable edit recipes (redact, replace, insert, append) apply on top of a version to produce a derivative copy.
- **Push-driven change notifications.** Margin gets notified when a tracked doc changes, with a polling fallback so nothing is missed.
- **Side-by-side version diff.** Structural diff between any two versions in the extension side panel.
- **Per-file authorization.** Track docs you create through Margin, open through the Workspace Add-on (planned), or pick via the Drive Picker.

**Doesn't work (Google-side limits, not bugs):**

- **Posting anchored comments back to Docs.** Google's API doesn't let third parties create highlighted/anchored comments on Docs editor files, so Margin's outbound comments prefix the quoted snippet inline instead. Reading anchored comments authored in the UI works fully.
- **Tracking a doc by URL alone.** Google requires per-file authorization through the Picker or the Workspace Add-on; you can't paste a URL and have Margin pick it up.
- **In-canvas highlight overlays.** Google Docs renders the body in a canvas element, so on-page highlights and gutter markers need accessibility-DOM hooks (planned for a later phase). The current extension is popup + options + side panel only.
- **Selection / cursor data from inside a Workspace Add-on.** Not exposed by Google; rich UX (diff viewer, overlay editor) lives in the browser extension instead.
- **Merging rich-text edits across versions.** Margin reconciles comments and overlay ops, not the prose itself. Image- and table-anchored comments fall back to manual placement when the surrounding text changes too much.

## Stack

Bun runtime, `bun:sqlite` + Drizzle (Postgres later when we need multi-process), `Bun.serve()` for HTTP, WebCrypto AES-GCM envelope encryption for refresh tokens, `bun test` for tests.

## Contributing

See [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) to get a local dev environment running. Project conventions, repo layout, and the schema-migration workflow live in [`AGENTS.md`](./AGENTS.md). Long-form design, per-phase build plan, and Google-side constraints live in [`docs/spec.md`](./docs/spec.md).
