import { useEffect, useState } from "preact/hooks";
import { getSettings } from "../../ui/sendMessage.ts";

/**
 * Bottom-of-popup diagnostics. Pre-docx-ingest this also showed the SW
 * capture queue size and a manual "flush queue now" button; the capture
 * pipeline is gone, so this is just a `/healthz` reachability probe.
 */
interface Props {
  initiallyOpen: boolean;
}

type Connection =
  | { tone: ""; text: string }
  | { tone: "ok" | "error"; text: string };

export function Diagnostics({ initiallyOpen }: Props) {
  const [conn, setConn] = useState<Connection>({ tone: "", text: "checking…" });

  useEffect(() => {
    void (async () => {
      const settings = await getSettings();
      if (!settings) {
        setConn({ tone: "error", text: "No backend configured." });
        return;
      }
      setConn({ tone: "", text: `Probing ${settings.backendUrl}…` });
      await probeBackend(settings.backendUrl, setConn);
    })();
  }, []);

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
