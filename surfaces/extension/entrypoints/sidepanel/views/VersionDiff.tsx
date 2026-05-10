import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Change } from "diff";
import { sendMessage } from "../../../ui/sendMessage.ts";
import type {
  ParagraphSummary,
  RunSummary,
  VersionDiffPayload,
} from "../../../utils/types.ts";
import { alignParagraphs, type DiffRow } from "../diff/align.ts";

interface Props {
  fromVersionId: string;
  toVersionId: string;
  onClose: () => void;
}

type State =
  | { kind: "loading" }
  | { kind: "loaded"; payload: VersionDiffPayload; rows: DiffRow[] }
  | { kind: "error"; message: string };

export function VersionDiff({ fromVersionId, toVersionId, onClose }: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await sendMessage({
          kind: "version/diff",
          fromVersionId,
          toVersionId,
        });
        if (cancelled) return;
        if (r?.kind !== "version/diff") {
          setState({ kind: "error", message: "unexpected response" });
          return;
        }
        if (r.error) {
          setState({ kind: "error", message: r.error });
          return;
        }
        if (!r.payload) {
          setState({ kind: "error", message: "diff payload unavailable" });
          return;
        }
        const rows = alignParagraphs(r.payload.from.paragraphs, r.payload.to.paragraphs);
        setState({ kind: "loaded", payload: r.payload, rows });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fromVersionId, toVersionId]);

  if (state.kind === "loading") {
    return (
      <section class="diff-view">
        <DiffHeader title="Loading diff…" onClose={onClose} />
        <p class="muted">Fetching document content…</p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section class="diff-view">
        <DiffHeader title="Diff" onClose={onClose} />
        <p class="muted error">{state.message}</p>
      </section>
    );
  }

  const { payload, rows } = state;
  const summary = summarize(rows);
  return (
    <section class="diff-view">
      <DiffHeader
        title={`Diff: ${payload.from.label} → ${payload.to.label}`}
        onClose={onClose}
      />
      <p class="muted">
        {summary.modified} modified · {summary.added} added · {summary.removed} removed
        {summary.styleChanged > 0 ? ` · ${summary.styleChanged} style only` : ""}
      </p>
      <DiffTable rows={rows} />
    </section>
  );
}

function DiffHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div class="diff-header">
      <p class="title">{title}</p>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

function DiffTable({ rows }: { rows: DiffRow[] }) {
  return (
    <table class="diff-table">
      <thead>
        <tr>
          <th scope="col">Before</th>
          <th scope="col">After</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <DiffRowView key={i} row={row} />
        ))}
      </tbody>
    </table>
  );
}

function DiffRowView({ row }: { row: DiffRow }) {
  switch (row.kind) {
    case "match":
      return (
        <tr class="diff-row diff-match">
          <td>
            <Paragraph p={row.from} />
          </td>
          <td>
            <Paragraph p={row.to} />
          </td>
        </tr>
      );
    case "style-changed":
      return (
        <tr class="diff-row diff-style">
          <td>
            <Paragraph p={row.from} />
          </td>
          <td>
            <Paragraph p={row.to} />
            <span class="diff-tag">style changed</span>
          </td>
        </tr>
      );
    case "modified":
      return (
        <tr class="diff-row diff-modified">
          <td>
            <Paragraph p={row.from}>
              <WordDiff words={row.words} side="from" />
            </Paragraph>
          </td>
          <td>
            <Paragraph p={row.to}>
              <WordDiff words={row.words} side="to" />
            </Paragraph>
          </td>
        </tr>
      );
    case "added":
      return (
        <tr class="diff-row diff-added">
          <td />
          <td>
            <Paragraph p={row.to} />
          </td>
        </tr>
      );
    case "removed":
      return (
        <tr class="diff-row diff-removed">
          <td>
            <Paragraph p={row.from} />
          </td>
          <td />
        </tr>
      );
  }
}

function Paragraph({
  p,
  children,
}: {
  p: ParagraphSummary;
  children?: ComponentChildren;
}) {
  const heading = p.namedStyleType;
  const headingTag =
    heading === "TITLE" || heading === "HEADING_1"
      ? "h1"
      : heading === "HEADING_2"
        ? "h2"
        : heading === "HEADING_3"
          ? "h3"
          : null;
  // If a heading-tag mapping applies, render the children/runs inside it
  // so the visual prominence matches the doc structure.
  const body = children ? children : <Runs runs={p.runs} />;
  if (!headingTag) return <p class="diff-para">{body}</p>;
  if (headingTag === "h1") return <h1 class="diff-para">{body}</h1>;
  if (headingTag === "h2") return <h2 class="diff-para">{body}</h2>;
  return <h3 class="diff-para">{body}</h3>;
}

function Runs({ runs }: { runs: RunSummary[] }) {
  return (
    <>
      {runs.map((r, i) => (
        <RunSpan key={i} run={r} />
      ))}
    </>
  );
}

function RunSpan({ run }: { run: RunSummary }) {
  const s = run.style;
  const style: Record<string, string> = {};
  if (s?.fontFamily) style.fontFamily = s.fontFamily;
  if (s?.fontSizePt) style.fontSize = `${s.fontSizePt}pt`;
  if (s?.foregroundColorHex) style.color = s.foregroundColorHex;
  if (s?.bold) style.fontWeight = "bold";
  if (s?.italic) style.fontStyle = "italic";
  if (s?.underline && s?.strikethrough)
    style.textDecoration = "underline line-through";
  else if (s?.underline) style.textDecoration = "underline";
  else if (s?.strikethrough) style.textDecoration = "line-through";
  return <span style={style}>{stripParaNewline(run.content)}</span>;
}

function WordDiff({
  words,
  side,
}: {
  words: Change[];
  side: "from" | "to";
}) {
  // For the from-side, skip "added" spans and tag "removed" spans red.
  // For the to-side, skip "removed" spans and tag "added" spans green.
  return (
    <>
      {words.map((w, i) => {
        if (w.added) {
          if (side === "from") return null;
          return (
            <span key={i} class="diff-word diff-word-add">
              {w.value}
            </span>
          );
        }
        if (w.removed) {
          if (side === "to") return null;
          return (
            <span key={i} class="diff-word diff-word-del">
              {w.value}
            </span>
          );
        }
        return <span key={i}>{w.value}</span>;
      })}
    </>
  );
}

function summarize(rows: DiffRow[]): {
  modified: number;
  added: number;
  removed: number;
  styleChanged: number;
  matched: number;
} {
  let modified = 0;
  let added = 0;
  let removed = 0;
  let styleChanged = 0;
  let matched = 0;
  for (const r of rows) {
    if (r.kind === "modified") modified++;
    else if (r.kind === "added") added++;
    else if (r.kind === "removed") removed++;
    else if (r.kind === "style-changed") styleChanged++;
    else matched++;
  }
  return { modified, added, removed, styleChanged, matched };
}

function stripParaNewline(s: string): string {
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}
