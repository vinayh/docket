/**
 * Split a user-typed reviewer-emails textarea into a trimmed, de-empty list.
 * Used by the Settings view (one-per-line input) and the Dashboard's
 * Request-review inline form (comma/semicolon input). Permissive on
 * delimiter so either UX maps to the same parse — backend re-validates
 * email syntax with valibot, this is just the split.
 */
export function parseEmails(raw: string): string[] {
  return raw
    .split(/[,;\s\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
