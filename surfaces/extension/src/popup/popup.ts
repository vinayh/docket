import { ext } from "../shared/browser.ts";
import type { Message, MessageResponse } from "../shared/messages.ts";

const conn = document.getElementById("connection") as HTMLParagraphElement;
const queue = document.getElementById("queue") as HTMLElement;
const lastError = document.getElementById("last-error") as HTMLElement;
const flushBtn = document.getElementById("flush") as HTMLButtonElement;
const openOptions = document.getElementById("open-options") as HTMLButtonElement;

void refresh();

flushBtn.addEventListener("click", async () => {
  flushBtn.disabled = true;
  try {
    await ext.runtime.sendMessage({ kind: "queue/flush" } satisfies Message);
    await refresh();
  } finally {
    flushBtn.disabled = false;
  }
});

openOptions.addEventListener("click", () => {
  ext.runtime.openOptionsPage();
});

async function refresh(): Promise<void> {
  const settings = (await ext.runtime.sendMessage({
    kind: "settings/get",
  } satisfies Message)) as MessageResponse | undefined;

  if (settings?.kind === "settings/get" && settings.settings) {
    conn.textContent = `Connected to ${settings.settings.backendUrl}`;
    conn.dataset.tone = "ok";
  } else {
    conn.textContent = "No backend configured — open Options.";
    conn.dataset.tone = "error";
  }

  const peek = (await ext.runtime.sendMessage({
    kind: "queue/peek",
  } satisfies Message)) as MessageResponse | undefined;
  if (peek?.kind === "queue/peek") {
    queue.textContent = String(peek.queueSize);
    lastError.textContent = peek.lastError ?? "—";
  }
}
