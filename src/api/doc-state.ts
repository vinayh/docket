import * as v from "valibot";
import {
  authenticateBearer,
  jsonOk,
  parseOr400,
  readJsonBody,
  unauthorized,
} from "./middleware.ts";
import { getDocState } from "../domain/doc-state.ts";

const MAX_BODY_BYTES = 4 * 1024;
const MAX_DOC_ID_LEN = 200;

const DocIdBodySchema = v.object({
  docId: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_DOC_ID_LEN)),
});

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
  if (docId instanceof Response) return docId;

  const state = await getDocState({ docId, userId: auth.userId });
  return jsonOk(state);
}

export async function readDocId(req: Request): Promise<string | Response> {
  const payload = await readJsonBody(req, MAX_BODY_BYTES);
  if (payload instanceof Response) return payload;
  const parsed = parseOr400(DocIdBodySchema, payload);
  if (parsed instanceof Response) return parsed;
  return parsed.docId;
}
