import { authenticateBearer, badRequest, jsonOk, unauthorized } from "./middleware.ts";
import {
  ingestExtensionCaptures,
  type CaptureInput,
} from "../domain/capture.ts";

const MAX_BATCH = 50;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_FIELD_LEN = 16 * 1024;

export async function handleCapturesPost(req: Request): Promise<Response> {
  const auth = await authenticateBearer(req);
  if (!auth) return unauthorized();

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return badRequest(`request too large: ${contentLength} > ${MAX_BODY_BYTES}`);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return badRequest("invalid json");
  }

  const captures = parseCaptures(payload);
  if (!captures) return badRequest("expected { captures: CaptureInput[] }");
  if (captures.length === 0) return jsonOk({ results: [] });
  if (captures.length > MAX_BATCH) {
    return badRequest(`batch too large: ${captures.length} > ${MAX_BATCH}`);
  }

  const result = await ingestExtensionCaptures(captures);
  return jsonOk(result);
}

function parseCaptures(payload: unknown): CaptureInput[] | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = (payload as { captures?: unknown }).captures;
  if (!Array.isArray(raw)) return null;
  const out: CaptureInput[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") return null;
    const c = r as Record<string, unknown>;
    const externalId = str(c.externalId);
    const docId = str(c.docId);
    const body = str(c.body);
    if (!externalId || !docId || !body) return null;
    out.push({
      externalId,
      docId,
      body,
      kixDiscussionId: optStr(c.kixDiscussionId),
      parentQuotedText: optStr(c.parentQuotedText),
      authorDisplayName: optStr(c.authorDisplayName),
      authorEmail: optStr(c.authorEmail),
      createdAt: optStr(c.createdAt),
    });
  }
  return out;
}

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  if (v.length > MAX_FIELD_LEN) return undefined;
  return v;
}

function optStr(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return str(v);
}
