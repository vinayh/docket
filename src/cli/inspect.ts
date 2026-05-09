import { inspectDoc } from "../domain/inspect.ts";
import { parseGoogleDocId } from "../domain/google-doc-url.ts";
import { defaultUser, usage } from "./util.ts";

export async function run(args: string[]): Promise<void> {
  const arg = args[0];
  if (!arg) usage("usage: bun docket inspect <doc-url-or-id>");

  const docId = parseGoogleDocId(arg);
  const u = await defaultUser();
  const r = await inspectDoc({ userId: u.id, docId });

  console.log("=== drive.comments.list (fields=*, includeDeleted=true) ===");
  console.log(JSON.stringify(r.comments, null, 2));

  console.log("\n=== documents.get (SUGGESTIONS_INLINE) ===");
  console.log(JSON.stringify(r.document, null, 2));
}
