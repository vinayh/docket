import { openOptions } from "../../../utils/ui-surfaces.ts";

export function NoSettings() {
  return (
    <>
      <p class="muted">Open Options to sign in with Google.</p>
      <div class="actions">
        <button
          type="button"
          class="primary"
          onClick={() => void openOptions()}
        >
          Open Options
        </button>
      </div>
    </>
  );
}
