import { browser } from "wxt/browser";

export function NoSettings() {
  return (
    <>
      <p class="muted">
        Configure your Docket backend URL and API token to get started.
      </p>
      <div class="actions">
        <button
          type="button"
          class="primary"
          onClick={() => browser.runtime.openOptionsPage()}
        >
          Open Options
        </button>
      </div>
    </>
  );
}
