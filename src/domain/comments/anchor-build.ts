import type { CommentAnchor, DocRegion } from "../../db/schema.ts";
import { anchorAt } from "../anchor.ts";

export interface BuildAnchorArgs {
  quotedText: string;
  paragraphText: string;
  region: DocRegion;
  regionId: string;
  paragraphIndex: number;
  offset: number;
  length: number;
}

/**
 * Construct a `CommentAnchor` directly from docx parser output — no
 * re-search step needed, since the parser already gave us paragraph index
 * + offset. Routes through `anchorAt` so context-slicing / paragraph-hashing
 * lives in one place; we feed it a fabricated paragraph (start/end indices
 * don't matter — `anchorAt` only reads `.text` + `.paragraphIndex`).
 */
export function buildAnchor(args: BuildAnchorArgs): CommentAnchor {
  return anchorAt(
    args.quotedText,
    {
      text: args.paragraphText,
      paragraphIndex: args.paragraphIndex,
      startIndex: 0,
      endIndex: 0,
    },
    args.offset,
    { matchLen: args.length, region: args.region, regionId: args.regionId },
  );
}
