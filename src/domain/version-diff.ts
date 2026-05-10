import { eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { project, version } from "../db/schema.ts";
import { tokenProviderForUser } from "../auth/credentials.ts";
import { getDocument, type Document, type TextRun } from "../google/docs.ts";

/**
 * Side-panel "structured diff" payload (SPEC §12 Phase 4). The frontend
 * pulls this for two version ids and runs a two-pass jsdiff locally
 * (paragraph alignment → intra-paragraph word diff).
 *
 * We pre-summarize on the backend so the wire format stays small: a raw
 * `documents.get` response can be megabytes (style maps, lists, named
 * ranges) but the diff renderer only needs paragraph text + a tight subset
 * of style flags. If the renderer grows new visual concerns (lists,
 * tables, named styles beyond `namedStyleType`), extend
 * `summarizeDocument` rather than shipping more raw JSON.
 */
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
  /** Concatenated text-run content for the paragraph, trailing `\n` stripped. */
  plaintext: string;
  /**
   * `namedStyleType` from the paragraph style, e.g. `NORMAL_TEXT`,
   * `HEADING_1`, `TITLE`. Captures heading-level changes that pure-text
   * diff would miss.
   */
  namedStyleType: string | null;
  /**
   * Style-flagged text runs preserving order. Used by intra-paragraph
   * rendering so inline bold/italic survives the diff. Null `style`
   * means "default styling, no flags set."
   */
  runs: RunSummary[];
}

export interface RunSummary {
  content: string;
  style: TextStyleSummary | null;
}

/**
 * The subset of `TextStyle` we surface in the diff renderer. Adding more
 * fields is cheap on the wire — what we don't want is to dump the raw
 * `textStyle` map, which carries opaque link / font / weighted-font /
 * background-color shapes that are awkward to compare and render.
 */
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
  // Both versions must belong to the same project. Cross-project diffs
  // would technically work but they're outside the dashboard's mental
  // model (the panel is project-scoped) and let a caller probe for the
  // existence of an unrelated version. Refuse them.
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

interface OwnedVersion {
  id: string;
  projectId: string;
  googleDocId: string;
  label: string;
}

async function loadOwnedVersion(
  versionId: string,
  userId: string,
): Promise<OwnedVersion | null> {
  const rows = await db
    .select({
      id: version.id,
      projectId: version.projectId,
      googleDocId: version.googleDocId,
      label: version.label,
      ownerUserId: project.ownerUserId,
    })
    .from(version)
    .innerJoin(project, eq(project.id, version.projectId))
    .where(eq(version.id, versionId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.ownerUserId !== userId) return null;
  return {
    id: row.id,
    projectId: row.projectId,
    googleDocId: row.googleDocId,
    label: row.label,
  };
}

/**
 * Walk the body's structural elements and emit one `ParagraphSummary` per
 * paragraph. Tables / section breaks / table-of-contents nodes are skipped
 * in v1 — the diff renderer doesn't yet have a table view, and surfacing
 * an empty placeholder paragraph would muddy paragraph alignment.
 * Headers/footers/footnotes are also out of scope for v1.
 */
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
  // Docs paragraphs always end in a literal `\n`; the diff renderer
  // works in paragraph terms, so the trailing newline is noise.
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
