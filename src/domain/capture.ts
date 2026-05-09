import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  canonicalComment,
  version,
  type CanonicalCommentKind,
  type CommentAnchor,
} from "../db/schema.ts";
import { orphanAnchor } from "./anchor.ts";

/**
 * One scraped reply from the Docs discussion sidebar. Sent in batches by the
 * extension's service worker. Schema is intentionally narrow — no DOM blobs,
 * no auth context. The backend is the source of truth for everything else
 * (project, version, parent suggestion match).
 */
export interface CaptureInput {
  /**
   * Stable, idempotent id chosen by the extension. We dedupe on
   * `(version_id, external_id)`. Typical shape:
   *   `<kixDiscussionId>:<replyIndex>:<authorBucket>:<bodyHash>`
   * The extension only has to keep it stable across reloads of the same
   * discussion thread.
   */
  externalId: string;
  /** Google Docs document id the user has open. */
  docId: string;
  /**
   * DOM-side discussion thread id (`kix.<n>` style). Optional because some
   * Docs builds rotate the attribute name; pair with `parentQuotedText` as
   * a fallback matcher.
   */
  kixDiscussionId?: string;
  /**
   * Quoted snippet attached to the parent suggestion. Used as a fallback to
   * find the parent canonical_comment when we have not yet observed the
   * `kixDiscussionId` against any suggestion row.
   */
  parentQuotedText?: string;
  /** Display name of the reply author (Docs sidebar shows this). */
  authorDisplayName?: string;
  /** Email if the sidebar surfaces it (rare for cross-org). */
  authorEmail?: string;
  /** ISO-8601 timestamp parsed from the sidebar entry. */
  createdAt?: string;
  /** Plain-text body of the reply. */
  body: string;
}

export type CaptureStatus =
  | "inserted"
  | "duplicate"
  | "orphaned"
  | "version_unknown"
  | "error";

export interface CaptureResult {
  externalId: string;
  status: CaptureStatus;
  canonicalCommentId?: string;
  message?: string;
}

export interface IngestCapturesResult {
  results: CaptureResult[];
  inserted: number;
  duplicate: number;
  orphaned: number;
  versionUnknown: number;
  errored: number;
}

const PARENT_KINDS: CanonicalCommentKind[] = [
  "suggestion_insert",
  "suggestion_delete",
];

export async function ingestExtensionCaptures(
  captures: CaptureInput[],
): Promise<IngestCapturesResult> {
  const out: IngestCapturesResult = {
    results: [],
    inserted: 0,
    duplicate: 0,
    orphaned: 0,
    versionUnknown: 0,
    errored: 0,
  };

  for (const c of captures) {
    try {
      const r = await ingestOne(c);
      out.results.push(r);
      if (r.status === "inserted") out.inserted++;
      else if (r.status === "duplicate") out.duplicate++;
      else if (r.status === "orphaned") out.orphaned++;
      else if (r.status === "version_unknown") out.versionUnknown++;
      else if (r.status === "error") out.errored++;
    } catch (err) {
      out.results.push({
        externalId: c.externalId,
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      out.errored++;
    }
  }
  return out;
}

async function ingestOne(c: CaptureInput): Promise<CaptureResult> {
  if (!c.externalId || !c.docId || !c.body) {
    return {
      externalId: c.externalId,
      status: "error",
      message: "missing externalId/docId/body",
    };
  }

  const ver = await pickActiveVersion(c.docId);
  if (!ver) {
    return { externalId: c.externalId, status: "version_unknown" };
  }

  const existing = await db
    .select({ id: canonicalComment.id })
    .from(canonicalComment)
    .where(
      and(
        eq(canonicalComment.originVersionId, ver.id),
        eq(canonicalComment.externalId, c.externalId),
      ),
    )
    .limit(1);
  if (existing[0]) {
    return {
      externalId: c.externalId,
      status: "duplicate",
      canonicalCommentId: existing[0].id,
    };
  }

  const parent = await findParentSuggestion(ver.id, c);
  const anchor = parent?.anchor ?? orphanAnchor(c.parentQuotedText ?? "");
  const originTimestamp = resolveTimestamp(c, parent);

  const inserted = await db
    .insert(canonicalComment)
    .values({
      projectId: ver.projectId,
      originVersionId: ver.id,
      originUserId: null,
      originUserEmail: c.authorEmail ?? null,
      originUserDisplayName: c.authorDisplayName ?? null,
      originTimestamp,
      kind: "comment",
      anchor,
      body: c.body,
      parentCommentId: parent?.id ?? null,
      kixDiscussionId: c.kixDiscussionId ?? null,
      externalId: c.externalId,
    })
    .returning({ id: canonicalComment.id });

  return {
    externalId: c.externalId,
    status: parent ? "inserted" : "orphaned",
    canonicalCommentId: inserted[0]!.id,
  };
}

/**
 * Resolve the doc id the extension saw to a version Docket tracks. Prefer the
 * most recent active version pointing at that Google Doc — covers both the
 * parent doc (versions that *are* the parent are not indexed by parentDocId,
 * but if a version has been snapshotted it points at the copy) and forks.
 */
async function pickActiveVersion(
  docId: string,
): Promise<{ id: string; projectId: string } | null> {
  const rows = await db
    .select({ id: version.id, projectId: version.projectId })
    .from(version)
    .where(and(eq(version.googleDocId, docId), eq(version.status, "active")))
    .orderBy(desc(version.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

interface ParentMatch {
  id: string;
  anchor: CommentAnchor;
  originTimestamp: Date;
}

const PARENT_FIELDS = {
  id: canonicalComment.id,
  anchor: canonicalComment.anchor,
  originTimestamp: canonicalComment.originTimestamp,
} as const;

/**
 * Resolve the suggestion this captured reply belongs to. Two paths:
 *
 *   1. **kix discussion id (preferred).** Indexed lookup on
 *      `(origin_version_id, kix_discussion_id)`. Hits whenever a previous
 *      capture stamped the parent suggestion's row with the kix id.
 *   2. **Anchor quoted-text equality (fallback).** Match on
 *      `json_extract(anchor, '$.quotedText')` — exact, not LIKE — to avoid
 *      `%`/`_` glob escaping issues and the ambiguity of substring matches.
 *      We constrain to suggestion kinds via `inArray`.
 *
 * On a quoted-text hit, we stamp the matched row's `kix_discussion_id` so
 * subsequent captures take the indexed path. No-match returns null, which
 * the caller treats as `orphaned`.
 */
async function findParentSuggestion(
  versionId: string,
  c: CaptureInput,
): Promise<ParentMatch | null> {
  if (c.kixDiscussionId) {
    const byKix = await db
      .select(PARENT_FIELDS)
      .from(canonicalComment)
      .where(
        and(
          eq(canonicalComment.originVersionId, versionId),
          eq(canonicalComment.kixDiscussionId, c.kixDiscussionId),
        ),
      )
      .limit(1);
    if (byKix[0]) return byKix[0];
  }

  if (c.parentQuotedText) {
    const byQuote = await db
      .select(PARENT_FIELDS)
      .from(canonicalComment)
      .where(
        and(
          eq(canonicalComment.originVersionId, versionId),
          inArray(canonicalComment.kind, PARENT_KINDS),
          sql`json_extract(${canonicalComment.anchor}, '$.quotedText') = ${c.parentQuotedText}`,
        ),
      )
      .limit(1);
    if (byQuote[0]) {
      if (c.kixDiscussionId) {
        await db
          .update(canonicalComment)
          .set({ kixDiscussionId: c.kixDiscussionId })
          .where(eq(canonicalComment.id, byQuote[0].id));
      }
      return byQuote[0];
    }
  }

  return null;
}

/**
 * Parse the `createdAt` string from a CaptureInput. Returns null when the
 * field was omitted *or* when it was supplied but unparseable — the caller
 * decides what to substitute. Logs a warning when an iso was provided but
 * couldn't be parsed: that signals selector rot in the extension scraper
 * (e.g. picking up a relative tooltip like "2 days ago" instead of a
 * `<time datetime>` value).
 */
function parseTimestamp(iso?: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    console.warn(`capture: unparseable createdAt: ${JSON.stringify(iso)}`);
    return null;
  }
  return d;
}

/**
 * Pick the value to store on `canonical_comment.origin_timestamp` (NOT NULL
 * on the schema). Preference order:
 *   1. The capture's own timestamp, if it parsed cleanly.
 *   2. The parent suggestion's timestamp + 1ms — guarantees the reply sorts
 *      after its parent without inventing a wall-clock-now value.
 *   3. `Date.now()` — only when there's no parent and no capture timestamp.
 */
function resolveTimestamp(
  c: CaptureInput,
  parent: ParentMatch | null,
): Date {
  const parsed = parseTimestamp(c.createdAt);
  if (parsed) return parsed;
  if (parent) return new Date(parent.originTimestamp.getTime() + 1);
  return new Date();
}
