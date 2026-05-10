import type { ActiveDocTab } from "../Popup.tsx";

interface Props {
  tab: ActiveDocTab | null;
  message: string;
  /** Null when the original tab is unknown (boot-time error before tab resolved). */
  onRetry: (() => void) | null;
}

export function ErrorView({ tab, message, onRetry }: Props) {
  const heading = tab?.title || "Google Doc";
  return (
    <>
      {tab && (
        <p class="title" title={heading}>
          {heading}
        </p>
      )}
      <p class="error">{message}</p>
      {onRetry && (
        <div class="actions">
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
    </>
  );
}
