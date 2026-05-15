/**
 * Inline script for `/api/picker/page`. Loads Google's Picker JS, opens
 * a Doc-only picker, and POSTs the picked file's id to
 * `/api/picker/register-doc` (cookie-authenticated).
 *
 * `setQuery` from the originating docId is intentionally not set:
 * Picker's title tokenizer ANDs whitespace-split tokens, and real Doc
 * titles routinely contain `[brackets]` / `:` / punctuation that defeat
 * it — so a "hint" makes the affordance worse, not better.
 */

export interface PickerScriptInputs {
  apiKey: string;
  projectNumber: string;
  accessToken: string;
}

export function buildPickerScript(v: PickerScriptInputs): string {
  // JSON.stringify produces a JS-safe string literal: it escapes quotes,
  // newlines, and the dangerous `</script>` separators.
  const apiKey = JSON.stringify(v.apiKey);
  const projectNumber = JSON.stringify(v.projectNumber);
  const accessToken = JSON.stringify(v.accessToken);
  return [
    "(function () {",
    `  var apiKey = ${apiKey};`,
    `  var projectNumber = ${projectNumber};`,
    `  var accessToken = ${accessToken};`,
    "  var statusEl = document.getElementById('status');",
    "  function setStatus(text, tone) {",
    "    if (!statusEl) return;",
    "    statusEl.textContent = text;",
    "    if (tone) statusEl.dataset.tone = tone;",
    "    else delete statusEl.dataset.tone;",
    "  }",
    "  function closeSoon() { setTimeout(function () { try { window.close(); } catch (_) {} }, 1500); }",
    "  var deadline = Date.now() + 10000;",
    "  var iv = setInterval(function () {",
    "    if (window.gapi && window.gapi.load) {",
    "      clearInterval(iv);",
    "      window.gapi.load('picker', function () { openPicker(); });",
    "      return;",
    "    }",
    "    if (Date.now() > deadline) {",
    "      clearInterval(iv);",
    "      setStatus('Drive Picker scripts failed to load (apis.google.com blocked?)', 'error');",
    "    }",
    "  }, 100);",
    "  function openPicker() {",
    "    setStatus('Opening Picker…');",
    "    var picker = window.google && window.google.picker;",
    "    if (!picker) { setStatus('Picker namespace not available', 'error'); return; }",
    "    var view = new picker.DocsView(picker.ViewId.DOCUMENTS)",
    "      .setMimeTypes('application/vnd.google-apps.document')",
    "      .setMode(picker.DocsViewMode.LIST);",
    "    var built = new picker.PickerBuilder()",
    "      .setOAuthToken(accessToken)",
    "      .setDeveloperKey(apiKey)",
    "      .setAppId(projectNumber)",
    "      .addView(view)",
    "      .setTitle('Pick a Doc to track with Margin')",
    "      .setCallback(function (data) { onPicked(data); })",
    "      .build();",
    "    built.setVisible(true);",
    "  }",
    "  function onPicked(data) {",
    "    var picker = window.google.picker;",
    "    if (data.action === picker.Action.CANCEL) { setStatus('Cancelled. You can close this tab.'); closeSoon(); return; }",
    "    if (data.action !== picker.Action.PICKED) return;",
    "    var docs = data.docs || [];",
    "    var doc = docs[0];",
    "    if (!doc || !doc.id) { setStatus('No doc selected.', 'error'); return; }",
    "    setStatus('Registering with Margin…');",
    "    register(doc.id, doc.name || '');",
    "  }",
    "  function register(pickedId, _name) {",
    "    fetch('/api/picker/register-doc', {",
    "      method: 'POST',",
    "      credentials: 'include',",
    "      headers: { 'content-type': 'application/json' },",
    "      body: JSON.stringify({ docUrlOrId: pickedId }),",
    "    }).then(function (r) {",
    "      return r.text().then(function (t) {",
    "        var body = null; try { body = t ? JSON.parse(t) : null; } catch (_) {}",
    "        return { ok: r.ok, status: r.status, body: body };",
    "      });",
    "    }).then(function (res) {",
    "      var dup = res.status === 409 && res.body && res.body.error === 'already_exists';",
    "      if (res.ok || dup) {",
    "        setStatus(dup ? 'Doc was already tracked. You can close this tab.' : 'Doc tracked. You can close this tab.');",
    "        closeSoon();",
    "        return;",
    "      }",
    "      var msg = (res.body && (res.body.message || res.body.error)) || ('HTTP ' + res.status);",
    "      setStatus('Could not register doc: ' + msg, 'error');",
    "    }).catch(function (err) {",
    "      setStatus('Network error: ' + (err && err.message ? err.message : String(err)), 'error');",
    "    });",
    "  }",
    "})();",
  ].join("\n");
}
