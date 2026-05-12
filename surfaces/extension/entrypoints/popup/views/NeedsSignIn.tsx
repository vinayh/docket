import { browser } from "wxt/browser";

interface Props {
  backendUrl: string;
  onSignedIn: () => void;
}

/**
 * Shown when a backend URL is configured but `settings.sessionToken` is
 * empty. Opens a real top-level tab at the backend's `/launch-tab` route
 * — `chrome.identity.launchWebAuthFlow` is unusable now that Chrome 122+
 * stamps the extension origin onto Google's OAuth request (rejected by
 * Google's late-2024 policy for `Web application` clients).
 *
 * The success bridge at `/api/auth/ext/success` posts the session token
 * back to the SW via `chrome.runtime.sendMessage(extId, ...)`. The SW
 * writes it to `chrome.storage.local.settings.sessionToken`, the
 * Popup's `chrome.storage.onChanged` listener picks that up, and the
 * popup re-boots without the user touching anything.
 */
export function NeedsSignIn({ backendUrl, onSignedIn: _onSignedIn }: Props) {
  return (
    <>
      <p class="muted">
        Connected to <code>{backendUrl}</code>. Finish setup by signing in
        with Google.
      </p>
      <div class="actions">
        <button
          type="button"
          class="primary"
          onClick={() => void startTabSignIn(backendUrl)}
        >
          Sign in with Google
        </button>
      </div>
    </>
  );
}

async function startTabSignIn(backendUrl: string): Promise<void> {
  const trimmed = backendUrl.trim().replace(/\/+$/, "");
  const url = `${trimmed}/api/auth/ext/launch-tab?ext=${encodeURIComponent(
    browser.runtime.id,
  )}`;
  await browser.tabs.create({ url });
}
