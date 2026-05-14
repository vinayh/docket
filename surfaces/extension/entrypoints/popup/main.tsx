import { render } from "preact";
import { detectAndPersistBrowserQuirks } from "../../utils/browser-detect.ts";
import { Popup } from "./Popup.tsx";

// Detect Arc-style browsers that no-op the native side panel. Result is
// cached in chrome.storage.local; the SW reads it sync at action-click time.
// Idempotent — only writes when the detected value changes.
void detectAndPersistBrowserQuirks();

const root = document.getElementById("app");
if (root) render(<Popup />, root);
