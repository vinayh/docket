import { authenticateBearer, badRequest, jsonOk, unauthorized } from "./middleware.ts";
import { getDocState } from "../domain/doc-state.ts";

const MAX_BODY_BYTES = 4 * 1024;
const MAX_DOC_ID_LEN = 200;

/**
 * POST /api/extension/doc-state — drives the popup's "is this doc tracked?"
 * UI. Body: `{ docId }`. Response is the discriminated `DocStateResponse`
 * union (see `src/domain/doc-state.ts`); the popup branches on `tracked`.
 *
 * POST instead of GET because the doc id is mildly sensitive — keeping it
 * out of the URL means it doesn't end up in proxy / browser history. Also
 * keeps the route table consistent with the rest of `/api/extension/*`,
 * which is all POST.
 */
export async function handleDocStatePost(req: Request): Promise<Response> {
  const auth = await authenticateBearer(req);
  if (!auth) return unauthorized();

  const docId = await readDocId(req);
  if (typeof docId !== "string") return docId;

  const state = await getDocState({ docId, userId: auth.userId });
  return jsonOk(state);
}

export async function readDocId(req: Request): Promise<string | Response> {
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
  if (!payload || typeof payload !== "object") {
    return badRequest("expected { docId: string }");
  }
  const raw = (payload as { docId?: unknown }).docId;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_DOC_ID_LEN) {
    return badRequest("expected { docId: string }");
  }
  return raw;
}
