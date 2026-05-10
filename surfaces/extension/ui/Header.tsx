import { browser } from "wxt/browser";

/**
 * Title bar shared by the popup and the side panel. Same shape, same
 * "Options" button — pulled out when the side-panel landed (Phase 4) so
 * both surfaces stay in sync.
 */
export function Header() {
  return (
    <header>
      <strong>Docket</strong>
      <button
        type="button"
        onClick={() => browser.runtime.openOptionsPage()}
      >
        Options
      </button>
    </header>
  );
}
