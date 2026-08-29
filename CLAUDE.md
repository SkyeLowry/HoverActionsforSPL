# CLAUDE.md — Hover Actions for SPL

Chrome extension (Manifest V3) adding hover popups, a lookup clause builder,
and copy-to-clipboard icons to Splunk Web. Plain JavaScript, no build step,
no dependencies, no framework. If you're about to add a bundler, transpiler,
or npm — stop; it's deliberate that `git clone` + Load unpacked works as-is.

## Architecture

Four scripts, strict separation:

- **`background.js`** (service worker) — the extension ships with ZERO host
  permissions. Users add Splunk domains on the options page; this worker
  registers/unregisters the content scripts dynamically
  (`chrome.scripting.registerContentScripts`, ids `hasp-agent` /
  `hasp-content`) for exactly the granted origins. It reconciles on install,
  browser startup, and `storage.onChanged` for the `domains` key. Skips
  domains whose permission was revoked out-of-band.
- **`page-agent.js`** (MAIN world) — the only code that touches the Ace
  editor. Gets the instance via `el.env.editor` on `.ace_editor` elements,
  converts mouse position to logical document coordinates with
  `editor.renderer.screenToTextCoordinates()`, tokenizes lines for macros /
  `inputlookup` / `outputlookup` / `lookup` clauses, and applies clause
  rewrites via `session.replace()`.
- **`content.js`** (isolated world) — popup UI, all REST calls, clipboard,
  copy-icon decorators, settings. Never touches Ace directly.
- **`options.html` / `options.js`** — feature toggles + domain management
  (runtime `chrome.permissions.request` per domain).

### Cross-world message protocol (window.postMessage, same window)

- page → content, `source: "ssh"`: `hover` (token + row + x/y), `clear`,
  `editor-leave`, `replace-done`, `replace-failed`
- content → page, `source: "ssh-x"`: `replace` (row, start, end, oldText,
  text)

The distinct source strings prevent echo loops. The replace handler verifies
`line.slice(start, end) === oldText` before editing — never remove this
stale-text guard.

### Naming

- CSS classes and popup DOM: `ssh-` prefix; popup element id `ssh-popup`.
- Dynamic script ids and worker logs: `hasp-` / `[HASP]`.
- Content-script diagnostics: `[SSH]` prefix, `console.log` (not `.debug` —
  hidden by default console levels; that cost us a debugging round once).

## Verified environment facts — do not re-guess these

These were established by trial against a live Splunk Cloud stack (10.4.x).
Treat them as ground truth; when they fail on a *different* stack, prefer
fallback chains over changing the primary.

1. **REST reads** go through `${LOCALE}/splunkd/__raw/servicesNS/-/-/...`
   with the user's session cookie. `LOCALE` (e.g. `/en-GB`) is derived from
   `location.pathname` — never hardcode it.
2. **Macro manager edit URL** is
   `/manager/launcher/data/macros/<name>?action=edit&ns=<app>&uri=<enc(/servicesNS/<owner>/<app>/data/macros/<name>)>`.
   NOT `admin/macros` (that's only the REST read path), and the manager
   path's app segment must be a *visible* app (`launcher`), never the owning
   app — invisible SA-*/TA-* apps 404 the whole manager route. Macro REST
   names are `name(argcount)` for macros with arguments; percent-encode the
   parens.
3. **Lookup File Editor's REST handler is blocked on Splunk Cloud**: both
   `services/data/lookup_edit/lookup_contents` and
   `servicesNS/nobody/lookup_editor/data/lookup_edit/lookup_contents` 404
   through `__raw`, even though the app's *pages* work. The
   `lookupContentsDead` flag stops retrying after one failed round per page.
   Any future feature needing lookup contents must ride the export path.
4. **`search/jobs/export` rejects GET (405) on this stack.** POST with body
   params and headers `X-Splunk-Form-Key: <value of splunkweb_csrf_token_*
   cookie>` + `X-Requested-With: XMLHttpRequest`. The CSRF cookie is not
   httpOnly by design. GETs to REST endpoints need no CSRF.
5. **`inputlookup` accepts definition names as well as filenames** — that's
   how definition sampling (including KV store) works.
6. **Transforms edit URL** pattern (verified working):
   `/manager/launcher/data/transforms/lookups/<name>?action=edit&uri=<enc(/servicesNS/<owner>/<app>/data/transforms/lookups/<name>)>`.

## Splunk Web DOM facts

- **Search bar is Ace.** Macro names, lookup filenames, and definition names
  are BARE TEXT NODES in `.ace_line`, not token spans — only
  commands/modifiers/pipes get spans. Never build hover detection on token
  spans; use the editor coordinate APIs.
- **Soft wrap** splits one logical line across multiple `.ace_line` divs in
  one `.ace_line_group`, with fake `&nbsp;` wrap-indent on continuation
  lines. Logical `session.getLine(row)` sidesteps all of it.
- **Statistics/dashboard table headers**: `th[data-sort-key]`; Splunk's
  paintbrush button pattern (`suppress-sort` class + stopPropagation) is how
  our copy button avoids triggering sorts.
- **Events table (View: Table) headers**: `th.reorderable[data-name]`
  (plus `th.col-time` for `_time`, aria-label only). These are jQuery-UI
  drag handles — the copy button must stopPropagation on `mousedown` or it
  starts a column drag. The drag-grip dots are a `::before` welded to
  `.reorderable-label`; you cannot place anything between the dots and the
  label text.
- **Field info dialog**: name in `h2.field-info-header`; values in
  `table.table-field-values td.value a[data-value]` — `data-value` holds the
  raw (untruncated) value; copy from it, not display text.
- All decorators are idempotent and re-applied by one MutationObserver pass
  coalesced with requestAnimationFrame (`decorateAll`). Splunk re-renders
  these surfaces constantly.

## Settings

`chrome.storage.sync`, applied live via `onChanged` (no reload). Keys:
`hoverMacros`, `hoverLookups`, `lookupSamples`, `copyStatHeaders`,
`copyEventHeaders`, `copyFieldDialog`, `domains` (array of granted hosts).

`lookupSamples` is the ONLY feature that dispatches searches (oneshot
`| inputlookup … | head 1` exports) under the user's account. Anything new
that dispatches a search must be gated behind it or its own toggle — the
"passive read-only mode" promise is part of the store listing and privacy
policy. Settings never reach `page-agent.js`; the content script drops
disabled hover kinds on receipt.

## Hover popup behavior

- Grace corridor: popup stays open while the pointer is within 40 px of the
  popup rect or 56 px of the hover anchor, or while any popup control has
  focus (`inCorridor()`). `clear` messages are ignored inside the corridor.
  This is load-bearing; naive hide-on-mouseout made the popup unreachable.
- Builder (on `| lookup` hovers) vs explorer (on `inputlookup`/`outputlookup`
  hovers) share delegated handlers via common classes (`.ssh-m-field`,
  `.ssh-m-sample`, `.ssh-o-sample`). The explorer has no Apply and no clause
  context.
- Live preview uses `| search` semantics (case-insensitive, wildcards) —
  deliberately looser than runtime lookup matching; don't "fix" that without
  a UI cue.
- Sample cells and field chips are click-to-copy with a ~900 ms green flash.

## Conventions

- **Bump `manifest.json` version on every functional change** and add a line
  to the README version history. Cosmetic-only changes can ride patch bumps.
- Validate with `node --check content.js page-agent.js background.js
  options.js` and `python3 -c "import json; json.load(open('manifest.json'))"`.
  That's the whole CI.
- Ship org-neutral language only: no employer names, no internal lookup
  filenames, no domain-specific PII terms (e.g. banking identifiers) in any
  shipped file or doc. Generic examples: `assets.csv`, `users.csv`,
  `http_status.csv`.
- Never echo secrets or real data values into docs/examples; screenshots for
  the store use the `http_status.csv` fixture (see README/store notes).
- Keep `PRIVACY.md` truthful against the code: no external hosts, no
  telemetry, optional user-granted host access. If a change would violate a
  sentence in PRIVACY.md, the change is wrong or PRIVACY.md must be updated
  first — in that order of preference.
- Distribution: `zip -r hover-actions-for-spl.zip <folder>`; `.gitignore`
  already excludes zips. `icons/icon-master.png` is the art source; sizes
  are Lanczos downscales from it.

## Testing

Manual, against a live Splunk stack added via the options page. Standard
smoke pass after changes:

1. Add domain on options page → reload Splunk tab.
2. Hover a macro → definition popup → Open definition link resolves.
3. Hover `| lookup <file.csv>` → builder with fields + samples → type a
   value in "try a value…" → preview updates → Apply → clause rewritten →
   edit the line, re-open stale popup, Apply → refused with message.
4. Hover an `inputlookup` → explorer table.
5. Copy icons: stats header, events header (confirm column drag still
   works), field dialog name + value, sample cell.
6. Toggle each option off/on and confirm live application.

## Known limitations (intentional, don't "fix" silently)

- Lookup clauses spanning a hard newline parse only the hovered logical
  line.
- Apply rewrites SPL but does not re-run the search.
- Definition field lists prefer `fields_list` (the declaration) over file
  contents; declared-vs-actual drift is a known candidate feature, not a bug.
- Multi-app same-name lookups fetch one sample, not per-app.
- Nested macros display verbatim; no recursive expansion.
