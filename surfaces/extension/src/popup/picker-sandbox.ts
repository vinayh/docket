/**
 * Sandboxed Drive Picker host. Loaded inside an iframe in the popup so the
 * popup itself doesn't have to load `apis.google.com` / `accounts.google.com`
 * — MV3 extension pages can't, but sandbox pages can per the manifest's
 * `content_security_policy.sandbox` field.
 *
 * The sandbox runs in a `null` origin: it has no `chrome.*` access and
 * can't be in the backend's CORS allow-list. We pass config in via
 * `postMessage` from the popup, post the picked doc id back, and let the
 * popup (which is on `chrome-extension://...` and has the API token) make
 * the actual `/api/picker/register-doc` request.
 *
 * Firefox MV3 has no sandbox.pages support yet, so on Firefox the popup
 * falls back to opening the backend `/picker` tab directly. This file is
 * Chromium-only.
 */
declare global {
  interface Window {
    gapi?: GapiNamespace;
    google?: GoogleNamespace;
  }
}

interface GapiNamespace {
  load(name: "picker", cb: () => void): void;
}

interface GoogleNamespace {
  accounts: {
    oauth2: {
      initTokenClient(opts: {
        client_id: string;
        scope: string;
        callback: (resp: { error?: string; access_token?: string }) => void;
      }): { requestAccessToken(opts: { prompt: string }): void };
    };
  };
  picker: {
    Action: { CANCEL: string; PICKED: string };
    DocsView: new (viewId: unknown) => DocsView;
    DocsViewMode: { LIST: unknown };
    PickerBuilder: new () => PickerBuilder;
    ViewId: { DOCUMENTS: unknown };
  };
}
interface DocsView {
  setMimeTypes(mime: string): DocsView;
  setOwnedByMe(b: boolean): DocsView;
  setMode(mode: unknown): DocsView;
  setQuery(q: string): DocsView;
}
interface PickerBuilder {
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  addView(view: DocsView): PickerBuilder;
  setTitle(title: string): PickerBuilder;
  setCallback(cb: (data: PickerCallbackData) => void): PickerBuilder;
  build(): { setVisible(b: boolean): void };
}
interface PickerCallbackData {
  action: string;
  docs?: { id: string; name?: string }[];
}

interface PickerInitConfig {
  clientId: string;
  apiKey: string;
  projectNumber: string;
  suggestedDocId?: string;
  suggestedTitle?: string;
}

type Inbound =
  | { type: "init"; config: PickerInitConfig }
  | { type: "open" };

type Outbound =
  | { type: "ready" }
  | { type: "picked"; docId: string; name?: string }
  | { type: "cancelled" }
  | { type: "error"; message: string };

const statusEl = document.getElementById("status") as HTMLParagraphElement;
let pendingConfig: PickerInitConfig | null = null;
let gapiReady = false;
let gsiReady = false;
let initialized = false;

function setStatus(msg: string, tone: "ok" | "error" | null = null): void {
  statusEl.textContent = msg;
  if (tone) statusEl.dataset.tone = tone;
  else delete statusEl.dataset.tone;
}

function send(msg: Outbound): void {
  // The parent extension page is on a real origin (`chrome-extension://...`).
  // We don't pin a target here because the parent's origin is not visible
  // from this null-origin sandbox. The popup is the only listener that
  // ever loads this iframe; using "*" is bounded by the iframe's parent
  // relationship and safe for these payloads (no secrets cross either way).
  parent.postMessage(msg, "*");
}

function maybeReady(): void {
  if (gapiReady && gsiReady && !initialized) {
    initialized = true;
    send({ type: "ready" });
  }
}

const gapiCheck = setInterval(() => {
  if (window.gapi) {
    clearInterval(gapiCheck);
    window.gapi.load("picker", () => {
      gapiReady = true;
      maybeReady();
    });
  }
}, 100);
const gsiCheck = setInterval(() => {
  if (window.google?.accounts?.oauth2) {
    clearInterval(gsiCheck);
    gsiReady = true;
    maybeReady();
  }
}, 100);

window.addEventListener("message", (ev: MessageEvent<Inbound>) => {
  const data = ev.data;
  if (!data || typeof data !== "object" || !("type" in data)) return;
  if (data.type === "init") {
    pendingConfig = data.config;
    return;
  }
  if (data.type === "open") {
    if (!pendingConfig) {
      send({ type: "error", message: "picker not initialized" });
      return;
    }
    if (!gapiReady || !gsiReady) {
      send({ type: "error", message: "picker scripts not loaded yet" });
      return;
    }
    void requestTokenAndOpen(pendingConfig);
  }
});

async function requestTokenAndOpen(cfg: PickerInitConfig): Promise<void> {
  setStatus("Requesting Google access token…");
  const oauth = window.google!.accounts.oauth2;
  const tokenClient = oauth.initTokenClient({
    client_id: cfg.clientId,
    scope: "https://www.googleapis.com/auth/drive.file",
    callback: (resp) => {
      if (resp.error || !resp.access_token) {
        const msg = `Google sign-in failed: ${resp.error ?? "no token"}`;
        setStatus(msg, "error");
        send({ type: "error", message: msg });
        return;
      }
      showPicker(cfg, resp.access_token);
    },
  });
  tokenClient.requestAccessToken({ prompt: "" });
}

function showPicker(cfg: PickerInitConfig, oauthToken: string): void {
  setStatus("Opening Picker…");
  const picker = window.google!.picker;
  const view = new picker.DocsView(picker.ViewId.DOCUMENTS)
    .setMimeTypes("application/vnd.google-apps.document")
    .setOwnedByMe(true)
    .setMode(picker.DocsViewMode.LIST);
  if (cfg.suggestedTitle) view.setQuery(cfg.suggestedTitle);

  const built = new picker.PickerBuilder()
    .setOAuthToken(oauthToken)
    .setDeveloperKey(cfg.apiKey)
    .setAppId(cfg.projectNumber)
    .addView(view)
    .setTitle("Pick a Doc to track with Docket")
    .setCallback((data) => onPicked(data))
    .build();
  built.setVisible(true);
}

function onPicked(data: PickerCallbackData): void {
  const picker = window.google!.picker;
  if (data.action === picker.Action.CANCEL) {
    setStatus("Cancelled.");
    send({ type: "cancelled" });
    return;
  }
  if (data.action !== picker.Action.PICKED) return;
  const doc = (data.docs ?? [])[0];
  if (!doc?.id) {
    setStatus("No doc selected.", "error");
    send({ type: "error", message: "no doc selected" });
    return;
  }
  setStatus("Registering with Docket…");
  send({ type: "picked", docId: doc.id, name: doc.name });
}
