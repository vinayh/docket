import type { ActiveDocTab } from "../Popup.tsx";

interface Props {
  tab: ActiveDocTab;
  onAdd: () => void;
}

export function Untracked({ tab, onAdd }: Props) {
  const heading = tab.title || "Google Doc";
  return (
    <>
      <p class="title" title={heading}>
        {heading}
      </p>
      <p class="subtitle">Not tracked yet.</p>
      <p class="muted">
        Adds this doc as a Docket project so reviewer comments + suggestions
        get captured.
      </p>
      <div class="actions">
        <button type="button" class="primary" onClick={onAdd}>
          Add to Docket
        </button>
      </div>
    </>
  );
}
