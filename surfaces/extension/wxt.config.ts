import { defineConfig } from "wxt";
import preact from "@preact/preset-vite";

/**
 * WXT config. Replaces the hand-rolled `build.ts` + dual `manifest.*.json`
 * setup. Entrypoints under `entrypoints/` are auto-detected by filename
 * convention; per-browser manifest differences are expressed below via the
 * `(env)` callback rather than separate JSON files.
 *
 * Output goes to `.output/{chrome,firefox}-mv3/` (WXT default). Build with
 * `bun run ext:build` / `bun run ext:build:firefox` from the repo root.
 */
export default defineConfig({
  // Vite, not Bun, runs the build — WXT is built on Vite. Bun still drives
  // tests and the backend; only the extension pipeline changes here.
  manifestVersion: 3, // Firefox defaults to MV2 in WXT; we ship MV3 on both.
  // The codebase imports explicitly everywhere; WXT's auto-import scanner
  // re-exports every top-level binding it finds, which clashes with common
  // local names (e.g. `v` from `import * as v from "valibot"` getting
  // auto-injected into files that already use `v` as a loop variable).
  imports: false,
  // Default is `.output/`, but Finder + the Chrome "Load Unpacked" picker
  // hide leading-dot dirs.
  outDir: "dist",
  // Preact powers the popup + side panel (see entrypoints/popup/,
  // entrypoints/sidepanel/). Options, SW, content script, and the picker
  // sandbox stay plain TS — the preset is a Vite plugin so it applies
  // repo-wide, but only the popup/sidepanel files import anything
  // Preact-shaped, so the others are unaffected.
  vite: () => ({
    plugins: [preact()],
  }),
  manifest: ({ browser }) => ({
    name: "Margin",
    short_name: "Margin",
    version: "0.1.0",
    description:
      "Margin — review and version Google Docs without leaving Docs.",
    // `sidePanel` is Chromium-only (browser.sidePanel.* APIs); Firefox
    // uses `sidebar_action` declared below and ignores unknown permission
    // entries gracefully, but we keep the request scoped to Chromium so
    // the store reviewers see a clean list. Tab-based sign-in opens the
    // backend's `/api/auth/ext/launch-tab` page via `browser.tabs.create`,
    // which doesn't need the `identity` permission.
    permissions:
      browser === "firefox"
        ? ["storage"]
        : ["storage", "sidePanel"],
    // `docs.google.com` is known at build time and must be static: without
    // it the popup's `chrome.tabs.query({active: true, currentWindow: true})`
    // gets a Tab with `url`/`title` stripped on any Doc page, and falls
    // through to the no-doc view. Static grants happen at install with a
    // single consent prompt — no second-step "Test connection" needed.
    //
    // The user-configured backend URL is the only thing we genuinely can't
    // pin at build time, so `<all_urls>` stays optional and the Options
    // page calls `permissions.request` on save (see
    // entrypoints/options/main.ts).
    host_permissions: ["https://docs.google.com/*"],
    optional_host_permissions: ["<all_urls>"],
    // Tab-based OAuth bridge: the success page (`/api/auth/ext/success`)
    // running on the user-configured backend `chrome.runtime.sendMessage`s
    // the session token to this extension. We can't pin a host here because
    // the backend URL is user-configurable, so we declare the broadest match
    // pattern and gate `onMessageExternal` against `sender.origin === stored
    // backendUrl` in the SW. A third-party page that knows the extension ID
    // can post messages, but the SW drops them.
    externally_connectable: { matches: ["*://*/*"] },
    action: {
      default_title: "Margin",
      default_icon: {
        16: "icons/icon-16.png",
        32: "icons/icon-32.png",
        48: "icons/icon-48.png",
        128: "icons/icon-128.png",
      },
    },
    icons: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    },
    ...(browser === "firefox" && {
      browser_specific_settings: {
        gecko: {
          id: "extension@margin.dev",
          strict_min_version: "121.0",
        },
      },
      // Firefox sidebar lives under `sidebar_action`. Chromium uses the
      // `side_panel` key + the runtime `chrome.sidePanel.open()` API
      // (declared in the chromium branch below).
      sidebar_action: {
        default_panel: "sidepanel.html",
        default_title: "Margin",
        default_icon: {
          16: "icons/icon-16.png",
          32: "icons/icon-32.png",
        },
      },
    }),
    // Chromium-only side panel. The popup opens this via
    // `chrome.sidePanel.open` — see entrypoints/popup/views/Tracked.tsx.
    // `enabled: true` keeps the panel selectable from the side-panel
    // chooser even before the popup ever explicitly opens it.
    //
    // The Drive Picker used to live in a sandboxed iframe loaded by the
    // popup; Google's `origin_mismatch` enforcement on `Web application`
    // OAuth clients rejected the `chrome-extension://` parent origin, so
    // the picker now opens as a top-level tab served from the backend
    // origin instead (see `src/api/picker-page.ts`). No `sandbox.pages`
    // and no extension-side CSP for it.
    ...(browser === "chrome" && {
      side_panel: {
        default_path: "sidepanel.html",
      },
      minimum_chrome_version: "114", // chrome.sidePanel API
    }),
  }),
});
