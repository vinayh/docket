import type { CaptureInput } from "../../utils/types.ts";
import { stableReplyId } from "../../utils/ids.ts";

/**
 * Scrape the Google Docs discussion sidebar for suggestion threads + their
 * replies. The DOM here is **not part of any contract** — Google reships
 * Docs roughly quarterly and these selectors will rot. Treat each selector
 * as a hypothesis: try it, fall back to a more permissive one, fail silently.
 *
 * Selector strategy (most to least specific):
 *  - `[role="region"][id^="docos-anchor-"]`  ← discussion root
 *  - `.docos-anchoreddocoview-rootelement`
 *  - any element whose id starts with `docos-anchor-` or carries
 *    `data-discussion-id`.
 *
 * Within a thread, individual replies live in elements that carry
 * `.docos-replyview-comment` or `.docos-replyview-body-with-quote`. The
 * suggestion's quoted text sits inside `.docos-anchoredreplyview-quote-content`
 * or `.docos-anchoredcomment-quotetextview`. Author / timestamp markers vary;
 * we try a small list of selectors and pick the first that yields a string.
 *
 * Exported helpers are split out so we can swap selectors without rewriting
 * the orchestration logic, and so DOM reads sit behind narrow seams that are
 * easy to refactor when the Docs UI churns.
 */

interface RawReply {
  /** Full text of the reply body, trimmed. */
  body: string;
  authorDisplayName?: string;
  /** ISO-8601 if we manage to parse one; raw string otherwise. */
  createdAt?: string;
}

interface RawThread {
  root: Element;
  kixDiscussionId?: string;
  parentQuotedText?: string;
  /** Whether this thread looks like a *suggestion* (vs. a plain comment). */
  isSuggestion: boolean;
  replies: RawReply[];
}

const THREAD_ROOT_SELECTORS = [
  ".docos-anchoreddocoview",
  '[role="region"][id^="docos-anchor-"]',
  ".docos-anchoreddocoview-rootelement",
  "[data-discussion-id]",
];

const REPLY_SELECTORS = [
  ".docos-anchoredreplyview",
  ".docos-replyview-comment",
  ".docos-replyview-body-with-quote",
  ".docos-anchoredreplyview-body",
];

// Older selectors hit inner bodies / button rows; the canonical wrapper is
// `.docos-anchoredreplyview`. Normalizing each match up to that wrapper means
// a single reply isn't counted twice when multiple selectors find descendants
// of the same wrapper.
const REPLY_WRAPPER_SELECTOR = ".docos-anchoredreplyview";

const QUOTE_SELECTORS = [
  ".docos-anchoredreplyview-quote-content",
  ".docos-anchoredcomment-quotetextview",
  ".docos-replyview-quoted-string",
];

const BODY_SELECTORS = [
  ".docos-anchoredreplyview-body",
  ".docos-replyview-body",
  ".docos-replyview-body-text",
  ".docos-replyview-body-with-quote .docos-replyview-body",
];

const AUTHOR_SELECTORS = [
  ".docos-author-name",
  ".docos-anchoredreplyview-author",
  ".docos-replyview-author",
];

const TIMESTAMP_SELECTORS = [
  ".docos-replyview-timestamp",
  "time[datetime]",
  "[data-tooltip-formatter]",
  ".docos-anchoredreplyview-timestamp",
];

const SUGGESTION_HINTS = [
  ".docos-replyview-suggest",
  ".docos-accept-suggestion",
  ".docos-reject-suggestion",
  ".docos-suggestion-card",
  ".docos-anchoredsuggestion",
  ".docos-suggestion-",
];

function pickText(root: ParentNode, selectors: readonly string[]): string | undefined {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el && el.textContent) {
      const t = el.textContent.trim();
      if (t) return t;
    }
  }
  return undefined;
}

function pickAttr(
  root: ParentNode,
  selectors: readonly string[],
  attr: string,
): string | undefined {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    const v = el?.getAttribute(attr);
    if (v) return v;
  }
  return undefined;
}

function isSuggestionThread(root: Element): boolean {
  for (const hint of SUGGESTION_HINTS) {
    if (root.querySelector(hint)) return true;
    if (root.classList.contains(hint.replace(/^\./, ""))) return true;
  }
  // The id pattern `docos-anchor-suggest.<id>` shows up on suggestion
  // discussion threads in observed Docs builds.
  const id = root.id ?? "";
  if (/suggest/i.test(id)) return true;
  return false;
}

function extractKixId(root: Element): string | undefined {
  const id = root.getAttribute("id");
  if (id?.startsWith("docos-anchor-")) {
    return id.slice("docos-anchor-".length);
  }
  const data = root.getAttribute("data-discussion-id");
  if (data) return data;
  const anchored = root.getAttribute("data-anchored-anchor");
  if (anchored) return anchored;
  return undefined;
}

function extractReplies(root: Element): RawReply[] {
  const wrappers = new Set<Element>();
  for (const sel of REPLY_SELECTORS) {
    for (const found of root.querySelectorAll(sel)) {
      const wrapper = found.closest(REPLY_WRAPPER_SELECTOR) ?? found;
      wrappers.add(wrapper);
    }
  }
  const out: RawReply[] = [];
  for (const el of wrappers) {
    const body = pickText(el, BODY_SELECTORS) ?? el.textContent?.trim();
    if (!body) continue;
    const authorDisplayName = pickText(el, AUTHOR_SELECTORS);
    const createdAt =
      pickAttr(el, TIMESTAMP_SELECTORS, "datetime") ??
      pickAttr(el, TIMESTAMP_SELECTORS, "data-tooltip") ??
      pickText(el, TIMESTAMP_SELECTORS);
    out.push({ body, authorDisplayName, createdAt });
  }
  return out;
}

export function scrapeThreads(doc: ParentNode = document): RawThread[] {
  const seen = new Set<Element>();
  const threads: RawThread[] = [];
  for (const sel of THREAD_ROOT_SELECTORS) {
    for (const root of doc.querySelectorAll(sel)) {
      if (seen.has(root)) continue;
      seen.add(root);
      threads.push({
        root,
        kixDiscussionId: extractKixId(root),
        parentQuotedText: pickText(root, QUOTE_SELECTORS),
        isSuggestion: isSuggestionThread(root),
        replies: extractReplies(root),
      });
    }
  }
  return threads;
}

/**
 * Convert raw scraped threads into capture envelopes. We only emit captures
 * for *replies on suggestion threads* — that's the API gap (SPEC §11). The
 * first reply on a suggestion thread is the suggestion's seed comment; we
 * still capture it because the public API doesn't expose it either.
 */
export async function buildCaptures(
  docId: string,
  threads: RawThread[],
): Promise<CaptureInput[]> {
  const out: CaptureInput[] = [];
  for (const t of threads) {
    if (!t.isSuggestion) continue;
    if (t.replies.length === 0) continue;
    for (const r of t.replies) {
      const externalId = await stableReplyId({
        kixDiscussionId: t.kixDiscussionId,
        authorBucket: r.authorDisplayName,
        createdAt: r.createdAt,
        body: r.body,
        parentQuotedText: t.parentQuotedText,
      });
      out.push({
        externalId,
        docId,
        kixDiscussionId: t.kixDiscussionId,
        parentQuotedText: t.parentQuotedText,
        authorDisplayName: r.authorDisplayName,
        createdAt: r.createdAt,
        body: r.body,
      });
    }
  }
  return out;
}
