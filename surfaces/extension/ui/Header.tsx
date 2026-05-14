import { openOptions } from "../utils/ui-surfaces.ts";

/**
 * Title bar shared by the popup and the side panel. Same shape, same
 * "Options" button — pulled out when the side-panel landed (Phase 4) so
 * both surfaces stay in sync.
 */
export function Header() {
  return (
    <header>
      <strong>Margin</strong>
      <button type="button" onClick={() => void openOptions()}>
        Options
      </button>
    </header>
  );
}
