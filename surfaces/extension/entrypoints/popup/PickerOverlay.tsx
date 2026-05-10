import { useEffect, useRef, useState } from "preact/hooks";
import type { PickerConfig } from "../../utils/types.ts";
import type { ActiveDocTab } from "./Popup.tsx";

/**
 * Owns the sandboxed Picker iframe + the postMessage handshake. Replaces
 * the module-level `pickerReadyResolver` / `pickerReadyState` /
 * `pickerCurrentTab` triplet in the old popup.ts.
 *
 * Sequence:
 *   1. Mount → wire `message` listener → set iframe `src` so the sandbox
 *      loads (gapi + gsi scripts start fetching there).
 *   2. iframe `load` → post `init` with PickerConfig + suggested doc.
 *   3. sandbox sends `ready` once gapi + gsi finish loading → post `open`.
 *   4. sandbox sends `picked` / `cancelled` / `error` → bubble up to
 *      Popup via the callbacks.
 *
 * Firefox MV3 has no `sandbox.pages` support, so the popup never
 * transitions to this view there — see Popup.tsx → startAddFlow.
 */

interface PickerInbound {
  type: "ready" | "picked" | "cancelled" | "error";
  docId?: string;
  name?: string;
  message?: string;
}

interface Props {
  tab: ActiveDocTab;
  cfg: PickerConfig;
  onPicked: (docId: string, name: string) => void;
  onCancelled: () => void;
  onError: (message: string) => void;
}

export function PickerOverlay({
  tab,
  cfg,
  onPicked,
  onCancelled,
  onError,
}: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState("Loading Picker…");

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    // `active` guards against late messages firing after we've already
    // resolved/cancelled. React-style effect cleanup is the canonical way
    // to express "ignore further inbound" for an async pipeline like this.
    let active = true;

    function post(msg: unknown): void {
      frame!.contentWindow?.postMessage(msg, "*");
    }

    function onMessage(ev: MessageEvent<PickerInbound>) {
      if (!active) return;
      if (ev.source !== frame!.contentWindow) return;
      const data = ev.data;
      if (!data || typeof data !== "object" || !("type" in data)) return;
      switch (data.type) {
        case "ready":
          setStatus("Opening Picker…");
          post({ type: "open" });
          return;
        case "picked":
          if (data.docId) onPicked(data.docId, data.name ?? "");
          return;
        case "cancelled":
          setStatus("Cancelled.");
          onCancelled();
          return;
        case "error":
          onError(data.message ?? "Picker error");
          return;
      }
    }
    window.addEventListener("message", onMessage);

    function onLoad(): void {
      // Two-phase: wait for the iframe to load (so the sandbox's `message`
      // listener is installed), then post `init`. The sandbox stashes
      // the config and replies `ready` once gapi + gsi finish loading.
      post({
        type: "init",
        config: {
          ...cfg,
          suggestedDocId: tab.docId,
          suggestedTitle: tab.title || undefined,
        },
      });
    }
    frame.addEventListener("load", onLoad, { once: true });
    // Set src last so the load event fires after listeners are wired.
    frame.src = "picker-sandbox.html";

    return () => {
      active = false;
      window.removeEventListener("message", onMessage);
    };
  }, [tab.docId, tab.title, cfg]);

  return (
    <>
      <p class="title" title={tab.title || "Google Doc"}>
        {tab.title || "Google Doc"}
      </p>
      <p id="picker-status" class="muted">
        {status}
      </p>
      <iframe ref={frameRef} id="picker-frame" title="Drive Picker" />
    </>
  );
}
