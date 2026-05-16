import { authenticateBearer, jsonOk, unauthorized } from "./middleware.ts";
import { getUserById } from "../domain/user.ts";

/**
 * POST /api/extension/whoami — returns the authenticated user's profile
 * (email, name, avatar URL) so the Options page can render the signed-in
 * identity block. The bearer session identifies the user; the body is unused.
 */
export async function handleWhoamiPost(req: Request): Promise<Response> {
  const auth = await authenticateBearer(req);
  if (!auth) return unauthorized();

  const u = await getUserById(auth.userId);
  return jsonOk({
    email: u?.email ?? null,
    name: u?.name ?? null,
    image: u?.image ?? null,
  });
}
