# Extension QA — manual test plan

End-to-end checklist for the browser extension + the backend routes it depends on.
Walk through top to bottom; each step is self-contained so you can stop and resume.

Assumes a local backend at `http://localhost:8787` (`bun margin serve`) and a fresh
Chrome profile with `dist/chrome-mv3` loaded unpacked. Repeat §10–11 against
Firefox (`dist/firefox-mv3`) and Edge.

---

## 1. Install & first-run

1. `bun run ext:build` → load `surfaces/extension/dist/chrome-mv3` via
   `chrome://extensions` → Developer Mode → **Load unpacked**.
2. Confirm the toolbar icon appears.
3. Confirm the **Options** page opens in a tab (not a popup) automatically
   on install. If it doesn't, right-click the icon → **Options**.

## 2. Options — backend URL

1. Enter `http://localhost:8787` in the Backend URL field.
2. Click **Test connection**. Chrome should prompt to grant the origin;
   approve it.
3. Verify `/healthz` returns OK (status flips to green / "reachable").
4. Click **Save backend URL**. Reload the Options page; the URL should
   persist.
5. Enter a malformed URL (`not-a-url`) → expect inline validation error.
6. Enter an unreachable URL (`http://localhost:9999`) → **Test connection**
   surfaces a clear error, no save.

## 3. Options — sign in / sign out

1. Click **Sign in with Google**. A top-level tab opens at
   `/api/auth/ext/launch-tab?ext=<extension-id>`.
2. Complete the Google consent flow.
3. Land on `/api/auth/ext/success`; tab should auto-close (Chromium) or
   surface the hash fallback (Firefox).
4. Back on the Options page, the UI flips to **Signed in** without a
   manual reload.
5. Click **Sign out** → state returns to **Signed out**.
6. Sign back in for the rest of the run.

## 4. Popup — pre-tracking states

1. Activate a tab that is **not** a Google Doc (e.g. `https://google.com`).
   Click the toolbar icon → expect **NoDoc** view.
2. Open the Options page in another tab and clear the backend URL; reopen
   the popup on a Docs tab → expect **NoSettings** view.
3. Restore the backend URL, sign out, reopen the popup on a Docs tab →
   expect **NeedsSignIn** view.
4. Sign back in.
5. Open a brand-new Google Doc you've never tracked. Click the icon →
   expect **Untracked** view with **Add to Margin** button.
6. Verify the doc title in the popup header has no trailing
   `" - Google Docs"` suffix.
7. Verify the Diagnostics `<details>` panel shows `/healthz` reachability.

## 5. Picker page

1. From the **Untracked** view, click **Add to Margin**. A new tab opens
   at `${backendUrl}/api/picker/page`. The popup closes.
2. Confirm the Drive Picker renders.
3. Sign out via Options, manually navigate to `/api/picker/page` →
   expect 302/401.
4. Sign back in, reopen the picker, select a Doc.
5. Tab POSTs to `/api/picker/register-doc` and auto-closes with a
   "tracked" message.
6. Try to register the same Doc again → expect graceful no-op or
   idempotent success (no duplicate project).
7. (If you have a second user account) Sign in as user B, try to register
   user A's already-tracked Doc → expect rejection or separate project.

## 6. Popup — Tracked view

1. Return to the Docs tab you just tracked.
2. Click the icon. Expect the **side panel** to open (not the popup) —
   see §8 for routing details.
3. If the side panel doesn't open and the popup does instead, that's a
   routing bug. Note and continue.
4. The popup (when shown for a tracked doc, e.g. before the SW cache
   updates) should show: role (parent/version), version label, comment
   count, last-synced timestamp, **Sync now**.
5. Click **Sync now** → comment count + last-synced refresh.
6. Force a backend error (stop `bun margin serve`) → click **Sync now**
   → expect **ErrorView** with retry. Restart the backend; retry
   succeeds.

## 7. Comment ingest round-trip

1. In the Google Doc, add an anchored comment.
2. Wait for Drive push webhook (or click **Sync now**).
3. Comment count in the popup / side panel reflects the new comment.
4. Add a suggestion (insert + delete) → re-sync → side-panel Comments
   view shows it with author and timestamp.
5. Reply to a comment in Docs → re-sync → reply shows under parent.

## 8. Toolbar-icon routing

1. On an untracked Docs tab → icon click opens the **popup**.
2. On a tracked Docs tab → icon click opens the **side panel** directly.
3. Sign out via Options → return to the previously tracked tab → icon
   reverts to popup (cache invalidation works).
4. Sign back in, re-trigger `doc/state`, confirm side panel resumes.
5. Switch between two tracked tabs and a non-Doc tab; icon behavior
   should follow per-tab cache, not leak between tabs.

## 9. Side panel

1. Open the side panel on a tracked parent project.
2. **Dashboard** lists: versions, derivatives, review history, reviewer
   participation.
3. Open **Version diff** for two versions → side-by-side renders with
   sensible alignment. Verify edge cases: identical versions (no diff),
   wholly rewritten version, deleted paragraphs.
4. Open **Comments** view → comments reconciled across versions.
5. Click a comment action (resolve / decline) → state updates; reload
   the side panel → state persists.
6. Open **Settings** in the side panel → reviewer email field saves;
   invalid email rejected.
7. Switch tabs between two tracked docs → side panel re-binds to the
   active doc.
8. Test loading state (slow network throttle) and empty state (project
   with no versions yet).

## 10. Review flow

1. From the side panel, send a review request to a second email address
   you control.
2. Inbox receives a magic link → open it.
3. Reviewer lands on `/api/review/:token` view; can approve / decline.
4. Click the link a second time → expect single-use rejection.
5. Wait past expiry (or temporarily shorten in config) → expired token
   rejected cleanly.
6. Decline transition reflects in the side-panel review history.

## 11. Background loops & Drive webhook

1. With `MARGIN_PUBLIC_BASE_URL` set, start the server and confirm
   `renewExpiringChannels` (~30 min) and `pollAllActiveVersions`
   (~10 min) loops log on boot.
2. Track a new Doc → confirm `createVersion` auto-subscribes a
   `files.watch` channel (check `watch_channels` table).
3. Trigger a Drive webhook (add a comment in the Doc) → `POST
   /webhooks/drive` returns 200; re-ingest fires; deduped if already
   current.
4. POST a malformed body to `/webhooks/drive` → still 200 OK, error
   logged.

## 12. Auth + secrets

1. With DevTools → Network, confirm every `/api/extension/*` call carries
   `Authorization: Bearer <token>`.
2. The session token never appears in popup / side-panel JS (only the
   SW touches `chrome.storage.local.settings.sessionToken`).
3. Expire the session server-side (delete the row) → next extension call
   returns 401 → extension surfaces **NeedsSignIn**.
4. In the DB, confirm `account.refresh_token` is encrypted (not a raw
   Google refresh token string).
5. Try `/api/auth/ext/launch-tab?ext=evil.example.com` → expect rejection
   (open-redirect guard, only Chromium/Firefox ID formats allowed).

## 13. CORS + cross-user isolation

1. From a non-extension origin (`curl -H 'Origin: https://evil.example'
   …`) hit `/api/extension/doc-state` → expect CORS rejection.
2. Preflight `OPTIONS` from the extension origin → 204 with correct
   `Access-Control-Allow-*` headers.
3. As user A, get a `docId` for one of A's projects. As user B, call
   `doc-state` with that `docId` → expect not-found / unauthorized,
   never A's data.

## 14. Cross-browser

1. Repeat §1–9 in **Edge** (same `chrome-mv3` build).
2. Repeat in **Firefox** with `dist/firefox-mv3` loaded via
   `about:debugging`. Specifically verify:
   - Sign-in **location.hash fallback** path (Firefox can't use
     `chrome.runtime.sendMessage` from web pages).
   - Side-panel equivalent renders (Firefox uses `sidebarAction`).
   - Permissions prompt fires on **Test connection** click.

## 15. Cleanup / persistence

1. Reload the extension (`chrome://extensions` → reload) → settings +
   session token persist; popup picks up cleanly.
2. Disable then re-enable the extension → same.
3. Uninstall → reinstall → expect clean state (no settings, no token).
4. After uninstall, confirm the backend session is still independently
   valid via the web (no orphan).
