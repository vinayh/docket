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
  // Default is `.output/`, but Finder + the Chrome "Load Unpacked" picker
  // hide leading-dot dirs.
  outDir: "dist",
  // Preact powers the popup only (see entrypoints/popup/). Options, SW,
  // content script, and the picker sandbox stay plain TS — the preset is
  // a Vite plugin so it applies repo-wide, but only popup files import
  // anything Preact-shaped, so the others are unaffected.
  vite: () => ({
    plugins: [preact()],
  }),
  manifest: ({ browser }) => ({
    name: "Docket",
    short_name: "Docket",
    version: "0.1.0",
    description:
      "Capture replies on Google Docs suggestion threads — the public Drive/Docs APIs do not expose them.",
    permissions: ["storage", "alarms"],
    host_permissions: ["https://docs.google.com/*"],
    // The user-configured backend URL isn't known at build time. We declare
    // `<all_urls>` as optional and request the specific origin from the
    // options page on save. See entrypoints/options/main.ts.
    optional_host_permissions: ["<all_urls>"],
    action: {
      default_title: "Docket",
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
          id: "extension@docket.dev",
          strict_min_version: "121.0",
        },
      },
    }),
    // Chromium-only: the sandboxed Picker iframe lives at
    // entrypoints/picker-sandbox.sandbox/. WXT auto-registers the sandbox
    // page from the `.sandbox.html` filename; we only need the CSP here
    // because the gapi + gsi script loads are external. Firefox MV3 lacks
    // `sandbox.pages`, and the popup detects via UA and falls back to a
    // backend `/picker` tab (see entrypoints/popup/main.ts).
    ...(browser === "chrome" && {
      content_security_policy: {
        sandbox:
          "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals; script-src 'self' https://accounts.google.com https://apis.google.com; style-src 'self' 'unsafe-inline'; connect-src https://accounts.google.com https://apis.google.com https://www.googleapis.com; frame-src https://accounts.google.com https://docs.google.com https://content.googleapis.com; img-src 'self' data: https:;",
      },
      minimum_chrome_version: "109",
    }),
  }),
});
