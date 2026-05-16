import { useEffect, useState } from "preact/hooks";
import { sendMessage } from "../../../ui/sendMessage.ts";
import { parseEmails } from "../../../utils/emails.ts";
import type { ProjectSettingsView } from "../../../utils/types.ts";

interface Props {
  projectId: string;
  onClose: () => void;
}

type State =
  | { kind: "loading" }
  | { kind: "loaded"; settings: ProjectSettingsView }
  | { kind: "error"; message: string };

/**
 * Side-panel "Settings" view (SPEC §12 Phase 4 — notification prefs, default
 * reviewers, Slack workspace linking). Settings live on `project.settings`
 * and are mediated by `/api/extension/settings` through the SW. Save sends
 * a `patch` shaped like the diff between the current form state and the
 * last-loaded server state; missing keys keep their stored value.
 */
export function Settings({ projectId, onClose }: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<ProjectSettingsView | null>(null);
  // The reviewer-emails textarea is stored as the raw string the user typed,
  // not the parsed list — round-tripping through `parseEmails` on every
  // keystroke discards empty lines, so the user can't press Enter to start a
  // new email. Parsing happens once at save time.
  const [reviewerEmailsRaw, setReviewerEmailsRaw] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await sendMessage({ kind: "settings/load", projectId });
        if (cancelled) return;
        if (r?.kind !== "settings/load") {
          setState({ kind: "error", message: "unexpected response" });
          return;
        }
        if (r.error) {
          setState({ kind: "error", message: r.error });
          return;
        }
        if (!r.settings) {
          setState({ kind: "error", message: "settings unavailable" });
          return;
        }
        setState({ kind: "loaded", settings: r.settings });
        setForm(r.settings);
        setReviewerEmailsRaw(r.settings.defaultReviewerEmails.join("\n"));
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function onSave(): Promise<void> {
    if (state.kind !== "loaded" || !form) return;
    setError(null);
    setSaving(true);
    try {
      const next: ProjectSettingsView = {
        ...form,
        defaultReviewerEmails: parseEmails(reviewerEmailsRaw),
      };
      const patch = diffSettings(state.settings, next);
      if (Object.keys(patch).length === 0) {
        setSaving(false);
        return;
      }
      const r = await sendMessage({ kind: "settings/update", projectId, patch });
      if (r?.kind !== "settings/update") throw new Error("unexpected response");
      if (r.error) throw new Error(r.error);
      if (!r.settings) throw new Error("no settings returned");
      setState({ kind: "loaded", settings: r.settings });
      setForm(r.settings);
      setReviewerEmailsRaw(r.settings.defaultReviewerEmails.join("\n"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <section class="settings-view">
        <SettingsHeader onClose={onClose} />
        <p class="muted">Loading…</p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section class="settings-view">
        <SettingsHeader onClose={onClose} />
        <p class="muted error">{state.message}</p>
      </section>
    );
  }
  if (!form) return null;

  const formWithParsedEmails: ProjectSettingsView = {
    ...form,
    defaultReviewerEmails: parseEmails(reviewerEmailsRaw),
  };
  const dirty = Object.keys(diffSettings(state.settings, formWithParsedEmails)).length > 0;

  return (
    <section class="settings-view">
      <SettingsHeader onClose={onClose} />
      <div class="settings-form">
        <label class="settings-toggle">
          <input
            type="checkbox"
            checked={form.notifyOnComment}
            onChange={(ev) =>
              setForm({
                ...form,
                notifyOnComment: (ev.currentTarget as HTMLInputElement).checked,
              })
            }
          />
          Notify me when a new comment arrives
        </label>
        <label class="settings-toggle">
          <input
            type="checkbox"
            checked={form.notifyOnReviewComplete}
            onChange={(ev) =>
              setForm({
                ...form,
                notifyOnReviewComplete: (ev.currentTarget as HTMLInputElement).checked,
              })
            }
          />
          Notify me when a review request finishes
        </label>

        <div class="settings-field">
          <label for="defaultReviewerEmails">Default reviewer emails</label>
          <textarea
            id="defaultReviewerEmails"
            value={reviewerEmailsRaw}
            onInput={(ev) =>
              setReviewerEmailsRaw((ev.currentTarget as HTMLTextAreaElement).value)
            }
          />
          <small>One email per line. Pre-fills new review requests.</small>
        </div>

        <div class="settings-field">
          <label for="slackWorkspaceRef">Slack workspace</label>
          <input
            id="slackWorkspaceRef"
            type="text"
            placeholder="team-id (Phase 5 will populate this automatically)"
            value={form.slackWorkspaceRef ?? ""}
            onInput={(ev) =>
              setForm({
                ...form,
                slackWorkspaceRef:
                  ((ev.currentTarget as HTMLInputElement).value || "").trim() || null,
              })
            }
          />
          <small>
            Links this project to a Slack workspace. Margin's Slack bot ships in Phase 5;
            for now this is a free-form identifier.
          </small>
        </div>

        {error ? <p class="muted error">{error}</p> : null}

        <div class="settings-actions">
          <button
            type="button"
            class="primary"
            disabled={saving || !dirty}
            onClick={() => void onSave()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            disabled={saving || !dirty}
            onClick={() => {
              setForm(state.settings);
              setReviewerEmailsRaw(state.settings.defaultReviewerEmails.join("\n"));
            }}
          >
            Reset
          </button>
        </div>
      </div>
    </section>
  );
}

function SettingsHeader({ onClose }: { onClose: () => void }) {
  return (
    <div class="settings-header">
      <p class="title">Settings</p>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

function diffSettings(
  base: ProjectSettingsView,
  next: ProjectSettingsView,
): Partial<ProjectSettingsView> {
  const out: Partial<ProjectSettingsView> = {};
  if (base.notifyOnComment !== next.notifyOnComment) {
    out.notifyOnComment = next.notifyOnComment;
  }
  if (base.notifyOnReviewComplete !== next.notifyOnReviewComplete) {
    out.notifyOnReviewComplete = next.notifyOnReviewComplete;
  }
  if (!sameStrings(base.defaultReviewerEmails, next.defaultReviewerEmails)) {
    out.defaultReviewerEmails = next.defaultReviewerEmails;
  }
  if ((base.slackWorkspaceRef ?? null) !== (next.slackWorkspaceRef ?? null)) {
    out.slackWorkspaceRef = next.slackWorkspaceRef;
  }
  if ((base.defaultOverlayId ?? null) !== (next.defaultOverlayId ?? null)) {
    out.defaultOverlayId = next.defaultOverlayId;
  }
  return out;
}

function sameStrings(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
