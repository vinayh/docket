import { browser } from "wxt/browser";

export function Header() {
  return (
    <header>
      <strong>Docket</strong>
      <button
        id="open-options"
        type="button"
        onClick={() => browser.runtime.openOptionsPage()}
      >
        Options
      </button>
    </header>
  );
}
