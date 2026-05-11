import { useEffect, useState } from "preact/hooks";
import { sendMessage } from "../../../ui/sendMessage.ts";
import type {
  CanonicalCommentKind,
  ProjectionStatus,
  VersionCommentEntry,
  VersionCommentsPayload,
} from "../../../utils/types.ts";

interface Props {
  versionId: string;
  versionLabel: string;
  onClose: () => void;
}

type State =
  | { kind: "loading" }
  | { kind: "loaded"; payload: VersionCommentsPayload }
  | { kind: "error"; message: string };

/**
 * Side-panel "comments on this version" view (SPEC §12 Phase 4 reconciliation
 * slice). One row per `comment_projection`, sorted by projection status with
 * `orphaned` / `fuzzy` at top so the reconciliation work surfaces first.
 *
 * Read-only for now; the action menu (reanchor / accept / mark resolved)
 * lands in slice 3 when the backend `comment-action` endpoint ships.
 */
export function Comments({ versionId, versionLabel, onClose }: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await sendMessage({ kind: "version/comments", versionId });
        if (cancelled) return;
        if (r?.kind !== "version/comments") {
          setState({ kind: "error", message: "unexpected response" });
          return;
        }
        if (r.error) {
          setState({ kind: "error", message: r.error });
          return;
        }
        if (!r.payload) {
          setState({ kind: "error", message: "comments unavailable" });
          return;
        }
        setState({ kind: "loaded", payload: r.payload });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [versionId]);

  if (state.kind === "loading") {
    return (
      <section class="comments-view">
        <CommentsHeader title={`Comments on ${versionLabel}`} onClose={onClose} />
        <p class="muted">Loading…</p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section class="comments-view">
        <CommentsHeader title="Comments" onClose={onClose} />
        <p class="muted error">{state.message}</p>
      </section>
    );
  }

  const ordered = sortForReconciliation(state.payload.comments);
  const summary = summarize(ordered);

  return (
    <section class="comments-view">
      <CommentsHeader
        title={`Comments on ${state.payload.versionLabel}`}
        onClose={onClose}
      />
      <p class="muted">
        {ordered.length} {ordered.length === 1 ? "comment" : "comments"}
        {summary.fuzzy + summary.orphaned > 0
          ? ` · ${summary.orphaned} orphaned, ${summary.fuzzy} fuzzy`
          : ""}
      </p>
      {ordered.length === 0 ? (
        <p class="muted">
          No comments projected onto this version yet. Sync the version or
          project comments from another version to populate this list.
        </p>
      ) : (
        <ul class="comment-list">
          {ordered.map((c) => (
            <CommentCard
              key={c.canonicalCommentId}
              entry={c}
              targetVersionLabel={state.payload.versionLabel}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function CommentsHeader({
  title,
  onClose,
}: {
  title: string;
  onClose: () => void;
}) {
  return (
    <div class="comments-header">
      <p class="title">{title}</p>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

function CommentCard({
  entry,
  targetVersionLabel,
}: {
  entry: VersionCommentEntry;
  targetVersionLabel: string;
}) {
  const isOriginVersion = entry.originVersionLabel === targetVersionLabel;
  const author =
    entry.originUserDisplayName ??
    entry.originUserEmail ??
    "Unknown author";
  return (
    <li class={`comment-card comment-${entry.projection.status}`}>
      <div class="comment-card-head">
        <StatusBadge status={entry.projection.status} />
        <KindTag kind={entry.kind} />
        {entry.parentCanonicalCommentId ? (
          <span class="comment-tag">reply</span>
        ) : null}
        {isOriginVersion ? null : (
          <span class="comment-tag" title="Projected from an earlier version">
            from {entry.originVersionLabel}
          </span>
        )}
      </div>
      <p class="comment-meta">
        <span>{author}</span>
        <span class="muted"> · {formatDate(entry.originTimestamp)}</span>
        {entry.projection.anchorMatchConfidence !== null ? (
          <span class="muted">
            {" "}
            · match {entry.projection.anchorMatchConfidence}%
          </span>
        ) : null}
      </p>
      {entry.anchor.quotedText ? (
        <blockquote class="comment-quote">{entry.anchor.quotedText}</blockquote>
      ) : null}
      <p class="comment-body">{entry.body}</p>
    </li>
  );
}

function StatusBadge({ status }: { status: ProjectionStatus }) {
  return (
    <span class={`status-badge status-${status}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function KindTag({ kind }: { kind: CanonicalCommentKind }) {
  if (kind === "comment") return null;
  const label =
    kind === "suggestion_insert" ? "suggested insert" : "suggested delete";
  return <span class="comment-tag">{label}</span>;
}

const STATUS_LABEL: Record<ProjectionStatus, string> = {
  clean: "Clean",
  fuzzy: "Fuzzy",
  orphaned: "Orphaned",
  manually_resolved: "Resolved",
};

const STATUS_PRIORITY: Record<ProjectionStatus, number> = {
  orphaned: 0,
  fuzzy: 1,
  clean: 2,
  manually_resolved: 3,
};

/**
 * Surface the actionable rows first: orphaned > fuzzy > clean > resolved.
 * Within a status bucket the API's `desc(originTimestamp)` order is preserved
 * (newer comments above older).
 */
function sortForReconciliation(
  entries: VersionCommentEntry[],
): VersionCommentEntry[] {
  return [...entries].sort((a, b) => {
    const pa = STATUS_PRIORITY[a.projection.status];
    const pb = STATUS_PRIORITY[b.projection.status];
    if (pa !== pb) return pa - pb;
    return b.originTimestamp - a.originTimestamp;
  });
}

function summarize(entries: VersionCommentEntry[]): Record<ProjectionStatus, number> {
  const out: Record<ProjectionStatus, number> = {
    clean: 0,
    fuzzy: 0,
    orphaned: 0,
    manually_resolved: 0,
  };
  for (const e of entries) out[e.projection.status]++;
  return out;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}
