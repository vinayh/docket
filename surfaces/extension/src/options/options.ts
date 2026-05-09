import { ext } from "../shared/browser.ts";
import type { Message, MessageResponse } from "../shared/messages.ts";
import { DEFAULT_BACKEND_URL, type Settings } from "../shared/types.ts";

const form = document.getElementById("form") as HTMLFormElement;
const backendUrl = document.getElementById("backendUrl") as HTMLInputElement;
const apiToken = document.getElementById("apiToken") as HTMLInputElement;
const testBtn = document.getElementById("test") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLParagraphElement;

void hydrate();

async function hydrate(): Promise<void> {
  const r = (await ext.runtime.sendMessage({ kind: "settings/get" } satisfies Message)) as
    | MessageResponse
    | undefined;
  if (r?.kind === "settings/get" && r.settings) {
    backendUrl.value = r.settings.backendUrl;
    apiToken.value = r.settings.apiToken;
  } else {
    backendUrl.value = DEFAULT_BACKEND_URL;
  }
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const settings: Settings = {
    backendUrl: backendUrl.value.trim().replace(/\/+$/, ""),
    apiToken: apiToken.value.trim(),
  };
  if (!settings.backendUrl || !settings.apiToken) {
    setStatus("Both fields are required", "error");
    return;
  }
  await ext.runtime.sendMessage({ kind: "settings/set", settings } satisfies Message);
  setStatus("Saved.", "ok");
});

testBtn.addEventListener("click", async () => {
  const url = backendUrl.value.trim().replace(/\/+$/, "");
  if (!url) {
    setStatus("Enter a backend URL first", "error");
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

function setStatus(message: string, tone: "ok" | "error" | null): void {
  status.textContent = message;
  if (tone) status.dataset.tone = tone;
  else delete status.dataset.tone;
}
