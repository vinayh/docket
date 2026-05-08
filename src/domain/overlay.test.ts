import { describe, expect, test } from "bun:test";
import { endOfBodyIndex, flattenPlan, planOverlay } from "./overlay.ts";
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
