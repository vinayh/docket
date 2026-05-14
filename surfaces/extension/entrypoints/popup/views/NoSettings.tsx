import { openOptions } from "../../../utils/ui-surfaces.ts";

export function NoSettings() {
  return (
    <>
      <p class="muted">
        Configure your Margin backend URL to get started.
      </p>
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
