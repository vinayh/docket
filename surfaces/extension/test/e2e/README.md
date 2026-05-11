# Browser-extension E2E rig — operator playbook

This is the operator/agent runbook for driving the Chrome extension
end-to-end via [`chrome-devtools-mcp`](https://github.com/google/chrome-devtools-mcp).
The MCP server is wired up at the repo-root `.mcp.json`; an MCP-capable
Claude session (or a human via Claude Code) is the test runner — there's
no Jest/Vitest harness.

The smoke flow this playbook covers:

1. Local backend up at `http://localhost:8787`.
2. Test user (`test.1@hiremath.net`) already OAuth-connected with a long-lived
   API token (already in `.env` as `DOCKET_TEST_API_TOKEN`).
3. Fresh `dist/chrome-mv3` installed into the persistent test profile.
4. Extension settings (backend URL + token + `http://localhost:8787/*`
   permission) pre-seeded into `chrome.storage.local`.
5. New Google Doc created via `doc.new` → doc id extracted from URL.
6. Backend DB seeded with a project + v1 row for that doc id
   (`bun docket e2e seed-project`).
7. Click the toolbar action → popup renders the **Tracked** view.
8. Click **Open dashboard** → side panel opens, Dashboard view renders the
   v1 row.

Diff rendering is not in this smoke flow — it requires two real Google Doc
versions reachable via the test user's `drive.file` scope. Add that as a
follow-up slice when seeding a 2nd version becomes possible.

---

## Prereqs (one-time)

- `.docket-test-chrome/` exists at the repo root with the test Google
  account already signed in (cookies + keychain in the profile).
- `.env` has `DOCKET_TEST_USER_EMAIL` and `DOCKET_TEST_API_TOKEN` set —
  see `.env.example`. The user must already exist in the DB (`bun docket
  connect` once with that account if not).
- `bun run typecheck && bun test` clean.

## Step-by-step (Bash commands the agent runs)

```sh
# 1. Build a fresh extension.
bun run ext:build

# 2. (Re)start the local backend on :8787.
#    Run in a separate shell or via `run_in_background`.
bun docket serve

# 3. Sanity: backend reachable.
curl -fsS http://localhost:8787/healthz
```

The MCP-driven Claude does the rest via `chrome-devtools-mcp` tools (see
"MCP tool sequence" below). After it captures a doc id from `doc.new`:

```sh
# 4. Seed the local DB with a project + v1 row for the newly created doc.
DOCKET_ALLOW_E2E_SEED=1 bun docket e2e seed-project <doc-id>
```

`--user` defaults to `$DOCKET_TEST_USER_EMAIL`. The CLI refuses to seed
without `DOCKET_ALLOW_E2E_SEED=1` so we don't trash a production DB.

## MCP tool sequence

The MCP-driven Claude session executes these tool calls in order. Names
match `chrome-devtools-mcp`. Replace the placeholder `<EXT_ID>` with the
id returned by `install_extension`; replace `<DOC_ID>` with what
`evaluate_script` extracts from the doc URL.

### A. Install the unpacked extension

```
install_extension(path="surfaces/extension/dist/chrome-mv3")
→ returns { extensionId: "<EXT_ID>" }
```

### B. Seed extension settings (chrome.storage.local) inside the SW

The popup reads `chrome.storage.local.settings` (`backendUrl` + `apiToken`).
We pre-populate that map from the SW context — the only frame the
extension exposes with `chrome.storage` access. Get the SW id via
`list_extensions`, then:

```
evaluate_script(
  serviceWorkerId="<SW_ID_FOR_EXT_ID>",
  expression=`
    chrome.storage.local.set({
      settings: {
        backendUrl: "http://localhost:8787",
        apiToken: "<DOCKET_TEST_API_TOKEN>"
      }
    }).then(() => "ok")
  `,
)
```

### C. Grant the `http://localhost:8787/*` origin permission

Chrome refuses programmatic `chrome.permissions.request` outside a user
gesture. Workaround: navigate to the Options page, then click the
**Test connection** button — the click is a real gesture and the handler
calls `permissions.request` for the configured backend URL.

```
new_page(url="chrome-extension://<EXT_ID>/options.html")
take_snapshot()
click(<test-connection-button-uid>)
# Accept the permission prompt the OS shows. chrome-devtools-mcp surfaces
# it as a dialog; handle via `handle_dialog(action="accept")` if it shows
# up in the console-message stream.
```

### D. Create a fresh doc and capture its id

```
new_page(url="https://docs.new")
wait_for(selector="canvas.kix-canvas-tile-content", timeout=15000)
evaluate_script(expression=`
  const m = location.pathname.match(/\\/document\\/d\\/([^/]+)/);
  return m ? m[1] : null;
`)
→ returns "<DOC_ID>"
```

### E. Seed the backend DB for that doc

Run via Bash, **not** the MCP browser session:

```sh
DOCKET_ALLOW_E2E_SEED=1 bun docket e2e seed-project <DOC_ID>
```

### F. Open the popup, assert Tracked view

The toolbar action opens the popup. The popup auto-resolves the active
tab → doc id → `doc/state` → renders the Tracked view because the seed
landed.

```
trigger_extension_action(extensionId="<EXT_ID>")
take_snapshot()
# Assertions to make against the snapshot text:
#   - contains "Sync now"
#   - contains "Open dashboard"
#   - contains "v1"  (or whatever --label was passed to the seed)
```

If the popup shows "Add to Docket" (Untracked view) instead, either the
SW settings didn't seed (check `chrome.storage.local` in the SW) or the
backend can't see the seed row (check `bun docket e2e seed-project` output
or `bun docket project list`).

### G. Side-panel rendering — open as a standalone page, NOT via the popup

The popup's **Open dashboard** button calls `chrome.sidePanel.open()` then
`window.close()`. The self-close wedges `chrome-devtools-mcp`: it loses
the selected-page pointer and every subsequent tool call errors with
"The selected page has been closed. Call list_pages to see open pages." —
including `list_pages` itself. Reproduced 2026-05-11 against
`chrome-devtools-mcp@latest`. Verified that this affects: the real side
panel does open in the browser, but MCP can't reach it.

**Workaround for automated coverage:** test the side panel's Preact app
by opening `sidepanel.html?activeDocId=<DOC_ID>` as a standalone tab. The
`?activeDocId=` query parameter is honored by
`entrypoints/sidepanel/App.tsx` only when present — production opens
don't pass it — and overrides the `browser.tabs.query({active})` lookup
that would otherwise resolve to the standalone tab itself. Production
`chrome.sidePanel.open()` glue is the only piece left untested on this
path.

```
new_page(url="chrome-extension://<EXT_ID>/sidepanel.html?activeDocId=<DOC_ID>")
take_snapshot()
# Assertions to make against the snapshot text:
#   - contains the doc title ("Untitled document" if just opened via doc.new)
#   - contains "v1" version row
#   - contains "Diff" button on the version row
```

To restore "real side panel" coverage in the future, either:

- Skip the popup → click path and open the panel from the SW context
  with `chrome.sidePanel.open()` immediately after a real keyboard /
  pointer gesture surfaced via MCP (`press_key`). The user-gesture window
  must be active when the API fires.
- Or accept that real-panel rendering is verified by hand only, and keep
  automated coverage on the standalone-tab path.

## Recovering from a wedged MCP session

If a tool call ever returns "The selected page has been closed. Call
list_pages to see open pages." and `list_pages` itself returns the same
error, the chrome-devtools-mcp protocol session is stuck — no agent-side
recovery exists. The most reliable cause is the popup self-closing
(case G above). To recover:

- In Claude Code: `/mcp` → reconnect `chrome-devtools` (drops the
  protocol session and re-pairs against the running Chrome).
- Failing that: kill Chrome (`pkill -f .docket-test-chrome`) and re-run
  the playbook from step A. The persistent profile retains cookies + the
  granted host permission, so re-install is the only repeated work.

## Failure modes worth knowing

- **Side panel doesn't open from popup.** `chrome.sidePanel.open` rejects
  outside a user gesture. The popup wires the call to the button's onClick,
  but if the click was synthesized too far from the popup boot, the API
  rejects. Re-trigger the toolbar action so the popup re-opens, then click.
- **"Add to Docket" shows up instead of Tracked.** Either the seed didn't
  run, the doc id captured from the URL is wrong (Docs sometimes redirects
  through an interstitial), or the popup is querying a backend URL
  different from the one the seed wrote to. Cross-check by running
  `curl -H "Authorization: Bearer $DOCKET_TEST_API_TOKEN" -d
  '{"docId":"<DOC_ID>"}' http://localhost:8787/api/extension/doc-state`.
- **Selectors moved.** `DOC_NAME_SELECTORS` in
  `entrypoints/docs.content/index.ts` rots when Docs reships
  (~quarterly). The popup's "title cache" depends on the content script
  scanning the title input. Fresh-doc title defaults to "Untitled
  document" until you type a name — that's expected.
- **"Test connection" doesn't grant `localhost:8787/*`.** Some Chrome
  channels suppress the permission prompt when the origin is `localhost`.
  Workaround: load any `http://localhost:8787/` URL via `new_page` first
  — that forces Chrome to register the origin as known before the
  permission request fires.

## What this is NOT (yet)

- Automated regression test. Re-running the playbook is manual; promote
  to a CI-friendly form (Bun test + `chrome-devtools-mcp` direct binding,
  or Playwright/Puppeteer with the bundled extension) once the surface
  area stabilizes.
- Diff renderer coverage. Needs 2 versions of a doc the test user has
  `drive.file` on — easiest via a real `bun docket version create` round
  trip against a doc Docket itself created (via Picker or
  `drive.files.create`). See SPEC §9.2 for why `doc.new`-created docs
  don't qualify.
- Capture-pipeline coverage. The content script scrapes suggestion-thread
  replies; exercising that requires authoring a tracked-change suggestion
  + reply in the test doc. Doable but adds five minutes of MCP-tool
  choreography per run — separate slice.

## Hooks for future work

- A `bun docket e2e seed-project-with-two-versions <doc-id-from>
  <doc-id-to>` would unblock diff-view assertions. Once available, add
  step H: navigate to side-panel diff and assert the structured-diff DOM.
- A `bun docket e2e reset` (truncate test user's projects) would let the
  same playbook re-run cleanly without poking the DB by hand. Add when
  re-running starts hurting.
- Real side-panel coverage (vs. standalone-tab) would mean driving a
  synthesized keyboard / pointer gesture via MCP to satisfy
  `chrome.sidePanel.open()`'s user-gesture requirement, then handling the
  popup-close MCP wedge (see "Recovering from a wedged MCP session"). Not
  worth the complexity until the panel-open glue itself becomes the
  thing being changed.
