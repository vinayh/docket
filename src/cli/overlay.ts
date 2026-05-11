import { parseArgs } from "node:util";
import {
  addOverlayOperation,
  applyOverlayAsDerivative,
  createOverlay,
  listDerivatives,
  listOverlayOperations,
  listOverlays,
} from "../domain/overlay.ts";
import type { OverlayOpType } from "../db/schema.ts";
import { usage, dispatchSubcommands } from "./util.ts";

const USAGE = `\
usage:
  bun margin overlay create <project-id> --name <name>
  bun margin overlay list <project-id>
  bun margin overlay add-op <overlay-id> --type <redact|replace|insert|append>
                                          [--quoted <text>] [--payload <text>]
                                          [--threshold <0-100>]
  bun margin overlay ops <overlay-id>
  bun margin overlay apply <overlay-id> --version <source-version-id>
                                         [--audience <label>]
  bun margin derivative list <project-id>`;

const VALID_OPS: OverlayOpType[] = ["redact", "replace", "insert", "append"];

export const run = (args: string[]) =>
  dispatchSubcommands(args, USAGE, {
    create: async (rest) => {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { name: { type: "string" } },
        allowPositionals: true,
      });
      const projectId = positionals[0];
      if (!projectId || !values.name) usage(USAGE);
      const o = await createOverlay({ projectId, name: values.name });
      console.log(`✓ created overlay ${o.id} (name="${o.name}")`);
    },

    list: async ([projectId]) => {
      if (!projectId) usage(USAGE);
      const overlays = await listOverlays(projectId);
      if (overlays.length === 0) {
        console.log("no overlays.");
        return;
      }
      for (const o of overlays) {
        console.log(`${o.id}  name="${o.name}"  ${o.createdAt.toISOString()}`);
      }
    },

    "add-op": async (rest) => {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          type: { type: "string" },
          quoted: { type: "string" },
          payload: { type: "string" },
          threshold: { type: "string" },
        },
        allowPositionals: true,
      });
      const overlayId = positionals[0];
      if (!overlayId || !values.type) usage(USAGE);
      if (!VALID_OPS.includes(values.type as OverlayOpType)) {
        usage(`invalid --type: ${values.type} (one of ${VALID_OPS.join(", ")})`);
      }
      const type = values.type as OverlayOpType;
      if (type !== "append" && !values.quoted) {
        usage(`--quoted is required for ${type} ops`);
      }
      const threshold = values.threshold ? Number(values.threshold) : undefined;
      if (
        threshold !== undefined &&
        (Number.isNaN(threshold) || threshold < 0 || threshold > 100)
      ) {
        usage(`--threshold must be 0–100, got ${values.threshold}`);
      }

      const op = await addOverlayOperation({
        overlayId,
        type,
        anchor: { quotedText: values.quoted ?? "" },
        ...(values.payload !== undefined ? { payload: values.payload } : {}),
        ...(threshold !== undefined ? { confidenceThreshold: threshold } : {}),
      });
      console.log(`✓ added op #${op.orderIndex} (${op.type}) id=${op.id}`);
    },

    ops: async ([overlayId]) => {
      if (!overlayId) usage(USAGE);
      const ops = await listOverlayOperations(overlayId);
      if (ops.length === 0) {
        console.log("no operations.");
        return;
      }
      for (const op of ops) {
        const quoted = op.anchor.quotedText
          ? `"${op.anchor.quotedText.slice(0, 40)}"`
          : "(none)";
        const payload = op.payload ? `→ "${op.payload.slice(0, 40)}"` : "";
        const threshold =
          op.confidenceThreshold !== null ? ` [≥${op.confidenceThreshold}]` : "";
        console.log(`#${op.orderIndex}  ${op.type.padEnd(8)} ${quoted} ${payload}${threshold}`);
      }
    },

    apply: async (rest) => {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          version: { type: "string" },
          audience: { type: "string" },
        },
        allowPositionals: true,
      });
      const overlayId = positionals[0];
      if (!overlayId || !values.version) usage(USAGE);

      const r = await applyOverlayAsDerivative({
        overlayId,
        sourceVersionId: values.version,
        ...(values.audience !== undefined ? { audienceLabel: values.audience } : {}),
      });
      console.log(`✓ created derivative ${r.derivative.id}`);
      console.log(`  google_doc_id: ${r.derivative.googleDocId}`);
      console.log(`  source version: ${r.derivative.versionId}`);
      console.log(`  requests applied: ${r.requestsApplied}`);
      for (const p of r.plan.ops) {
        const status =
          p.status === "skipped"
            ? `skipped (${p.reason})`
            : `${p.status} (${p.confidence})`;
        console.log(`  #${p.op.orderIndex} ${p.op.type.padEnd(8)} → ${status}`);
      }
    },
  });

const DERIVATIVE_USAGE = "usage: bun margin derivative list <project-id>";

export const runDerivative = (args: string[]) =>
  dispatchSubcommands(args, DERIVATIVE_USAGE, {
    list: async ([projectId]) => {
      if (!projectId) usage(DERIVATIVE_USAGE);
      const derivatives = await listDerivatives(projectId);
      if (derivatives.length === 0) {
        console.log("no derivatives.");
        return;
      }
      for (const d of derivatives) {
        const audience = d.audienceLabel ? `audience="${d.audienceLabel}"` : "";
        console.log(
          `${d.id}  doc=${d.googleDocId}  src_version=${d.versionId.slice(0, 8)}  overlay=${d.overlayId.slice(0, 8)} ${audience}  ${d.createdAt.toISOString()}`,
        );
      }
    },
  });
