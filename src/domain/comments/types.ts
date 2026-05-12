import { paragraphHash } from "../anchor.ts";

/**
 * Per-version result of `ingestVersionComments`. Phase B (replies) reuses
 * Phase A's drive-id → canonical-id map, so the counters tick up across
 * both passes for a single doc.
 */
export interface IngestResult {
  versionId: string;
  fetched: number;
  inserted: number;
  alreadyPresent: number;
  /**
   * `<w:comment>` rows with no `commentRangeStart`/`End` pair found in the
   * body, headers, footers, or footnotes. Dropped — there's no anchor.
   */
  skippedOrphanMetadata: number;
  /** Subset of `inserted` that were tracked-change suggestions (insert + delete). */
  suggestionsInserted: number;
}

/** Short-hash helper used by idempotency keys (suggestion + comment). */
export function hashShort(text: string): string {
  return paragraphHash(text).slice(0, 16);
}
