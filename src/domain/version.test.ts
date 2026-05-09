import { describe, expect, test } from "bun:test";
import { pickNextLabel } from "./version.ts";

describe("pickNextLabel", () => {
  test("empty project starts at v1", () => {
    expect(pickNextLabel([])).toBe("v1");
  });

  test("single existing v1 → v2", () => {
    expect(pickNextLabel(["v1"])).toBe("v2");
  });

  test("MAX-based: gaps in the sequence don't reuse old numbers", () => {
    // Pre-fix this used `existing.length + 1`, which would have returned `v3`
    // here (3 existing rows). Parsing MAX gives `v6`, which is what we want
    // even after archives or future deletes leave gaps.
    expect(pickNextLabel(["v1", "v3", "v5"])).toBe("v6");
  });

  test("manual labels are ignored", () => {
    expect(pickNextLabel(["alpha", "v1", "release-2024"])).toBe("v2");
  });

  test("only manual labels → v1", () => {
    expect(pickNextLabel(["alpha", "release"])).toBe("v1");
  });

  test("trailing zeros and large numbers are parsed correctly", () => {
    expect(pickNextLabel(["v009", "v42"])).toBe("v43");
  });

  test("does not match v-prefixed strings with non-digit suffixes", () => {
    expect(pickNextLabel(["v1.0", "v2-rc"])).toBe("v1");
  });
});
