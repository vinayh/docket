import { useEffect, useState } from "preact/hooks";
import { getSettingsStatus } from "../../ui/sendMessage.ts";

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
      const { backendUrl } = await getSettingsStatus();
      if (!backendUrl) {
        setConn({ tone: "error", text: "No backend configured." });
        return;
      }
      const label = import.meta.env.DEV ? backendUrl : "backend";
      setConn({ tone: "", text: `Probing ${label}…` });
      await probeBackend(backendUrl, setConn);
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
  // Prod hides the URL — it's an implementation detail. Dev keeps it
  // visible so the developer can spot a localhost/prod mixup.
  const label = import.meta.env.DEV ? backendUrl : "backend";
  const url = new URL("/healthz", backendUrl).toString();
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      setConn({ tone: "error", text: `${capitalize(label)} responded ${res.status}` });
      return;
    }
    const json = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    if (!json?.ok) {
      setConn({
        tone: "error",
        text: `${capitalize(label)} reachable but /healthz did not return ok`,
      });
      return;
    }
    setConn({ tone: "ok", text: `Connected to ${label}` });
  } catch (err) {
    setConn({
      tone: "error",
      text: `${capitalize(label)} unreachable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
