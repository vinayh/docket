import { authedJson, type TokenProvider } from "./api.ts";

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

export interface Document {
  documentId: string;
  title: string;
  body?: { content: StructuralElement[] };
  revisionId?: string;
}

export async function getDocument(tp: TokenProvider, documentId: string): Promise<Document> {
  return authedJson(tp, `${DOCS_BASE}/documents/${encodeURIComponent(documentId)}`);
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
