import * as v from "valibot";
import {
  authenticateBearer,
  IdSchema,
  jsonOk,
  notFound,
  readAndParseJson,
  unauthorized,
} from "./middleware.ts";
import { getOwnedProject } from "../domain/project.ts";
import { createVersion } from "../domain/version.ts";

const MAX_BODY_BYTES = 4 * 1024;
const MAX_LABEL_LEN = 64;

const VersionCreateBodySchema = v.object({
  projectId: IdSchema,
  label: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_LABEL_LEN)),
  ),
});

/**
 * POST /api/extension/version/create — snapshot a new version of the parent
 * doc. Body: `{ projectId, label? }`. Owner-scoped: 404 when the project is
 * missing or not owned by the caller (same no-info-leak posture as project-
 * detail). Returns the inserted row's id + label so the panel can refresh
 * without a second round-trip.
 */
export async function handleVersionCreatePost(req: Request): Promise<Response> {
  const auth = await authenticateBearer(req);
  if (!auth) return unauthorized();

  const parsed = await readAndParseJson(
    req,
    MAX_BODY_BYTES,
    VersionCreateBodySchema,
  );
  if (parsed instanceof Response) return parsed;

  const proj = await getOwnedProject(parsed.projectId, auth.userId);
  if (!proj) return notFound();

  const ver = await createVersion({
    projectId: proj.id,
    createdByUserId: auth.userId,
    label: parsed.label,
  });
  return jsonOk({
    versionId: ver.id,
    label: ver.label,
    googleDocId: ver.googleDocId,
  });
}
