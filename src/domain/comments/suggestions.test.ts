import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, seedProject, seedUser, seedVersion } from "../../../test/db.ts";
import { db } from "../../db/client.ts";
import { canonicalComment, commentProjection } from "../../db/schema.ts";
import type { DocxSuggestion } from "../../google/docx.ts";
import type { AuthorIndex } from "./drive-index.ts";
import { ingestSuggestions } from "./suggestions.ts";
import type { IngestResult } from "./types.ts";

beforeEach(cleanDb);

function emptyResult(versionId: string): IngestResult {
  return {
    versionId,
    fetched: 0,
    inserted: 0,
    alreadyPresent: 0,
    skippedOrphanMetadata: 0,
    suggestionsInserted: 0,
  };
}

const emptyAuthorIndex: AuthorIndex = { byName: new Map() };

function suggestion(overrides: Partial<DocxSuggestion> = {}): DocxSuggestion {
  return {
    id: "1",
    kind: "suggestion_insert",
    author: "Alice",
    date: "2026-01-01T00:00:00Z",
    region: "body",
    regionId: "",
    paragraphIndex: 0,
    paragraphText: "Hello world.",
    offset: 6,
    length: 6,
    text: "world.",
    ...overrides,
  };
}

async function seedHarness() {
  const owner = await seedUser();
  const proj = await seedProject({ ownerUserId: owner.id });
  const ver = await seedVersion({ projectId: proj.id, createdByUserId: owner.id });
  return { owner, proj, ver };
}

describe("ingestSuggestions", () => {
  test("inserts one canonical row per suggestion and bumps counters", async () => {
    const { proj, ver } = await seedHarness();
    const result = emptyResult(ver.id);
    const byOoxmlId = await ingestSuggestions({
      projectId: proj.id,
      versionId: ver.id,
      suggestions: [
        suggestion({ id: "ins-1" }),
        suggestion({
          id: "del-1",
          kind: "suggestion_delete",
          offset: 0,
          text: "Hello ",
          length: 6,
        }),
      ],
      authorIndex: emptyAuthorIndex,
      result,
    });

    expect(byOoxmlId.size).toBe(2);
    expect(byOoxmlId.has("ins-1")).toBe(true);
    expect(byOoxmlId.has("del-1")).toBe(true);
    expect(result.fetched).toBe(2);
    expect(result.inserted).toBe(2);
    expect(result.suggestionsInserted).toBe(2);

    const rows = await db
      .select()
      .from(canonicalComment)
      .where(eq(canonicalComment.projectId, proj.id));
    expect(rows).toHaveLength(2);
    const kinds = rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(["suggestion_delete", "suggestion_insert"]);
    const ins = rows.find((r) => r.kind === "suggestion_insert")!;
    expect(ins.body).toBe("[suggested insertion] world.");
    const del = rows.find((r) => r.kind === "suggestion_delete")!;
    expect(del.body).toBe("[suggested deletion] Hello ");
  });

  test("re-running with the same input is idempotent — alreadyPresent ticks, no new rows", async () => {
    const { proj, ver } = await seedHarness();
    const sug = suggestion({ id: "sug-stable" });

    const first = emptyResult(ver.id);
    await ingestSuggestions({
      projectId: proj.id,
      versionId: ver.id,
      suggestions: [sug],
      authorIndex: emptyAuthorIndex,
      result: first,
    });
    expect(first.inserted).toBe(1);

    // Second pass with a different OOXML id but identical content+position must
    // dedupe — suggestion ids rotate across exports, so the idempotency key is
    // content-based.
    const second = emptyResult(ver.id);
    await ingestSuggestions({
      projectId: proj.id,
      versionId: ver.id,
      suggestions: [{ ...sug, id: "sug-rotated" }],
      authorIndex: emptyAuthorIndex,
      result: second,
    });
    expect(second.inserted).toBe(0);
    expect(second.alreadyPresent).toBe(1);
    expect(second.suggestionsInserted).toBe(0);

    const rows = await db
      .select()
      .from(canonicalComment)
      .where(eq(canonicalComment.projectId, proj.id));
    expect(rows).toHaveLength(1);
  });

  test("writes a projection row keyed on (versionId, idempotency key)", async () => {
    const { proj, ver } = await seedHarness();
    const result = emptyResult(ver.id);
    const map = await ingestSuggestions({
      projectId: proj.id,
      versionId: ver.id,
      suggestions: [suggestion({ id: "x" })],
      authorIndex: emptyAuthorIndex,
      result,
    });
    const canonicalId = map.get("x")!;
    const rows = await db
      .select()
      .from(commentProjection)
      .where(eq(commentProjection.canonicalCommentId, canonicalId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.versionId).toBe(ver.id);
    expect(rows[0]?.googleCommentId?.startsWith("mgn:sug:")).toBe(true);
    expect(rows[0]?.projectionStatus).toBe("clean");
  });

  test("changing position produces a fresh idempotency key (different row)", async () => {
    const { proj, ver } = await seedHarness();
    const r1 = emptyResult(ver.id);
    await ingestSuggestions({
      projectId: proj.id,
      versionId: ver.id,
      suggestions: [suggestion({ paragraphIndex: 0, offset: 0 })],
      authorIndex: emptyAuthorIndex,
      result: r1,
    });
    const r2 = emptyResult(ver.id);
    await ingestSuggestions({
      projectId: proj.id,
      versionId: ver.id,
      suggestions: [suggestion({ paragraphIndex: 1, offset: 0 })],
      authorIndex: emptyAuthorIndex,
      result: r2,
    });
    expect(r2.inserted).toBe(1);
    expect(r2.alreadyPresent).toBe(0);
    const rows = await db
      .select()
      .from(canonicalComment)
      .where(eq(canonicalComment.projectId, proj.id));
    expect(rows).toHaveLength(2);
  });
});
