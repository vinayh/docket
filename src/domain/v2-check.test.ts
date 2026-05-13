import { describe, expect, test } from "bun:test";
import { parseDocx } from "../google/docx.ts";
import { buildProbeDocx } from "./v2-check.ts";

// The Drive-uploading path is exercised via `bun margin v2-check` (live
// Google), but the probe-docx builder is pure and round-trips through
// parseDocx — guard the OOXML shape so the smoke command can't quietly drift.

describe("buildProbeDocx", () => {
  test("parses back to 3 comment groups (one disjoint multi-range)", () => {
    const out = parseDocx(buildProbeDocx());
    // Comments 2 + 3 share (author, date, body) and collapse to one row with
    // two ranges; comments 0 + 1 stay distinct.
    expect(out.comments).toHaveLength(3);
    const disjoint = out.comments.find((c) => c.ranges.length > 1);
    expect(disjoint).toBeDefined();
    expect(disjoint!.ranges).toHaveLength(2);
  });

  test("parses back to two suggestions: one insert + one delete", () => {
    const out = parseDocx(buildProbeDocx());
    expect(out.suggestions).toHaveLength(2);
    const kinds = out.suggestions.map((s) => s.kind).sort();
    expect(kinds).toEqual(["suggestion_delete", "suggestion_insert"]);
  });

  test("preserves known author + date on every annotation", () => {
    const out = parseDocx(buildProbeDocx());
    for (const c of out.comments) {
      expect(c.author).toBe("Margin V2 Probe");
      expect(c.date).toBe("2026-05-13T12:00:00Z");
    }
    for (const s of out.suggestions) {
      expect(s.author).toBe("Margin V2 Probe");
      expect(s.date).toBe("2026-05-13T12:00:00Z");
    }
  });
});
