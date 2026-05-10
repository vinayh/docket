import type { ActiveDocTab, TrackedState } from "../Popup.tsx";

interface Props {
  tab: ActiveDocTab;
  state: TrackedState;
  onSync: () => void;
}

export function Tracked({ tab, state, onSync }: Props) {
  const heading = tab.title || "Google Doc";
  const versionLabel = state.version?.label ?? "no versions yet";
  const role = state.role === "parent" ? "Parent" : `Version ${versionLabel}`;
  const ownerLine = state.project.ownerEmail ?? "owner unknown";

  return (
    <>
      <p class="title" title={heading}>
        {heading}
      </p>
      <p class="subtitle">
        {role} · {ownerLine}
      </p>
      <div class="stats">
        <Stat label="Comments" value={String(state.commentCount)} />
        <Stat label="Open reviews" value={String(state.openReviewCount)} />
        <Stat label="Version" value={versionLabel} />
        <Stat label="Last synced" value={formatLastSynced(state.lastSyncedAt)} />
      </div>
      <div class="actions">
        <button id="sync" type="button" onClick={onSync}>
          Sync now
        </button>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p class="stat-label">{label}</p>
      <p class="stat-value">{value}</p>
    </div>
  );
}

function formatLastSynced(ts: number | null): string {
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
