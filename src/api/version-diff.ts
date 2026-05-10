import { authenticateBearer, badRequest, jsonOk, unauthorized } from "./middleware.ts";
import { getVersionDiffPayload } from "../domain/version-diff.ts";

const MAX_BODY_BYTES = 4 * 1024;
const MAX_ID_LEN = 200;

/**
 * POST /api/extension/version-diff — structured side-by-side diff payload
 * for two versions of the same project. Body:
 * `{ fromVersionId, toVersionId }`. Returns the summarized paragraphs for
 * both sides; the side-panel runs the actual diff render client-side
 * (SPEC §12 Phase 4 structured-diff bullet).
 *
 * Owner-scoped on both versions, and refuses cross-project diffs — both
 * conditions collapse to 404 so the caller can't probe for the existence
 * of versions they shouldn't see.
 */
export async function handleVersionDiffPost(req: Request): Promise<Response> {
  const auth = await authenticateBearer(req);
  if (!auth) return unauthorized();

  const ids = await readVersionIds(req);
  if ("error" in ids) return ids.error;

  const payload = await getVersionDiffPayload({
    fromVersionId: ids.fromVersionId,
    toVersionId: ids.toVersionId,
    userId: auth.userId,
  });
  if (!payload) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  return jsonOk(payload);
}

interface VersionIds {
  fromVersionId: string;
  toVersionId: string;
}

async function readVersionIds(
  req: Request,
): Promise<VersionIds | { error: Response }> {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return { error: badRequest(`request too large: ${contentLength} > ${MAX_BODY_BYTES}`) };
  }
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return { error: badRequest("invalid json") };
  }
  if (!payload || typeof payload !== "object") {
    return {
      error: badRequest("expected { fromVersionId: string, toVersionId: string }"),
    };
  }
  const from = (payload as { fromVersionId?: unknown }).fromVersionId;
  const to = (payload as { toVersionId?: unknown }).toVersionId;
  if (
    typeof from !== "string" ||
    from.length === 0 ||
    from.length > MAX_ID_LEN ||
    typeof to !== "string" ||
    to.length === 0 ||
    to.length > MAX_ID_LEN
  ) {
    return {
      error: badRequest("expected { fromVersionId: string, toVersionId: string }"),
    };
  }
  if (from === to) {
    return { error: badRequest("fromVersionId and toVersionId must differ") };
  }
  return { fromVersionId: from, toVersionId: to };
}
