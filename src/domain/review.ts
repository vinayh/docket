import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { reviewRequest } from "../db/schema.ts";

export type ReviewRequest = typeof reviewRequest.$inferSelect;

export async function listOpenReviewRequests(
  projectId: string,
): Promise<ReviewRequest[]> {
  return db
    .select()
    .from(reviewRequest)
    .where(
      and(
        eq(reviewRequest.projectId, projectId),
        eq(reviewRequest.status, "open"),
      ),
    )
    .orderBy(desc(reviewRequest.createdAt));
}
