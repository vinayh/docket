import { useState } from "preact/hooks";
import { sendMessage } from "../../../ui/sendMessage.ts";
import type {
  ProjectDerivativeDetail,
  ProjectDetail,
  ProjectReviewRequestDetail,
  ProjectVersionDetail,
} from "../../../utils/types.ts";

interface Props {
  detail: ProjectDetail;
  onOpenDiff: (fromVersionId: string, toVersionId: string) => void;
}

/**
 * Project dashboard: header, versions table (with per-version Sync),
 * derivatives, review requests. Per-version Sync routes through the
 * existing `doc/sync` SW handler using the version's `googleDocId` —
 * `getDocState` recognizes the version-role doc and ingests that exact
 * version, no schema change needed.
 */
export function Dashboard({ detail, onOpenDiff }: Props) {
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
      </div>

      <VersionsSection
        versions={current.versions}
        onSync={syncVersion}
        onOpenDiff={onOpenDiff}
      />
      <DerivativesSection derivatives={current.derivatives} />
      <ReviewsSection reviews={current.reviewRequests} />
    </>
  );
}

function VersionsSection({
  versions,
  onSync,
  onOpenDiff,
}: {
  versions: ProjectVersionDetail[];
  onSync: (v: ProjectVersionDetail) => Promise<void> | void;
  onOpenDiff: (fromVersionId: string, toVersionId: string) => void;
}) {
  return (
    <section class="panel-section">
      <h2 class="section-heading">
        Versions <span class="count">{versions.length}</span>
      </h2>
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
                    {v.parentVersionId ? (
                      <button
                        type="button"
                        onClick={() => onOpenDiff(v.parentVersionId!, v.id)}
                      >
                        Diff
                      </button>
                    ) : null}
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
}: {
  reviews: ProjectReviewRequestDetail[];
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
            <li key={r.id}>
              <span>Version {r.versionId.slice(0, 8)}</span>
              <span class="muted">
                {" "}
                · opened {formatDate(r.createdAt)}
                {r.deadline ? ` · due ${formatDate(r.deadline)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

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

