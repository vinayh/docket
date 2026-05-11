import { useEffect, useState } from "preact/hooks";
import { getSettings, sendMessage } from "../../ui/sendMessage.ts";

/**
 * The diagnostics panel folded into a <details> at the bottom of the popup.
 * Probes the backend's `/healthz` and asks the SW for queue size / last
 * error. Refreshes once on mount; the popup re-mounts on every open so
 * there's no need for a polling loop.
 */
interface Props {
  initiallyOpen: boolean;
}

type Connection =
  | { tone: ""; text: string }
  | { tone: "ok" | "error"; text: string };

export function Diagnostics({ initiallyOpen }: Props) {
  const [conn, setConn] = useState<Connection>({ tone: "", text: "checking…" });
  const [queueSize, setQueueSize] = useState<string>("—");
  const [lastError, setLastError] = useState<string>("—");
  const [flushing, setFlushing] = useState(false);

  async function refresh() {
    const settings = await getSettings();
    if (!settings) {
      setConn({ tone: "error", text: "No backend configured." });
    } else {
      setConn({ tone: "", text: `Probing ${settings.backendUrl}…` });
      void probeBackend(settings.backendUrl, setConn);
    }
    const peek = await sendMessage({ kind: "queue/peek" });
    if (peek?.kind === "queue/peek") {
      setQueueSize(String(peek.queueSize));
      setLastError(peek.lastError ?? "—");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function onFlush() {
    setFlushing(true);
    try {
      await sendMessage({ kind: "queue/flush" });
      await refresh();
    } finally {
      setFlushing(false);
    }
  }

  return (
    <details id="diagnostics" open={initiallyOpen}>
      <summary>Diagnostics</summary>
      <p
        id="connection"
        class="muted"
        data-tone={conn.tone || undefined}
      >
        {conn.text}
      </p>
      <dl>
        <dt>Queued captures</dt>
        <dd id="queue">{queueSize}</dd>
        <dt>Last error</dt>
        <dd id="last-error">{lastError}</dd>
      </dl>
      <button
        id="flush"
        type="button"
        disabled={flushing}
        onClick={() => void onFlush()}
      >
        Flush queue now
      </button>
    </details>
  );
}

async function probeBackend(
  backendUrl: string,
  setConn: (c: Connection) => void,
): Promise<void> {
  const url = new URL("/healthz", backendUrl).toString();
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      setConn({ tone: "error", text: `Backend ${backendUrl} responded ${res.status}` });
      return;
    }
    const json = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    if (!json?.ok) {
      setConn({
        tone: "error",
        text: `Backend ${backendUrl} reachable but /healthz did not return ok`,
      });
      return;
    }
    setConn({ tone: "ok", text: `Connected to ${backendUrl}` });
  } catch (err) {
    setConn({
      tone: "error",
      text: `Backend ${backendUrl} unreachable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}
