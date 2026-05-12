import { browser } from "wxt/browser";
import type { Message, MessageResponse } from "../../utils/messages.ts";
import { DEFAULT_BACKEND_URL } from "../../utils/types.ts";

const form = document.getElementById("form") as HTMLFormElement;
const backendUrlInput = document.getElementById("backendUrl") as HTMLInputElement;
const testBtn = document.getElementById("test") as HTMLButtonElement;
const signInBtn = document.getElementById("signIn") as HTMLButtonElement;
const signOutBtn = document.getElementById("signOut") as HTMLButtonElement;
const authStateEl = document.getElementById("authState") as HTMLParagraphElement;
const status = document.getElementById("status") as HTMLParagraphElement;

void hydrate();

async function hydrate(): Promise<void> {
  const r = (await browser.runtime.sendMessage({ kind: "settings/get" } satisfies Message)) as
    | MessageResponse
    | undefined;
  if (r?.kind === "settings/get" && r.settings) {
    backendUrlInput.value = r.settings.backendUrl;
    renderAuthState(Boolean(r.settings.sessionToken));
  } else {
    backendUrlInput.value = DEFAULT_BACKEND_URL;
    renderAuthState(false);
  }
}

function renderAuthState(signedIn: boolean): void {
  if (signedIn) {
    authStateEl.textContent = "Signed in. Backend session is active.";
    signInBtn.hidden = true;
    signOutBtn.hidden = false;
  } else {
    authStateEl.textContent = "Not signed in.";
    signInBtn.hidden = false;
    signOutBtn.hidden = true;
  }
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const backendUrl = backendUrlInput.value.trim().replace(/\/+$/, "");
  if (!backendUrl) {
    setStatus("Backend URL is required", "error");
    return;
  }
  const perm = await ensureBackendOrigin(backendUrl);
  if (!perm.ok) {
    setStatus(`Saved URL, but ${perm.reason}.`, "error");
  } else {
    setStatus("Backend URL saved.", "ok");
  }
  // Preserve existing sessionToken (if any) so signing in earlier is sticky.
  const existing = (await browser.runtime.sendMessage({
    kind: "settings/get",
  } satisfies Message)) as MessageResponse | undefined;
  const sessionToken =
    existing?.kind === "settings/get" ? existing.settings?.sessionToken ?? "" : "";
  await browser.runtime.sendMessage({
    kind: "settings/set",
    settings: { backendUrl, sessionToken },
  } satisfies Message);
});

testBtn.addEventListener("click", async () => {
  const url = backendUrlInput.value.trim().replace(/\/+$/, "");
  if (!url) {
    setStatus("Enter a backend URL first", "error");
    return;
  }
  const perm = await ensureBackendOrigin(url);
  if (!perm.ok) {
    setStatus(perm.reason, "error");
    return;
  }
  setStatus("Testing…", null);
  try {
    const res = await fetch(new URL("/healthz", url).toString(), { method: "GET" });
    if (!res.ok) {
      setStatus(`Backend responded ${res.status}`, "error");
      return;
    }
    const json = (await res.json()) as { ok?: boolean };
    if (json.ok) setStatus("Backend reachable.", "ok");
    else setStatus("Reached backend but /healthz did not return ok", "error");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  }
});

signInBtn.addEventListener("click", async () => {
  const backendUrl = backendUrlInput.value.trim().replace(/\/+$/, "");
  if (!backendUrl) {
    setStatus("Enter a backend URL first", "error");
    return;
  }
  const perm = await ensureBackendOrigin(backendUrl);
  if (!perm.ok) {
    setStatus(perm.reason, "error");
    return;
  }
  setStatus("Opening Google sign-in…", null);
  const r = (await browser.runtime.sendMessage({
    kind: "auth/sign-in",
    backendUrl,
  } satisfies Message)) as MessageResponse | undefined;
  if (r?.kind === "auth/sign-in" && r.ok) {
    setStatus("Signed in.", "ok");
    renderAuthState(true);
  } else {
    setStatus(r?.error ?? "sign-in failed", "error");
  }
});

signOutBtn.addEventListener("click", async () => {
  const r = (await browser.runtime.sendMessage({
    kind: "auth/sign-out",
  } satisfies Message)) as MessageResponse | undefined;
  if (r?.kind === "auth/sign-out" && r.ok) {
    setStatus("Signed out.", "ok");
    renderAuthState(false);
  } else {
    setStatus(r?.error ?? "sign-out failed", "error");
  }
});

// MV3 only allows fetch to origins listed in host_permissions or granted at
// runtime. The user-configured backend isn't known at build time, so we
// declare optional_host_permissions: ["<all_urls>"] in the manifest and
// request the specific origin here. permissions.request must run from a
// user gesture (button click) — every call site above is one.
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
  if (tone) status.dataset.tone = tone;
  else delete status.dataset.tone;
}
