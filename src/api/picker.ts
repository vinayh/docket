/**
 * Drive Picker host page. Loaded by the user from a "pick a doc" affordance
 * (Slack onboarding, extension popup, etc.). The Picker iframe runs entirely
 * in Google's origin; once the user selects a file, Google calls back into
 * this page with a `pickerCallback` and we POST the doc id back to the
 * Docket backend, which gives the OAuth client per-file `drive.file` access
 * (SPEC §9.2).
 *
 * For now this is a static HTML stub. Phase-2 follow-ups: take an API token
 * via query string + post the picked doc to a typed endpoint that registers
 * a project. Until then the page demonstrates the entry point.
 */
const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Docket — pick a Google Doc</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { font: 14px/1.4 system-ui, sans-serif; max-width: 560px; margin: 4rem auto; color: #1f2328; }
    button { font: inherit; padding: 0.5rem 1rem; cursor: pointer; }
    code { background: #f1f1f1; padding: 0.1rem 0.3rem; border-radius: 3px; }
    .err { color: #b00; }
  </style>
</head>
<body>
  <h1>Pick a Google Doc to authorize with Docket</h1>
  <p>This grants the Docket OAuth client <code>drive.file</code> access to the
  doc you select — see SPEC §9.2.</p>
  <p><em>Drive Picker integration is a Phase-2 stub.</em> Wire your client id
  and developer key here, then mount Google's Picker iframe.</p>
  <button id="open" disabled>Open Drive Picker</button>
  <p id="status"></p>
  <script>
    const btn = document.getElementById('open');
    const status = document.getElementById('status');
    status.textContent = 'Picker UI not configured yet — see src/api/picker.ts';
  </script>
</body>
</html>
`;

export function handlePickerHost(_req: Request): Response {
  return new Response(HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
