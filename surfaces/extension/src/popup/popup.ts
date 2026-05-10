import { ext } from "../shared/browser.ts";
import type { Message, MessageResponse } from "../shared/messages.ts";
import { parseDocIdFromUrl } from "../content/ids.ts";
import { getDocTitle } from "../shared/storage.ts";
import type {
  DocState,
  PickerConfig,
  RegisterDocResult,
  Settings,
} from "../shared/types.ts";

/**
 * Popup state machine. Three primary states for the active doc — untracked,
 * tracked-as-parent, tracked-as-version — plus the no-doc / no-settings
 * onboarding paths and the picker overlay. The "picker overlay" is a
 * sandboxed iframe (popup/picker-sandbox.html) the popup talks to via
 * postMessage; on Firefox MV3 (no sandbox.pages support yet) we fall back
 * to opening the backend `/picker` page in a new tab.
 *
 * The diagnostics panel at the bottom (queue size / last error / Flush)
 * is the old popup's body — kept for ops use but folded into a <details>
 * so the project surface is the headline.
 */

const main = document.getElementById("main") as HTMLElement;
const pickerFrame = document.getElementById("picker-frame") as HTMLIFrameElement;
const diagnostics = document.getElementById("diagnostics") as HTMLDetailsElement;
const conn = document.getElementById("connection") as HTMLParagraphElement;
const queue = document.getElementById("queue") as HTMLElement;
const lastError = document.getElementById("last-error") as HTMLElement;
const flushBtn = document.getElementById("flush") as HTMLButtonElement;
const openOptionsBtn = document.getElementById("open-options") as HTMLButtonElement;

interface ActiveDocTab {
  docId: string;
  /** Real doc name from chrome.storage.local; empty until the content script scrapes it. */
  title: string;
}

void boot();

openOptionsBtn.addEventListener("click", () => {
  ext.runtime.openOptionsPage();
});

flushBtn.addEventListener("click", async () => {
  flushBtn.disabled = true;
  try {
    await sendMessage({ kind: "queue/flush" });
    await refreshDiagnostics();
  } finally {
    flushBtn.disabled = false;
  }
});

async function boot(): Promise<void> {
  void refreshDiagnostics();

  const settings = await getSettings();
  if (!settings) {
    renderNoSettings();
    return;
  }

  const tab = await getActiveDocTab();
  if (!tab) {
    renderNoDoc();
    return;
  }

  await renderDocState(tab);
}

async function getSettings(): Promise<Settings | null> {
  const r = await sendMessage({ kind: "settings/get" });
  if (r?.kind === "settings/get") return r.settings;
  return null;
}

async function getActiveDocTab(): Promise<ActiveDocTab | null> {
  const tabs = await ext.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.url) return null;
  const docId = parseDocIdFromUrl(tab.url);
  if (!docId) return null;
  const title = (await getDocTitle(docId)) ?? "";
  return { docId, title };
}

async function renderDocState(tab: ActiveDocTab): Promise<void> {
  renderLoading(tab);
  let state: DocState | null;
  try {
    const r = await sendMessage({ kind: "doc/state", docId: tab.docId });
    state = r?.kind === "doc/state" ? r.state : null;
    if (r && "error" in r && r.error) {
      renderError(tab, r.error);
      return;
    }
  } catch (err) {
    renderError(tab, err instanceof Error ? err.message : String(err));
    return;
  }
  if (!state) {
    renderError(tab, "no response from backend");
    return;
  }
  if (!state.tracked) {
    renderUntracked(tab);
    return;
  }
  renderTracked(tab, state);
}

function renderLoading(tab: ActiveDocTab): void {
  main.replaceChildren();
  main.append(
    titleEl(tab.title || "Google Doc"),
    el("p", { class: "muted" }, "Loading…"),
  );
}

function renderError(tab: ActiveDocTab, message: string): void {
  main.replaceChildren();
  const retry = button("Retry", { primary: false, onClick: () => void renderDocState(tab) });
  main.append(
    titleEl(tab.title || "Google Doc"),
    el("p", { class: "error" }, message),
    el("div", { class: "actions" }, retry),
  );
}

function renderNoSettings(): void {
  main.replaceChildren();
  const open = button("Open Options", {
    primary: true,
    onClick: () => ext.runtime.openOptionsPage(),
  });
  main.append(
    el("p", { class: "muted" }, "Configure your Docket backend URL and API token to get started."),
    el("div", { class: "actions" }, open),
  );
  diagnostics.open = true;
}

function renderNoDoc(): void {
  main.replaceChildren();
  main.append(
    el(
      "p",
      { class: "muted" },
      "Open a Google Doc to add it to a Docket project or check sync status.",
    ),
  );
}

function renderUntracked(tab: ActiveDocTab): void {
  main.replaceChildren();
  const add = button("Add to Docket", {
    primary: true,
    onClick: () => void startAddFlow(tab),
  });
  main.append(
    titleEl(tab.title || "Google Doc"),
    el("p", { class: "subtitle" }, "Not tracked yet."),
    el(
      "p",
      { class: "muted" },
      "Adds this doc as a Docket project so reviewer comments + suggestions get captured.",
    ),
    el("div", { class: "actions" }, add),
  );
}

function renderTracked(tab: ActiveDocTab, state: Extract<DocState, { tracked: true }>): void {
  main.replaceChildren();
  const versionLabel = state.version?.label ?? "no versions yet";
  const role = state.role === "parent" ? "Parent" : `Version ${versionLabel}`;
  const ownerLine = state.project.ownerEmail ?? "owner unknown";

  const sync = button("Sync now", {
    primary: false,
    onClick: () => void runSync(tab, sync),
  });
  sync.id = "sync";

  main.append(
    titleEl(tab.title || "Google Doc"),
    el("p", { class: "subtitle" }, `${role} · ${ownerLine}`),
    el(
      "div",
      { class: "stats" },
      stat("Comments", String(state.commentCount)),
      stat("Open reviews", String(state.openReviewCount)),
      stat("Version", versionLabel),
      stat("Last synced", formatLastSynced(state.lastSyncedAt)),
    ),
    el("div", { class: "actions" }, sync),
  );
}

async function runSync(tab: ActiveDocTab, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = "Syncing…";
  try {
    const r = await sendMessage({ kind: "doc/sync", docId: tab.docId });
    if (r?.kind === "doc/sync") {
      if (r.error) {
        renderError(tab, r.error);
        return;
      }
      if (r.state?.tracked) {
        renderTracked(tab, r.state);
        return;
      }
      if (r.state && !r.state.tracked) {
        renderUntracked(tab);
        return;
      }
    }
    renderError(tab, "no response from backend");
  } catch (err) {
    renderError(tab, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Begins the "Add this doc" flow. On Chromium we mount the sandboxed Picker
 * iframe inline; on Firefox MV3 (no sandbox.pages) we open the backend
 * `/picker` page in a new tab and close the popup. The two paths converge
 * on the same backend call (`/api/picker/register-doc`) — only the host
 * differs.
 */
async function startAddFlow(tab: ActiveDocTab): Promise<void> {
  if (!supportsSandboxedPicker()) {
    await openBackendPickerTab(tab);
    return;
  }
  await openSandboxedPicker(tab);
}

function supportsSandboxedPicker(): boolean {
  // Firefox MV3 doesn't support sandbox.pages yet. The chromium manifest
  // declares the sandbox; the Firefox manifest doesn't, so the iframe
  // wouldn't be sandboxed and the external script loads would be CSP-
  // blocked anyway. Detect Firefox via the standard userAgent token —
  // good enough for an in-popup feature gate.
  return !navigator.userAgent.includes("Firefox");
}

async function openBackendPickerTab(tab: ActiveDocTab): Promise<void> {
  const settings = await getSettings();
  if (!settings) {
    renderError(tab, "no backend configured");
    return;
  }
  const params = new URLSearchParams({
    token: settings.apiToken,
    suggestedDocId: tab.docId,
  });
  if (tab.title) params.set("suggestedTitle", tab.title);
  const base = settings.backendUrl.replace(/\/+$/, "");
  await ext.tabs.create({ url: `${base}/picker#${params.toString()}` });
  window.close();
}

async function openSandboxedPicker(tab: ActiveDocTab): Promise<void> {
  const r = await sendMessage({ kind: "picker/config" });
  const cfg = r?.kind === "picker/config" ? r.config : null;
  if (!cfg) {
    renderError(
      tab,
      "Picker is not configured on the backend (GOOGLE_API_KEY / GOOGLE_PROJECT_NUMBER missing).",
    );
    return;
  }

  main.replaceChildren();
  main.append(
    titleEl(tab.title || "Google Doc"),
    el("p", { class: "muted", id: "picker-status" }, "Loading Picker…"),
  );
  // Set src lazily so Firefox (no sandbox.pages support) doesn't even
  // attempt to load the picker scripts. Browsers that support sandbox
  // start fetching gapi/gsi here.
  if (!pickerFrame.src) pickerFrame.src = "picker-sandbox.html";
  pickerFrame.hidden = false;

  await waitForPickerReady(cfg, tab);
  postToPicker({ type: "open" });
}

interface PickerInbound {
  type: "ready" | "picked" | "cancelled" | "error";
  docId?: string;
  name?: string;
  message?: string;
}

let pickerReadyResolver: (() => void) | null = null;
let pickerReadyState: "pending" | "ready" = "pending";
let pickerCurrentTab: ActiveDocTab | null = null;

window.addEventListener("message", (ev: MessageEvent<PickerInbound>) => {
  if (ev.source !== pickerFrame.contentWindow) return;
  const data = ev.data;
  if (!data || typeof data !== "object" || !("type" in data)) return;
  if (data.type === "ready") {
    pickerReadyState = "ready";
    pickerReadyResolver?.();
    pickerReadyResolver = null;
    return;
  }
  if (data.type === "cancelled") {
    setPickerStatus("Cancelled.");
    pickerFrame.hidden = true;
    if (pickerCurrentTab) renderUntracked(pickerCurrentTab);
    return;
  }
  if (data.type === "error") {
    if (pickerCurrentTab) {
      renderError(pickerCurrentTab, data.message ?? "Picker error");
    } else {
      setPickerStatus(data.message ?? "Picker error", "error");
    }
    pickerFrame.hidden = true;
    return;
  }
  if (data.type === "picked" && data.docId) {
    void completeRegistration(data.docId, data.name ?? "");
  }
});

function postToPicker(msg: { type: "init"; config: PickerConfig & { suggestedDocId?: string; suggestedTitle?: string } } | { type: "open" }): void {
  pickerFrame.contentWindow?.postMessage(msg, "*");
}

async function waitForPickerReady(cfg: PickerConfig, tab: ActiveDocTab): Promise<void> {
  pickerCurrentTab = tab;
  // Two-phase: first wait for the iframe to finish loading (so the sandbox
  // module script has run and its `message` listener is installed), then
  // post `init` and wait for the sandbox's `ready` (signalling gapi+gsi
  // are both available). If we posted init before the script ran the
  // message would land on a `null` listener and never reach the sandbox.
  await iframeLoaded(pickerFrame);
  postToPicker({
    type: "init",
    config: { ...cfg, suggestedDocId: tab.docId, suggestedTitle: tab.title || undefined },
  });
  if (pickerReadyState === "ready") return;
  await new Promise<void>((resolve) => {
    pickerReadyResolver = resolve;
  });
}

function iframeLoaded(frame: HTMLIFrameElement): Promise<void> {
  return new Promise<void>((resolve) => {
    frame.addEventListener("load", () => resolve(), { once: true });
  });
}

async function completeRegistration(docId: string, _name: string): Promise<void> {
  const tab = pickerCurrentTab;
  if (!tab) return;
  pickerFrame.hidden = true;
  setPickerStatus("");
  main.replaceChildren();
  main.append(
    titleEl(tab.title || "Google Doc"),
    el("p", { class: "muted" }, "Registering with Docket…"),
  );

  const r = await sendMessage({ kind: "doc/register", docUrlOrId: docId });
  const result: RegisterDocResult | null =
    r?.kind === "doc/register" ? r.result : null;
  if (!result) {
    renderError(tab, "no response from backend");
    return;
  }
  if (result.kind === "error") {
    renderError(tab, result.message);
    return;
  }
  // Re-fetch state so the tracked view reflects the new project. Use the
  // *originally open* tab's docId — register-doc accepts either parent or
  // version doc ids, but the popup is contextual to the open doc.
  await renderDocState(tab);
}

function setPickerStatus(msg: string, tone: "ok" | "error" | null = null): void {
  const status = document.getElementById("picker-status");
  if (!status) return;
  status.textContent = msg;
  if (tone) status.dataset.tone = tone;
  else delete status.dataset.tone;
}

async function refreshDiagnostics(): Promise<void> {
  const settings = await getSettings();
  if (!settings) {
    conn.textContent = "No backend configured.";
    conn.dataset.tone = "error";
  } else {
    conn.textContent = `Probing ${settings.backendUrl}…`;
    conn.dataset.tone = "";
    void probeBackend(settings.backendUrl);
  }
  const peek = await sendMessage({ kind: "queue/peek" });
  if (peek?.kind === "queue/peek") {
    queue.textContent = String(peek.queueSize);
    lastError.textContent = peek.lastError ?? "—";
  }
}

async function probeBackend(backendUrl: string): Promise<void> {
  const url = new URL("/healthz", backendUrl).toString();
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      conn.textContent = `Backend ${backendUrl} responded ${res.status}`;
      conn.dataset.tone = "error";
      return;
    }
    const json = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    if (!json?.ok) {
      conn.textContent = `Backend ${backendUrl} reachable but /healthz did not return ok`;
      conn.dataset.tone = "error";
      return;
    }
    conn.textContent = `Connected to ${backendUrl}`;
    conn.dataset.tone = "ok";
  } catch (err) {
    conn.textContent = `Backend ${backendUrl} unreachable: ${
      err instanceof Error ? err.message : String(err)
    }`;
    conn.dataset.tone = "error";
  }
}

function sendMessage(msg: Message): Promise<MessageResponse | undefined> {
  return ext.runtime.sendMessage(msg) as Promise<MessageResponse | undefined>;
}

function el(
  tag: string,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "id") node.id = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function titleEl(text: string): HTMLElement {
  const node = el("p", { class: "title" }, text);
  node.title = text;
  return node;
}

function stat(label: string, value: string): HTMLElement {
  return el("div", {}, el("p", { class: "stat-label" }, label), el("p", { class: "stat-value" }, value));
}

function button(
  text: string,
  opts: { primary: boolean; onClick: () => void },
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  if (opts.primary) b.classList.add("primary");
  b.addEventListener("click", opts.onClick);
  return b;
}

function formatLastSynced(ts: number | null): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
