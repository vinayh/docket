import { authedJson, type TokenProvider } from "./api.ts";
import type { DocRegion } from "../db/schema.ts";

const DOCS_BASE = "https://docs.googleapis.com/v1";

export interface TextRun {
  content: string;
  textStyle?: Record<string, unknown>;
}

export interface ParagraphElement {
  startIndex?: number;
  endIndex?: number;
  textRun?: TextRun;
}

export interface Paragraph {
  elements?: ParagraphElement[];
  paragraphStyle?: Record<string, unknown>;
}

export interface StructuralElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: Paragraph;
  table?: Record<string, unknown>;
  sectionBreak?: Record<string, unknown>;
  tableOfContents?: Record<string, unknown>;
}

export interface Header {
  headerId?: string;
  content?: StructuralElement[];
}

export interface Footer {
  footerId?: string;
  content?: StructuralElement[];
}

export interface Footnote {
  footnoteId?: string;
  content?: StructuralElement[];
}

export interface Document {
  documentId: string;
  title: string;
  body?: { content: StructuralElement[] };
  headers?: Record<string, Header>;
  footers?: Record<string, Footer>;
  footnotes?: Record<string, Footnote>;
  revisionId?: string;
}

export async function getDocument(tp: TokenProvider, documentId: string): Promise<Document> {
  return authedJson(tp, `${DOCS_BASE}/documents/${encodeURIComponent(documentId)}`);
}

export async function createDocument(
  tp: TokenProvider,
  opts: { title: string },
): Promise<Document> {
  return authedJson(tp, `${DOCS_BASE}/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: opts.title }),
  });
}

export type BatchUpdateRequest = Record<string, unknown>;

export interface BatchUpdateResponse {
  documentId: string;
  replies?: unknown[];
  writeControl?: { requiredRevisionId?: string; targetRevisionId?: string };
}

export async function batchUpdate(
  tp: TokenProvider,
  documentId: string,
  requests: BatchUpdateRequest[],
  writeControl?: { requiredRevisionId?: string; targetRevisionId?: string },
): Promise<BatchUpdateResponse> {
  return authedJson(
    tp,
    `${DOCS_BASE}/documents/${encodeURIComponent(documentId)}:batchUpdate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests, writeControl }),
    },
  );
}

export const op = {
  insertText(text: string, index: number): BatchUpdateRequest {
    return { insertText: { text, location: { index } } };
  },
  deleteContentRange(startIndex: number, endIndex: number): BatchUpdateRequest {
    return { deleteContentRange: { range: { startIndex, endIndex } } };
  },
  replaceAllText(containsText: string, replaceText: string, matchCase = true): BatchUpdateRequest {
    return {
      replaceAllText: {
        containsText: { text: containsText, matchCase },
        replaceText,
      },
    };
  },
};

export function extractPlainText(doc: Document): string {
  let out = "";
  for (const el of doc.body?.content ?? []) {
    for (const pe of el.paragraph?.elements ?? []) {
      if (pe.textRun?.content) out += pe.textRun.content;
    }
  }
  return out;
}

export interface ParagraphText {
  /** Zero-based index among paragraph structural elements (skipping tables, section breaks, etc.). */
  paragraphIndex: number;
  /** Concatenated text-run content, with the trailing newline stripped. */
  text: string;
  /** Doc-coordinate startIndex of the structural element (for batchUpdate). */
  startIndex: number;
  /** Doc-coordinate endIndex of the structural element (exclusive). */
  endIndex: number;
}

export interface RegionParagraphText extends ParagraphText {
  region: DocRegion;
  /** Empty string for body. Header/footer/footnote id otherwise. */
  regionId: string;
}

/**
 * Walk the document body and return one entry per paragraph with its plain text and
 * doc-coordinate range. Skips tables, section breaks, and TOC entries — anchoring v1
 * targets prose paragraphs only (per SPEC §11: image/table anchoring is out of scope).
 */
export function extractParagraphs(doc: Document): ParagraphText[] {
  return paragraphsOf(doc.body?.content);
}

/**
 * Walk every region of the document — body, headers, footers, footnotes — and return
 * one entry per paragraph tagged with its region. Use this when looking for an anchor
 * that may live outside the body (Drive comments and tracked-change suggestions can
 * land in any region; the Drive API doesn't expose which one for comments, so we
 * have to scan everywhere).
 *
 * Note: `startIndex`/`endIndex` are doc-coordinates — for the body those are unique,
 * but for non-body regions the same coord space can repeat. Callers using these
 * coords for batchUpdate must stick to body paragraphs.
 */
export function extractAllParagraphs(doc: Document): RegionParagraphText[] {
  const out: RegionParagraphText[] = [];
  for (const p of paragraphsOf(doc.body?.content)) out.push({ ...p, region: "body", regionId: "" });
  for (const [id, h] of Object.entries(doc.headers ?? {})) {
    for (const p of paragraphsOf(h.content)) out.push({ ...p, region: "header", regionId: id });
  }
  for (const [id, f] of Object.entries(doc.footers ?? {})) {
    for (const p of paragraphsOf(f.content)) out.push({ ...p, region: "footer", regionId: id });
  }
  for (const [id, fn] of Object.entries(doc.footnotes ?? {})) {
    for (const p of paragraphsOf(fn.content)) out.push({ ...p, region: "footnote", regionId: id });
  }
  return out;
}

function paragraphsOf(content: StructuralElement[] | undefined): ParagraphText[] {
  const out: ParagraphText[] = [];
  let i = 0;
  for (const el of content ?? []) {
    if (!el.paragraph) continue;
    let text = "";
    for (const pe of el.paragraph.elements ?? []) {
      if (pe.textRun?.content) text += pe.textRun.content;
    }
    if (text.endsWith("\n")) text = text.slice(0, -1);
    out.push({
      paragraphIndex: i,
      text,
      startIndex: el.startIndex ?? 0,
      endIndex: el.endIndex ?? 0,
    });
    i++;
  }
  return out;
}
