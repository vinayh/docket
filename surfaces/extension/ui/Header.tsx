import { openOptions } from "../utils/ui-surfaces.ts";

/**
 * Title bar shared by the popup and the side panel. Same shape, same
 * "Options" button — pulled out when the side-panel landed (Phase 4) so
 * both surfaces stay in sync. When `email` is provided, the signed-in
 * user's identity sits between the brand and the Options button — the
 * side panel uses this so users don't read a per-project `Owner:` line as
 * "the Drive doc's owner" (which it isn't).
 */
export function Header({ email }: { email?: string | null }) {
  return (
    <header>
      <strong>Margin</strong>
      {email ? <span class="muted header-email">{email}</span> : null}
      <button type="button" onClick={() => void openOptions()}>
        Options
      </button>
    </header>
  );
}
