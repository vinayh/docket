import { beforeEach, describe, expect, test } from "bun:test";
import { cleanDb, seedProject, seedUser } from "../../test/db.ts";
import {
  addOverlayOperation,
  createOverlay,
  endOfBodyIndex,
  flattenPlan,
  getOverlay,
  listOverlayOperations,
  listOverlays,
  planOverlay,
  requireOverlay,
} from "./overlay.ts";
import type { Document } from "../google/docs.ts";
import type { OverlayAnchor } from "../db/schema.ts";

type OverlayOp = {
  id: string;
  overlayId: string;
  orderIndex: number;
  type: "redact" | "replace" | "insert" | "append";
  anchor: OverlayAnchor;
  payload: string | null;
  confidenceThreshold: number | null;
};

function op(o: Partial<OverlayOp> & { type: OverlayOp["type"]; orderIndex: number }): OverlayOp {
  return {
    id: `op-${o.orderIndex}`,
    overlayId: "overlay-x",
    payload: null,
    confidenceThreshold: null,
    anchor: { quotedText: "" },
    ...o,
  };
}

function docFromParagraphs(paragraphs: string[]): Document {
  let cursor = 1;
  return {
    documentId: "test",
    title: "test",
    body: {
      content: paragraphs.map((text) => {
        const start = cursor;
        const content = text + "\n";
        const end = start + content.length;
        cursor = end;
        return {
          startIndex: start,
          endIndex: end,
          paragraph: {
            elements: [{ startIndex: start, endIndex: end, textRun: { content } }],
          },
        };
      }),
    },
  };
}

describe("endOfBodyIndex", () => {
  test("points at the body's trailing newline", () => {
    // "Hello\n" → start=1 end=7 → endOfBody=6
    const doc = docFromParagraphs(["Hello"]);
    expect(endOfBodyIndex(doc)).toBe(6);
  });

  test("falls back to 1 for an empty body", () => {
    expect(endOfBodyIndex({ documentId: "x", title: "x" })).toBe(1);
  });
});

describe("planOverlay", () => {
  const doc = docFromParagraphs([
    "First paragraph here.",
    "Confidential note: do not share with reviewers.",
    "Tail.",
  ]);

  test("redact translates to deleteContentRange at the resolved index", () => {
    const ops = [
      op({
        type: "redact",
        orderIndex: 0,
        anchor: { quotedText: "Confidential note" },
      }),
    ];
    const plan = planOverlay(ops, doc);
    expect(plan.ops[0]!.status).toBe("clean");
    expect(plan.ops[0]!.requests).toHaveLength(1);
    const req = plan.ops[0]!.requests[0]! as { deleteContentRange?: { range?: { startIndex: number; endIndex: number } } };
    // "First paragraph here.\n" is 1..23 → "Confidential..." paragraph starts at 23
    expect(req.deleteContentRange?.range?.startIndex).toBe(23);
    expect(req.deleteContentRange?.range?.endIndex).toBe(23 + "Confidential note".length);
  });

  test("redact with a payload becomes delete + insert", () => {
    const ops = [
      op({
        type: "redact",
        orderIndex: 0,
        anchor: { quotedText: "Confidential note" },
        payload: "[REDACTED]",
      }),
    ];
    const plan = planOverlay(ops, doc);
    expect(plan.ops[0]!.requests).toHaveLength(2);
    expect((plan.ops[0]!.requests[1]! as { insertText?: { text: string; location: { index: number } } }).insertText?.text).toBe("[REDACTED]");
  });

  test("replace becomes delete + insert at the same index", () => {
    const ops = [
      op({
        type: "replace",
        orderIndex: 0,
        anchor: { quotedText: "First paragraph" },
        payload: "Opening line",
      }),
    ];
    const plan = planOverlay(ops, doc);
    expect(plan.ops[0]!.requests).toHaveLength(2);
    const del = plan.ops[0]!.requests[0]! as { deleteContentRange?: { range?: { startIndex: number; endIndex: number } } };
    const ins = plan.ops[0]!.requests[1]! as { insertText?: { text: string; location: { index: number } } };
    expect(del.deleteContentRange?.range?.startIndex).toBe(1);
    expect(ins.insertText?.location.index).toBe(1);
    expect(ins.insertText?.text).toBe("Opening line");
  });

  test("insert places text after the anchor's end", () => {
    const ops = [
      op({
        type: "insert",
        orderIndex: 0,
        anchor: { quotedText: "First paragraph" },
        payload: " (inserted)",
      }),
    ];
    const plan = planOverlay(ops, doc);
    const ins = plan.ops[0]!.requests[0]! as { insertText?: { text: string; location: { index: number } } };
    expect(ins.insertText?.location.index).toBe(1 + "First paragraph".length);
  });

  test("append targets the end-of-body index", () => {
    const ops = [op({ type: "append", orderIndex: 0, payload: " — fin" })];
    const plan = planOverlay(ops, doc);
    const ins = plan.ops[0]!.requests[0]! as { insertText?: { text: string; location: { index: number } } };
    expect(ins.insertText?.location.index).toBe(endOfBodyIndex(doc));
  });

  test("orphan anchor is skipped with a reason", () => {
    const ops = [
      op({
        type: "redact",
        orderIndex: 0,
        anchor: { quotedText: "this text is not in the doc" },
      }),
    ];
    const plan = planOverlay(ops, doc);
    expect(plan.ops[0]!.status).toBe("skipped");
    expect(plan.ops[0]!.reason).toContain("anchor not found");
    expect(plan.ops[0]!.requests).toEqual([]);
    expect(plan.hasSkipped).toBe(true);
  });

  test("threshold above match confidence skips the op", () => {
    const ops = [
      op({
        type: "redact",
        orderIndex: 0,
        anchor: { quotedText: "First paragraph" },
        confidenceThreshold: 100, // anchor lacks paragraphHash → < 100
      }),
    ];
    const plan = planOverlay(ops, doc);
    expect(plan.ops[0]!.status).toBe("skipped");
    expect(plan.ops[0]!.reason).toContain("confidence");
  });

  test("append with no payload is skipped", () => {
    const ops = [op({ type: "append", orderIndex: 0, payload: null })];
    const plan = planOverlay(ops, doc);
    expect(plan.ops[0]!.status).toBe("skipped");
    expect(plan.ops[0]!.reason).toBe("empty payload");
    expect(plan.ops[0]!.requests).toEqual([]);
  });

  test("insert with empty payload is skipped even when the anchor matches", () => {
    const ops = [
      op({
        type: "insert",
        orderIndex: 0,
        anchor: { quotedText: "First paragraph" },
        payload: "",
      }),
    ];
    const plan = planOverlay(ops, doc);
    expect(plan.ops[0]!.status).toBe("skipped");
    expect(plan.ops[0]!.reason).toBe("empty payload");
  });

  test("replace with empty payload becomes a delete-only request", () => {
    const ops = [
      op({
        type: "replace",
        orderIndex: 0,
        anchor: { quotedText: "First paragraph" },
        payload: "",
      }),
    ];
    const plan = planOverlay(ops, doc);
    expect(plan.ops[0]!.requests).toHaveLength(1);
    expect(plan.ops[0]!.requests[0]).toMatchObject({ deleteContentRange: {} });
  });
});

describe("overlay CRUD", () => {
  beforeEach(cleanDb);

  test("createOverlay rejects an unknown projectId", async () => {
    await expect(
      createOverlay({ projectId: crypto.randomUUID(), name: "ext-launch" }),
    ).rejects.toThrow(/project/);
  });

  test("getOverlay null + requireOverlay throws for missing ids", async () => {
    expect(await getOverlay(crypto.randomUUID())).toBeNull();
    const id = crypto.randomUUID();
    await expect(requireOverlay(id)).rejects.toThrow(new RegExp(id));
  });

  test("createOverlay round-trips and listOverlays orders newest-first", async () => {
    const u = await seedUser();
    const p = await seedProject({ ownerUserId: u.id });

    const ov1 = await createOverlay({ projectId: p.id, name: "first" });
    await new Promise((r) => setTimeout(r, 5));
    const ov2 = await createOverlay({ projectId: p.id, name: "second" });

    expect((await getOverlay(ov1.id))?.name).toBe("first");
    const list = await listOverlays(p.id);
    expect(list.map((o) => o.id)).toEqual([ov2.id, ov1.id]);
  });

  test("addOverlayOperation auto-increments orderIndex from -1", async () => {
    const u = await seedUser();
    const p = await seedProject({ ownerUserId: u.id });
    const ov = await createOverlay({ projectId: p.id, name: "ext" });

    const op0 = await addOverlayOperation({
      overlayId: ov.id,
      type: "redact",
      anchor: { quotedText: "alpha" },
    });
    const op1 = await addOverlayOperation({
      overlayId: ov.id,
      type: "append",
      anchor: { quotedText: "" },
      payload: " — fin",
    });
    const op2 = await addOverlayOperation({
      overlayId: ov.id,
      type: "insert",
      anchor: { quotedText: "alpha" },
      payload: " (note)",
      confidenceThreshold: 90,
    });

    expect(op0.orderIndex).toBe(0);
    expect(op1.orderIndex).toBe(1);
    expect(op2.orderIndex).toBe(2);

    // listOverlayOperations returns ascending orderIndex.
    const listed = await listOverlayOperations(ov.id);
    expect(listed.map((o) => o.orderIndex)).toEqual([0, 1, 2]);
    expect(listed[2]!.confidenceThreshold).toBe(90);
    expect(listed[1]!.payload).toBe(" — fin");
  });

  test("addOverlayOperation rejects an unknown overlayId", async () => {
    await expect(
      addOverlayOperation({
        overlayId: crypto.randomUUID(),
        type: "append",
        anchor: { quotedText: "" },
      }),
    ).rejects.toThrow(/overlay/);
  });

  test("listOverlayOperations returns [] for an overlay with no ops", async () => {
    const u = await seedUser();
    const p = await seedProject({ ownerUserId: u.id });
    const ov = await createOverlay({ projectId: p.id, name: "empty" });
    expect(await listOverlayOperations(ov.id)).toEqual([]);
  });
});

describe("flattenPlan", () => {
  const doc = docFromParagraphs(["alpha bravo charlie", "delta echo foxtrot"]);

  test("sorts requests by descending primary index so earlier edits don't shift later ones", () => {
    const ops = [
      op({ type: "redact", orderIndex: 0, anchor: { quotedText: "alpha" } }),
      op({ type: "redact", orderIndex: 1, anchor: { quotedText: "delta" } }),
      op({ type: "append", orderIndex: 2, payload: "!" }),
    ];
    const plan = planOverlay(ops, doc);
    const flat = flattenPlan(plan);
    const indices = flat.map((r) => {
      const x = r as { deleteContentRange?: { range?: { startIndex: number } }; insertText?: { location?: { index: number } } };
      return x.deleteContentRange?.range?.startIndex ?? x.insertText?.location?.index ?? -1;
    });
    expect(indices).toEqual([...indices].sort((a, b) => b - a));
  });
});
