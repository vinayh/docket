import { browser } from "wxt/browser";
import { detectAndPersistBrowserQuirks } from "../../utils/browser-detect.ts";
import type { Message, MessageResponse } from "../../utils/messages.ts";
import { DEFAULT_BACKEND_URL, type ProjectListEntry } from "../../utils/types.ts";

// Detect native-sidebar support (rules out Arc and other Chromium derivatives
// that silently no-op `chrome.sidePanel`). Result is cached in
// chrome.storage.local; the SW reads it sync at action-click time.
void detectAndPersistBrowserQuirks();

const signedOutEl = document.getElementById("signedOut") as HTMLElement;
const signedInEl = document.getElementById("signedIn") as HTMLElement;
const signInBtn = document.getElementById("signIn") as HTMLButtonElement;
const signOutBtn = document.getElementById("signOut") as HTMLButtonElement;
const avatarEl = document.getElementById("avatar") as HTMLImageElement;
const accountNameEl = document.getElementById("accountName") as HTMLElement;
const accountEmailEl = document.getElementById("accountEmail") as HTMLElement;
const docListEl = document.getElementById("docList") as HTMLUListElement;
const docsCountEl = document.getElementById("docsCount") as HTMLElement;
const docsEmptyEl = document.getElementById("docsEmpty") as HTMLElement;
const status = document.getElementById("status") as HTMLParagraphElement;
const devBanner = document.getElementById("devBanner") as HTMLElement;
const devBackendEl = document.getElementById("devBackend") as HTMLElement;
const extensionVersionEl = document.getElementById("extensionVersion") as HTMLElement;

extensionVersionEl.textContent = `v${browser.runtime.getManifest().version}`;

// Dev-only badge so the developer can see which backend the extension is
// hitting. Vite tree-shakes this whole block out of prod bundles.
if (import.meta.env.DEV) {
  devBanner.hidden = false;
  devBackendEl.textContent = DEFAULT_BACKEND_URL;
}

void hydrate();

async function hydrate(): Promise<void> {
  const r = (await browser.runtime.sendMessage({ kind: "settings/get" } satisfies Message)) as
    | MessageResponse
    | undefined;
  const signedIn =
    r?.kind === "settings/get" ? Boolean(r.settings?.sessionToken) : false;
  await renderAuthState(signedIn);
}

async function renderAuthState(signedIn: boolean): Promise<void> {
  signedOutEl.hidden = signedIn;
  signedInEl.hidden = !signedIn;
  if (!signedIn) return;
  // Fire both calls in parallel; both are decoration on top of the
  // already-rendered signed-in shell. Failures leave placeholders in place.
  await Promise.all([fillIdentity(), fillDocs()]);
}

async function fillIdentity(): Promise<void> {
  const r = (await browser.runtime.sendMessage({ kind: "auth/whoami" } satisfies Message)) as
    | MessageResponse
    | undefined;
  if (r?.kind !== "auth/whoami") return;
  if (r.image) {
    avatarEl.src = r.image;
    avatarEl.alt = r.name ?? r.email ?? "";
  } else {
    avatarEl.removeAttribute("src");
    avatarEl.alt = "";
  }
  accountNameEl.textContent = r.name ?? "Signed in";
  accountEmailEl.textContent = r.email ?? "";
}

async function fillDocs(): Promise<void> {
  const r = (await browser.runtime.sendMessage({ kind: "projects/list" } satisfies Message)) as
    | MessageResponse
    | undefined;
  if (r?.kind !== "projects/list" || !r.projects) return;
  // Most recently active first; never-synced trailing.
  const sorted = [...r.projects].sort((a, b) => {
    const av = a.lastSyncedAt ?? -1;
    const bv = b.lastSyncedAt ?? -1;
    return bv - av;
  });
  docsCountEl.textContent = sorted.length === 0 ? "" : String(sorted.length);
  docsEmptyEl.hidden = sorted.length > 0;
  docListEl.replaceChildren(...sorted.map(renderDocRow));
}

function renderDocRow(p: ProjectListEntry): HTMLLIElement {
  const li = document.createElement("li");
  li.className =
    "flex items-baseline justify-between gap-3 px-[0.7rem] py-[0.55rem] border border-rule rounded bg-cream";

  const link = document.createElement("a");
  link.href = `https://docs.google.com/document/d/${encodeURIComponent(p.parentDocId)}/edit`;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.className = "font-medium [overflow-wrap:anywhere]";
  link.textContent = p.name ?? "Untitled doc";

  const meta = document.createElement("span");
  meta.className = "text-muted font-mono text-[11px] whitespace-nowrap";
  const versionLabel =
    p.versionCount === 1 ? "1 version" : `${p.versionCount} versions`;
  const synced = formatRelative(p.lastSyncedAt);
  meta.textContent = `${versionLabel} · last sync ${synced}`;

  li.append(link, meta);
  return li;
}

function formatRelative(ts: number | null): string {
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

signInBtn.addEventListener("click", async () => {
  const perm = await ensureBackendOrigin(DEFAULT_BACKEND_URL);
  if (!perm.ok) {
    setStatus(perm.reason, "error");
    return;
  }
  setStatus("Opening Google sign-in in a new tab…", null);
  const launchUrl = `${DEFAULT_BACKEND_URL}/api/auth/ext/launch-tab?ext=${encodeURIComponent(
    browser.runtime.id,
  )}`;
  await browser.tabs.create({ url: launchUrl });
});

// React to the SW's `auth/token` write so the Options page flips to
// signed-in without the user reloading the tab.
browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.settings) return;
  const after =
    (changes.settings.newValue as { sessionToken?: string } | undefined)
      ?.sessionToken ?? "";
  const before =
    (changes.settings.oldValue as { sessionToken?: string } | undefined)
      ?.sessionToken ?? "";
  if (before === after) return;
  void renderAuthState(Boolean(after));
  if (after) setStatus("Signed in.", "ok");
});

signOutBtn.addEventListener("click", async () => {
  const r = (await browser.runtime.sendMessage({
    kind: "auth/sign-out",
  } satisfies Message)) as MessageResponse | undefined;
  if (r?.kind === "auth/sign-out" && r.ok) {
    setStatus("Signed out.", "ok");
    void renderAuthState(false);
  } else {
    setStatus(r?.error ?? "sign-out failed", "error");
  }
});

// MV3 only allows fetch to origins listed in host_permissions or granted at
// runtime. The backend URL is baked in at build time but not declared
// statically — request the specific origin from this user gesture.
async function ensureBackendOrigin(
  rawUrl: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let pattern: string;
  try {
    const u = new URL(rawUrl);
    pattern = `${u.protocol}//${u.host}/*`;
  } catch {
    return { ok: false, reason: "invalid backend URL" };
  }
  const has = await browser.permissions.contains({ origins: [pattern] });
  if (has) return { ok: true };
  const granted = await browser.permissions.request({ origins: [pattern] });
  if (!granted) return { ok: false, reason: `permission denied for ${pattern}` };
  return { ok: true };
}

function setStatus(message: string, tone: "ok" | "error" | null): void {
  status.textContent = message;
  const toneClass =
    tone === "error" ? "text-bad" : tone === "ok" ? "text-good" : "text-ink";
  status.className = `min-h-[1.4em] mt-4 mb-0 font-semibold ${toneClass}`;
}
