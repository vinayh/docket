import { desc, eq } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { canonicalComment } from "../../db/schema.ts";

export type CanonicalComment = typeof canonicalComment.$inferSelect;

export async function listCommentsForProject(
  projectId: string,
): Promise<CanonicalComment[]> {
  return db
    .select()
    .from(canonicalComment)
    .where(eq(canonicalComment.projectId, projectId))
    .orderBy(desc(canonicalComment.originTimestamp));
}
