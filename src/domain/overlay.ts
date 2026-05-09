import { asc, desc, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  derivative,
  overlay,
  overlayOperation,
  type OverlayAnchor,
  type OverlayOpType,
} from "../db/schema.ts";
import { copyFile, getFile } from "../google/drive.ts";
import {
  batchUpdate,
  getDocument,
  op as docsOp,
  type BatchUpdateRequest,
  type Document,
} from "../google/docs.ts";
import { requireProject, tokenProviderForProject } from "./project.ts";
import { requireVersion } from "./version.ts";
import { CLEAN_THRESHOLD, reanchor } from "./reanchor.ts";

export type Overlay = typeof overlay.$inferSelect;
export type OverlayOperation = typeof overlayOperation.$inferSelect;
export type Derivative = typeof derivative.$inferSelect;

export async function createOverlay(opts: {
  projectId: string;
  name: string;
}): Promise<Overlay> {
  await requireProject(opts.projectId);
  const inserted = await db
    .insert(overlay)
    .values({ projectId: opts.projectId, name: opts.name })
    .returning();
  return inserted[0]!;
}

export async function addOverlayOperation(opts: {
  overlayId: string;
  type: OverlayOpType;
  anchor: OverlayAnchor;
  payload?: string;
  confidenceThreshold?: number;
}): Promise<OverlayOperation> {
  await requireOverlay(opts.overlayId);

  const max = await db
    .select({ orderIndex: overlayOperation.orderIndex })
    .from(overlayOperation)
    .where(eq(overlayOperation.overlayId, opts.overlayId))
    .orderBy(desc(overlayOperation.orderIndex))
    .limit(1);
  const orderIndex = (max[0]?.orderIndex ?? -1) + 1;

  const inserted = await db
    .insert(overlayOperation)
    .values({
      overlayId: opts.overlayId,
      orderIndex,
      type: opts.type,
      anchor: opts.anchor,
      payload: opts.payload ?? null,
      confidenceThreshold: opts.confidenceThreshold ?? null,
    })
    .returning();
  return inserted[0]!;
}

export async function getOverlay(id: string): Promise<Overlay | null> {
  const rows = await db.select().from(overlay).where(eq(overlay.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function requireOverlay(id: string): Promise<Overlay> {
  const o = await getOverlay(id);
  if (!o) throw new Error(`overlay ${id} not found`);
  return o;
}

export async function listOverlays(projectId: string): Promise<Overlay[]> {
  return db
    .select()
    .from(overlay)
    .where(eq(overlay.projectId, projectId))
    .orderBy(desc(overlay.createdAt));
}

export async function listOverlayOperations(overlayId: string): Promise<OverlayOperation[]> {
  return db
    .select()
    .from(overlayOperation)
    .where(eq(overlayOperation.overlayId, overlayId))
    .orderBy(asc(overlayOperation.orderIndex));
}

export interface PlannedOp {
  op: OverlayOperation;
  /** batchUpdate requests this op will issue, in order. Empty if skipped. */
  requests: BatchUpdateRequest[];
  /** Reanchoring confidence (0–100). Append ops report 100 since they don't anchor. */
  confidence: number;
  status: "clean" | "fuzzy" | "orphaned" | "skipped";
  reason?: string;
}

export interface OverlayPlan {
  overlayId: string;
  ops: PlannedOp[];
  /** True iff at least one op was below threshold and got skipped. */
  hasSkipped: boolean;
}

/**
 * Resolve every op in the overlay against `doc`. Pure: runs no API calls. Returns the
 * batchUpdate requests we'd issue plus per-op match info so callers can preview before
 * applying. Ops below threshold are returned with status="skipped" and empty requests.
 */
export function planOverlay(
  ops: OverlayOperation[],
  doc: Document,
): OverlayPlan {
  const planned: PlannedOp[] = ops.map((o) => translateOp(o, doc));
  return {
    overlayId: ops[0]?.overlayId ?? "",
    ops: planned,
    hasSkipped: planned.some((p) => p.status === "skipped"),
  };
}

function translateOp(o: OverlayOperation, doc: Document): PlannedOp {
  const threshold = o.confidenceThreshold ?? CLEAN_THRESHOLD;

  if (o.type === "append") {
    const idx = endOfBodyIndex(doc);
    const text = o.payload ?? "";
    if (!text) {
      return { op: o, requests: [], confidence: 0, status: "skipped", reason: "empty payload" };
    }
    return {
      op: o,
      requests: [docsOp.insertText(text, idx)],
      confidence: 100,
      status: "clean",
    };
  }

  const anchorResult = reanchor(doc, o.anchor);
  if (anchorResult.confidence < threshold || !anchorResult.paragraph) {
    return {
      op: o,
      requests: [],
      confidence: anchorResult.confidence,
      status: "skipped",
      reason:
        anchorResult.status === "orphaned"
          ? "anchor not found in target"
          : `confidence ${anchorResult.confidence} < threshold ${threshold}`,
    };
  }

  const docCoord =
    anchorResult.paragraph.startIndex +
    (anchorResult.anchor.structuralPosition?.offset ?? 0);
  const matchLen = o.anchor.quotedText.length;

  switch (o.type) {
    case "redact": {
      const requests: BatchUpdateRequest[] = [
        docsOp.deleteContentRange(docCoord, docCoord + matchLen),
      ];
      if (o.payload) requests.push(docsOp.insertText(o.payload, docCoord));
      return { op: o, requests, confidence: anchorResult.confidence, status: anchorResult.status };
    }
    case "replace": {
      const replacement = o.payload ?? "";
      const requests: BatchUpdateRequest[] = [
        docsOp.deleteContentRange(docCoord, docCoord + matchLen),
      ];
      if (replacement) requests.push(docsOp.insertText(replacement, docCoord));
      return { op: o, requests, confidence: anchorResult.confidence, status: anchorResult.status };
    }
    case "insert": {
      const text = o.payload ?? "";
      if (!text) {
        return { op: o, requests: [], confidence: anchorResult.confidence, status: "skipped", reason: "empty payload" };
      }
      return {
        op: o,
        requests: [docsOp.insertText(text, docCoord + matchLen)],
        confidence: anchorResult.confidence,
        status: anchorResult.status,
      };
    }
    default:
      return {
        op: o,
        requests: [],
        confidence: 0,
        status: "skipped",
        reason: `unknown op type ${o.type satisfies never}`,
      };
  }
}

/**
 * batchUpdate index just before the body's trailing paragraph break — the natural place
 * to "append" content. Falls back to 1 (the start of the doc) for empty docs.
 */
export function endOfBodyIndex(doc: Document): number {
  const content = doc.body?.content ?? [];
  const last = content[content.length - 1];
  const end = last?.endIndex ?? 1;
  return Math.max(1, end - 1);
}

/**
 * Flatten an OverlayPlan into a single batchUpdate-ready request list. Sorts requests by
 * descending location index so applying earlier requests doesn't invalidate the indices
 * of later ones. Skipped ops contribute nothing.
 */
export function flattenPlan(plan: OverlayPlan): BatchUpdateRequest[] {
  const tagged: { req: BatchUpdateRequest; primary: number; subOrder: number }[] = [];
  for (const p of plan.ops) {
    p.requests.forEach((req, i) => {
      tagged.push({ req, primary: primaryIndex(req), subOrder: i });
    });
  }
  // Highest primary index first; within a single op (same op, same primary), preserve order.
  tagged.sort((a, b) => {
    if (b.primary !== a.primary) return b.primary - a.primary;
    return a.subOrder - b.subOrder;
  });
  return tagged.map((t) => t.req);
}

function primaryIndex(req: BatchUpdateRequest): number {
  const r = req as Record<string, Record<string, unknown>>;
  if (r.insertText) {
    const loc = (r.insertText as { location?: { index?: number } }).location;
    return loc?.index ?? 0;
  }
  if (r.deleteContentRange) {
    const range = (r.deleteContentRange as { range?: { startIndex?: number } }).range;
    return range?.startIndex ?? 0;
  }
  return 0;
}

export interface ApplyOverlayResult {
  derivative: Derivative;
  plan: OverlayPlan;
  requestsApplied: number;
}

/**
 * Build a derivative: copy the source version's doc, apply the overlay, record the row.
 * Ops below threshold are skipped (per SPEC §5: "surfaced for review rather than silently
 * skipped" — the caller gets `plan` back to inspect).
 */
export async function applyOverlayAsDerivative(opts: {
  overlayId: string;
  sourceVersionId: string;
  audienceLabel?: string;
}): Promise<ApplyOverlayResult> {
  const ov = await requireOverlay(opts.overlayId);
  const ver = await requireVersion(opts.sourceVersionId);
  if (ver.projectId !== ov.projectId) {
    throw new Error(
      `overlay ${ov.id} (project ${ov.projectId}) cannot apply to version ${ver.id} (project ${ver.projectId})`,
    );
  }

  const tp = await tokenProviderForProject(ov.projectId);
  const ops = await listOverlayOperations(ov.id);

  const sourceFile = await getFile(tp, ver.googleDocId, { fields: "id,name" });
  const audience = opts.audienceLabel ?? ov.name;
  const copy = await copyFile(tp, ver.googleDocId, {
    name: `[${audience}] ${sourceFile.name}`,
  });

  const doc = await getDocument(tp, copy.id);
  const plan = planOverlay(ops, doc);
  const requests = flattenPlan(plan);

  if (requests.length > 0) {
    await batchUpdate(tp, copy.id, requests);
  }

  const inserted = await db
    .insert(derivative)
    .values({
      projectId: ov.projectId,
      versionId: ver.id,
      overlayId: ov.id,
      googleDocId: copy.id,
      audienceLabel: opts.audienceLabel ?? null,
    })
    .returning();

  return { derivative: inserted[0]!, plan, requestsApplied: requests.length };
}

export async function listDerivatives(projectId: string): Promise<Derivative[]> {
  return db
    .select()
    .from(derivative)
    .where(eq(derivative.projectId, projectId))
    .orderBy(desc(derivative.createdAt));
}
