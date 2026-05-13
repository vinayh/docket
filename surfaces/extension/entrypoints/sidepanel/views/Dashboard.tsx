import { useState } from "preact/hooks";
import { sendMessage } from "../../../ui/sendMessage.ts";
import type {
  ProjectDerivativeDetail,
  ProjectDetail,
  ProjectReviewRequestDetail,
  ProjectVersionDetail,
  ReviewActionKind,
  ReviewRequestResult,
} from "../../../utils/types.ts";

interface Props {
  detail: ProjectDetail;
  onOpenDiff: (fromVersionId: string, toVersionId: string) => void;
  onOpenComments: (versionId: string, versionLabel: string) => void;
  onOpenSettings: () => void;
}

/**
 * Project dashboard: header, versions table (with per-version Sync),
 * derivatives, review requests. Per-version Sync routes through the
 * existing `doc/sync` SW handler using the version's `googleDocId` —
 * `getDocState` recognizes the version-role doc and ingests that exact
 * version, no schema change needed.
 */
export function Dashboard({
  detail,
  onOpenDiff,
  onOpenComments,
  onOpenSettings,
}: Props) {
  const [current, setCurrent] = useState<ProjectDetail>(detail);

  async function refreshAll(): Promise<void> {
    const r = await sendMessage({
      kind: "project/detail",
      projectId: current.project.id,
    });
    if (r?.kind === "project/detail" && r.detail) setCurrent(r.detail);
  }

  async function syncVersion(v: ProjectVersionDetail): Promise<void> {
    await sendMessage({ kind: "doc/sync", docId: v.googleDocId });
    await refreshAll();
  }

  async function snapshotVersion(): Promise<void> {
    const r = await sendMessage({
      kind: "version/create",
      projectId: current.project.id,
    });
    if (r?.kind === "version/create" && r.error) throw new Error(r.error);
    await refreshAll();
  }

  const [issuedLinks, setIssuedLinks] = useState<
    Record<string, ReviewRequestResult>
  >({});

  async function requestReview(
    versionId: string,
    assigneeEmails: string[],
  ): Promise<void> {
    const r = await sendMessage({
      kind: "review/request",
      versionId,
      assigneeEmails,
    });
    if (r?.kind !== "review/request") throw new Error("unexpected response");
    if (r.error) throw new Error(r.error);
    if (!r.result) throw new Error("no result returned");
    setIssuedLinks((prev) => ({ ...prev, [r.result!.reviewRequestId]: r.result! }));
    await refreshAll();
  }

  const parentUrl = docUrl(current.project.parentDocId);

  return (
    <>
      <p class="title">Project</p>
      <p class="subtitle">
        <a href={parentUrl} target="_blank" rel="noreferrer">
          {current.project.parentDocId}
        </a>
      </p>
      <p class="muted">Owner: {current.project.ownerEmail ?? "unknown"}</p>
      <div class="actions">
        <button type="button" onClick={() => void refreshAll()}>
          Refresh
        </button>
        <button type="button" onClick={onOpenSettings}>
          Settings
        </button>
      </div>

      <VersionsSection
        versions={current.versions}
        onSync={syncVersion}
        onSnapshot={snapshotVersion}
        onRequestReview={requestReview}
        onOpenDiff={onOpenDiff}
        onOpenComments={onOpenComments}
      />
      <DerivativesSection derivatives={current.derivatives} />
      <ReviewsSection reviews={current.reviewRequests} issuedLinks={issuedLinks} />
    </>
  );
}

function VersionsSection({
  versions,
  onSync,
  onSnapshot,
  onRequestReview,
  onOpenDiff,
  onOpenComments,
}: {
  versions: ProjectVersionDetail[];
  onSync: (v: ProjectVersionDetail) => Promise<void> | void;
  onSnapshot: () => Promise<void>;
  onRequestReview: (versionId: string, emails: string[]) => Promise<void>;
  onOpenDiff: (fromVersionId: string, toVersionId: string) => void;
  onOpenComments: (versionId: string, versionLabel: string) => void;
}) {
  return (
    <section class="panel-section">
      <div class="section-heading-row">
        <h2 class="section-heading">
          Versions <span class="count">{versions.length}</span>
        </h2>
        <SnapshotVersionButton onSnapshot={onSnapshot} />
      </div>
      {versions.length === 0 ? (
        <p class="muted">No versions yet.</p>
      ) : (
        <table class="data">
          <thead>
            <tr>
              <th scope="col">Label</th>
              <th scope="col">Status</th>
              <th scope="col" class="numeric">Comments</th>
              <th scope="col">Last synced</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td>
                  <a href={docUrl(v.googleDocId)} target="_blank" rel="noreferrer">
                    {v.label}
                  </a>
                </td>
                <td>{v.status}</td>
                <td class="numeric">{v.commentCount}</td>
                <td>{formatRelative(v.lastSyncedAt)}</td>
                <td>
                  <div class="row-actions">
                    <VersionSyncButton version={v} onSync={onSync} />
                    <button
                      type="button"
                      onClick={() => onOpenComments(v.id, v.label)}
                    >
                      Comments
                    </button>
                    {v.parentVersionId ? (
                      <button
                        type="button"
                        onClick={() => onOpenDiff(v.parentVersionId!, v.id)}
                      >
                        Diff
                      </button>
                    ) : null}
                    <RequestReviewButton
                      versionId={v.id}
                      onSubmit={onRequestReview}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function SnapshotVersionButton({
  onSnapshot,
}: {
  onSnapshot: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function click(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await onSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="snapshot-control">
      <button type="button" disabled={busy} onClick={() => void click()}>
        {busy ? "Snapshotting…" : "Snapshot new version"}
      </button>
      {error ? <span class="muted error">{error}</span> : null}
    </div>
  );
}

function RequestReviewButton({
  versionId,
  onSubmit,
}: {
  versionId: string;
  onSubmit: (versionId: string, emails: string[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [emails, setEmails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const parsed = parseEmails(emails);
    if (parsed.length === 0) {
      setError("enter at least one email");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(versionId, parsed);
      setOpen(false);
      setEmails("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Request review
      </button>
    );
  }
  return (
    <div class="review-request-form">
      <textarea
        rows={2}
        placeholder="reviewer@example.com, reviewer2@example.com"
        value={emails}
        onInput={(e) => setEmails((e.target as HTMLTextAreaElement).value)}
        disabled={busy}
      />
      <div class="row-actions">
        <button type="button" disabled={busy} onClick={() => void submit()}>
          {busy ? "Requesting…" : "Send"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setEmails("");
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>
      {error ? <span class="muted error">{error}</span> : null}
    </div>
  );
}

function parseEmails(raw: string): string[] {
  return raw
    .split(/[,\n;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function VersionSyncButton({
  version,
  onSync,
}: {
  version: ProjectVersionDetail;
  onSync: (v: ProjectVersionDetail) => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  async function click(): Promise<void> {
    setBusy(true);
    try {
      await onSync(version);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" disabled={busy} onClick={() => void click()}>
      {busy ? "Syncing…" : "Sync"}
    </button>
  );
}

function DerivativesSection({
  derivatives,
}: {
  derivatives: ProjectDerivativeDetail[];
}) {
  return (
    <section class="panel-section">
      <h2 class="section-heading">
        Derivatives <span class="count">{derivatives.length}</span>
      </h2>
      {derivatives.length === 0 ? (
        <p class="muted">No derivatives yet.</p>
      ) : (
        <ul class="rows">
          {derivatives.map((d) => (
            <li key={d.id}>
              <a href={docUrl(d.googleDocId)} target="_blank" rel="noreferrer">
                {d.audienceLabel ?? d.googleDocId}
              </a>
              <span class="muted"> · {formatDate(d.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReviewsSection({
  reviews,
  issuedLinks,
}: {
  reviews: ProjectReviewRequestDetail[];
  issuedLinks: Record<string, ReviewRequestResult>;
}) {
  return (
    <section class="panel-section">
      <h2 class="section-heading">
        Open reviews <span class="count">{reviews.length}</span>
      </h2>
      {reviews.length === 0 ? (
        <p class="muted">No open review requests.</p>
      ) : (
        <ul class="rows">
          {reviews.map((r) => (
            <ReviewRow
              key={r.id}
              review={r}
              issued={issuedLinks[r.id] ?? null}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ReviewRow({
  review,
  issued,
}: {
  review: ProjectReviewRequestDetail;
  issued: ReviewRequestResult | null;
}) {
  const [expanded, setExpanded] = useState(issued !== null);
  const linkByUser = new Map(
    issued?.assignees.map((a) => [a.userId, a.links] as const) ?? [],
  );

  return (
    <li>
      <button
        type="button"
        class="review-row-toggle"
        onClick={() => setExpanded((v) => !v)}
      >
        <span>Version {review.versionId.slice(0, 8)}</span>
        <span class="muted">
          {" "}
          · {review.assignees.length} reviewer
          {review.assignees.length === 1 ? "" : "s"}
          · opened {formatDate(review.createdAt)}
          {review.deadline ? ` · due ${formatDate(review.deadline)}` : ""}
        </span>
      </button>
      {expanded ? (
        <div class="review-row-body">
          {review.assignees.length === 0 ? (
            <p class="muted">No reviewers assigned.</p>
          ) : (
            <ul class="review-assignees">
              {review.assignees.map((a) => (
                <li key={a.userId}>
                  <span>{a.email}</span>
                  <span class={`status-badge status-assignment-${a.status}`}>
                    {ASSIGNMENT_STATUS_LABEL[a.status]}
                  </span>
                  {a.respondedAt ? (
                    <span class="muted">
                      {" "}
                      · responded {formatDate(a.respondedAt)}
                    </span>
                  ) : null}
                  {linkByUser.has(a.userId) ? (
                    <ul class="review-magic-links">
                      {linkByUser.get(a.userId)!.map((l) => (
                        <li key={l.action}>
                          <code class="muted">{ACTION_LABEL[l.action]}: </code>
                          <code>{l.url}</code>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}

const ASSIGNMENT_STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  reviewed: "Reviewed",
  changes_requested: "Changes requested",
  declined: "Declined",
};

const ACTION_LABEL: Record<ReviewActionKind, string> = {
  mark_reviewed: "mark reviewed",
  request_changes: "request changes",
  decline: "decline",
  accept_reconciliation: "accept reconciliation",
};

function docUrl(googleDocId: string): string {
  return `https://docs.google.com/document/d/${encodeURIComponent(googleDocId)}/edit`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString();
}

function formatRelative(ts: number | null): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

