import { tokenProviderForUser } from "../auth/credentials.ts";
import { getDocument, type Document, type TextRun } from "../google/docs.ts";
import { loadOwnedVersion } from "./version.ts";

// Pre-summarized payload for the side-panel structured diff (frontend runs a two-pass jsdiff).
export interface VersionDiffPayload {
  from: VersionSide;
  to: VersionSide;
}

export interface VersionSide {
  versionId: string;
  label: string;
  googleDocId: string;
  paragraphs: ParagraphSummary[];
}

export interface ParagraphSummary {
  // Plaintext with trailing newline stripped.
  plaintext: string;
  // e.g. NORMAL_TEXT / HEADING_1 / TITLE. Catches heading changes pure-text diff would miss.
  namedStyleType: string | null;
  // Style-flagged runs in order so inline bold/italic survives the diff. null style = default.
  runs: RunSummary[];
}

export interface RunSummary {
  content: string;
  style: TextStyleSummary | null;
}

// Curated subset of TextStyle. Don't dump raw textStyle — it carries opaque shapes we can't render.
export interface TextStyleSummary {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontFamily?: string;
  fontSizePt?: number;
  foregroundColorHex?: string;
}

export async function getVersionDiffPayload(opts: {
  fromVersionId: string;
  toVersionId: string;
  userId: string;
}): Promise<VersionDiffPayload | null> {
  const from = await loadOwnedVersion(opts.fromVersionId, opts.userId);
  const to = await loadOwnedVersion(opts.toVersionId, opts.userId);
  if (!from || !to) return null;
  // Refuse cross-project diffs — they'd let a caller probe for the existence of unrelated versions.
  if (from.projectId !== to.projectId) return null;

  const tp = tokenProviderForUser(opts.userId);
  const [fromDoc, toDoc] = await Promise.all([
    getDocument(tp, from.googleDocId),
    getDocument(tp, to.googleDocId),
  ]);

  return {
    from: {
      versionId: from.id,
      label: from.label,
      googleDocId: from.googleDocId,
      paragraphs: summarizeDocument(fromDoc),
    },
    to: {
      versionId: to.id,
      label: to.label,
      googleDocId: to.googleDocId,
      paragraphs: summarizeDocument(toDoc),
    },
  };
}

// v1 skips tables / section breaks / TOC / headers / footers / footnotes — emit body paragraphs only.
export function summarizeDocument(doc: Document): ParagraphSummary[] {
  const out: ParagraphSummary[] = [];
  for (const el of doc.body?.content ?? []) {
    if (!el.paragraph) continue;
    out.push(summarizeParagraph(el.paragraph));
  }
  return out;
}

function summarizeParagraph(p: NonNullable<Document["body"]>["content"][number]["paragraph"]): ParagraphSummary {
  const runs: RunSummary[] = [];
  let plaintext = "";
  for (const pe of p?.elements ?? []) {
    if (!pe.textRun) continue;
    const content = pe.textRun.content ?? "";
    plaintext += content;
    runs.push({
      content,
      style: summarizeTextStyle(pe.textRun),
    });
  }
  // Docs paragraphs always end with a literal \n; strip it.
  if (plaintext.endsWith("\n")) plaintext = plaintext.slice(0, -1);

  const paraStyle = (p?.paragraphStyle ?? {}) as { namedStyleType?: unknown };
  const namedStyleType =
    typeof paraStyle.namedStyleType === "string" ? paraStyle.namedStyleType : null;

  return { plaintext, namedStyleType, runs };
}

function summarizeTextStyle(run: TextRun): TextStyleSummary | null {
  const ts = run.textStyle ?? {};
  const t = ts as Record<string, unknown>;
  const out: TextStyleSummary = {};

  if (t.bold === true) out.bold = true;
  if (t.italic === true) out.italic = true;
  if (t.underline === true) out.underline = true;
  if (t.strikethrough === true) out.strikethrough = true;

  const wff = (t.weightedFontFamily ?? {}) as { fontFamily?: unknown };
  if (typeof wff.fontFamily === "string") out.fontFamily = wff.fontFamily;

  const fs = (t.fontSize ?? {}) as { magnitude?: unknown; unit?: unknown };
  if (typeof fs.magnitude === "number") out.fontSizePt = fs.magnitude;

  const fc = (t.foregroundColor ?? {}) as {
    color?: { rgbColor?: { red?: unknown; green?: unknown; blue?: unknown } };
  };
  const rgb = fc.color?.rgbColor;
  if (rgb) {
    out.foregroundColorHex = rgbToHex(rgb.red, rgb.green, rgb.blue);
  }

  return Object.keys(out).length === 0 ? null : out;
}

function rgbToHex(r?: unknown, g?: unknown, b?: unknown): string {
  const to255 = (v: unknown): number =>
    typeof v === "number" ? Math.max(0, Math.min(255, Math.round(v * 255))) : 0;
  const hex = (n: number): string => n.toString(16).padStart(2, "0");
  return `#${hex(to255(r))}${hex(to255(g))}${hex(to255(b))}`;
}
