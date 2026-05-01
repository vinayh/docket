import { db } from "../db/client.ts";
import { user } from "../db/schema.ts";
import { tokenProviderForUser } from "../auth/credentials.ts";
import { copyFile, getFile, listComments } from "../google/drive.ts";

function parseDocId(input: string): string {
  const m = input.match(/\/document\/d\/([^/]+)/);
  if (m && m[1]) return m[1];
  return input;
}

const arg = process.argv[2];
if (!arg) {
  console.error("usage: bun src/cli/smoke.ts <doc-url-or-id>");
  process.exit(1);
}
const docId = parseDocId(arg);

const users = await db.select().from(user).limit(1);
const u = users[0];
if (!u) {
  console.error("no user in db. Run `bun src/cli/connect.ts` first.");
  process.exit(1);
}

console.log(`acting as ${u.email} (id=${u.id})`);
const tp = tokenProviderForUser(u.id);

console.log(`\nfetching metadata for ${docId}...`);
const file = await getFile(tp, docId);
console.log(file);

console.log(`\ncopying ${file.name}...`);
const copy = await copyFile(tp, docId, { name: `[docket smoke] ${file.name}` });
console.log(copy);

console.log(`\nlisting comments on the original...`);
const comments = await listComments(tp, docId);
console.log(`${comments.length} comment(s)`);
for (const c of comments) {
  console.log(
    `- ${c.author?.displayName ?? "?"} @ ${c.createdTime}: ${c.content.slice(0, 60)}`,
  );
}
