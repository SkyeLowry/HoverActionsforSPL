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
  (runtime `chrome.permissions.request` per domain). A domain may be a
  wildcard (`*.splunkcloud.com`), which is the only wildcard Chrome match
  patterns accept and covers the bare domain as well as its subdomains.
  `HOST_RE` demands two labels, so `*.com` can't be entered; `coveredBy()`
  stops a host being added that an existing wildcard already grants.

### Cross-world message protocol (window.postMessage, same window)

- page → content, `source: "ssh"`: `hover` (token + row + x/y), `clear`,
  `editor-leave`, `replace-done`, `replace-failed`
- content → page, `source: "ssh-x"`: `replace` (row, start, end, oldText,
  text)

The distinct source strings prevent echo loops. The replace handler verifies
`line.slice(start, end) === oldText` before editing — never remove this
stale-text guard.

### Macro expansion

`MACRO_RE` and `splitMacroArgs` exist in BOTH `page-agent.js` and
`content.js`. That duplication is deliberate — the agent runs in the MAIN
world and there is no module system to share through — but the two must stay
in sync on what a macro call looks like. Splunk strips quotes from a quoted
argument before substituting it, so `unquote()` runs before `$name$`
replacement. Two variants exist: `substituteArgs` returns plain text (for the
clipboard and for recursive expansion) and `substituteArgsHtml` returns
ESCAPED HTML with each substituted value wrapped in `span.ssh-sub` — never
escape its output again.

### Theming

The popup's colours are CSS custom properties on `#ssh-popup`, overridden by
`#ssh-popup.ssh-dark`. `content.js` sets that class from the *luminance of the
page's own background* (`isDarkPage()`), sampled per hover — Splunk's themes
carry no stable class or attribute to key off, and `prefers-color-scheme` is
the OS setting, not Splunk's. Decorators that live on Splunk's own surfaces
(`.ssh-copy-inline`, `.ssh-copy-value`) use `color: inherit` for the same
reason. Never hardcode a colour inside a `#ssh-popup` rule.

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
2. **Macro REST reads need a fallback chain.** `admin/macros/<name>` resolves
   most macros but 404s for some (observed with an app-scoped, owner-nobody
   macro in the `search` app that the manager UI lists happily). Try, in
   order: `data/macros?search=<base name>` filtered to an exact `name` match,
   then `data/macros/<name>`, then `admin/macros/<name>`. The collection
   query leads because it resolves app-scoped macros AND a miss returns 200
   with no entries instead of a 404 the browser logs as a console error. Its
   search term must be the name WITHOUT the `(argcount)` suffix — parens
   aren't valid in a search expression — so always re-match the full REST
   name against `entry[].name`. Never "fix" this by dropping a path —
   different stacks fail differently.
   `resolveMacro` logs the tried paths and statuses under `[SSH]` when all
   three miss.
3. **Macro manager edit URL** is
   `/manager/launcher/data/macros/<name>?action=edit&ns=<app>&uri=<enc(/servicesNS/<owner>/<app>/data/macros/<name>)>`.
   NOT `admin/macros` (that's only the REST read path), and the manager
   path's app segment must be a *visible* app (`launcher`), never the owning
   app — invisible SA-*/TA-* apps 404 the whole manager route. Macro REST
   names are `name(argcount)` for macros with arguments; percent-encode the
   parens.
4. **Lookup File Editor's REST handler is blocked on Splunk Cloud**: both
   `services/data/lookup_edit/lookup_contents` and
   `servicesNS/nobody/lookup_editor/data/lookup_edit/lookup_contents` 404
   through `__raw`, even though the app's *pages* work. The
   `lookupContentsDead` flag stops retrying after one failed round per page.
   Any future feature needing lookup contents must ride the export path.
5. **`search/jobs/export` rejects GET (405) on this stack.** POST with body
   params and headers `X-Splunk-Form-Key: <value of splunkweb_csrf_token_*
   cookie>` + `X-Requested-With: XMLHttpRequest`. The CSRF cookie is not
   httpOnly by design. GETs to REST endpoints need no CSRF.
6. **`inputlookup` accepts definition names as well as filenames** — that's
   how definition sampling (including KV store) works.
7. **Transforms edit URL** pattern (verified working):
   `/manager/launcher/data/transforms/lookups/<name>?action=edit&uri=<enc(/servicesNS/<owner>/<app>/data/transforms/lookups/<name>)>`.

## Splunk Web DOM facts

- **Search bar is Ace.** Macro names, lookup filenames, and definition names
  are BARE TEXT NODES in `.ace_line`, not token spans — only
  commands/modifiers/pipes get spans. Never build hover detection on token
  spans; use the editor coordinate APIs.
- **Soft wrap** splits one logical line across multiple `.ace_line` divs in
  one `.ace_line_group`, with fake `&nbsp;` wrap-indent on continuation
  lines. Logical `session.getLine(row)` sidesteps all of it.
- **Statistics/dashboard table headers**: `th[data-sort-key]`. No icon is
  injected here — the header's own label text node is wrapped in
  `span.ssh-hdr` and that span is the copy target, so the header never gains
  width or reflows on hover. The sort is bound to the header, so the span
  stops both `mousedown` and `click`; the arrows and paintbrush keep working.
  Wrapping is idempotent (the walker bails on nodes already inside
  `.ssh-hdr`) and reversible (`undecorateHeaders`).
- **Events table (View: Table) headers**: `th.reorderable[data-name]`
  (plus `th.col-time` for `_time`, aria-label only). Same label-wrap copy
  affordance as the Statistics headers, with one difference: these are
  jQuery-UI drag handles, so `mousedown` must NOT be stopped — only the
  click is — or column reordering can no longer start from the field name.
  (A completed drag suppresses the click, so the two don't collide.) The
  drag-grip dots are a `::before` welded to `.reorderable-label`, which is
  block-level and fills the cell; anything appended after it wraps to a
  second line, which is one reason nothing is appended here.
- **Expanded event field table** (Type | Field | Value | Actions): the
  Actions dropdown is built lazily into a body-level popdown, so it cannot be
  decorated like a table cell — the click is caught in the capture phase, the
  row's value stashed, and the item injected into whichever `.dropdown-menu`
  becomes visible. The Type cell uses `rowspan`, so the value cell is found as
  the one *before* Actions, never by column index.
- **Two table shapes open a cell menu**, and the field name lives in a
  different place in each. In a RESULTS table the clicked cell is the value
  and its column header names the field (`headerField()`); every cell is
  clickable. Match cell to header by the column's LEFT EDGE, never by
  `cellIndex`: the leading info/expand column's header is not a `<th>`, so
  indexing a `th` list by the body cell's position shifts every field one
  column to the right. In the EXPANDED-EVENT table (Type | Field | Value | Actions)
  only the last cell opens a menu and the field is a sibling cell. Reading
  one as the other picks up the neighbouring column — that is how a
  sourcetype cell once offered `Copy Spruce="unifi:syslog"`. `cellContext()`
  is the single place that decides, and `headerField()` returning null is the
  discriminator.
- **The Statistics drilldown popup is NOT a `.dropdown-menu`** (the events
  table's is). `injectMenuItem` therefore falls back to locating it by the
  `field = value` text it contains — the same content-matching trick
  `decoratePair` uses — then climbs to the ancestor holding the popup's own
  action links. Entries appended there are `<div>`, not `<li>`, and need
  their own menu-row styling (`div.ssh-menu-item > a`).
- **Cell drilldown popup**: no stable class to hook. It is found by matching
  the exact `<field> = <value>` text the clicked cell produced — the cell
  holds the value alone and the header the field alone, so a text node of
  that shape belongs to the popup. Both halves are wrapped in `span.ssh-pair`
  and stop propagation so the popup stays open for the copied flash.
- **Ace markers** power the unknown-name underline. Ace's `Range` class is
  obtained via `ace.require("ace/range")` when the loader is exposed, else
  from `selection.getRange().constructor` — checked for `clipRows` /
  `toScreenRange`, since Ace calls both and a plain object would break the
  editor's render. Markers hold plain positions that any edit invalidates and
  they do NOT move with the text, so the rescan is bound to `editor.on
  ("change")`, never `session.on("change")`: Splunk swaps sessions, and a
  listener on the old one silently stops firing, leaving marks frozen over
  whatever text now sits at those columns. Ace's built-in marker drawing put
  these underlines at column 0 with the correct width no matter what range
  was passed, so they are drawn by a custom renderer function (the 3rd
  `addMarker` argument) that computes left/width from the document columns
  and recovers the layer padding from the `left` Ace hands it. Don't put
  geometry in the `.ssh-bad-token` CSS rule — the div is positioned inline. `outputlookup` targets and names containing
  `$` (macro arguments) are never marked.
- **Data models**: the entity route `datamodel/model/<name>` returns HTTP 500
  on some stacks under the `-/-` namespace, so reads go collection-first
  (`datamodel/model?search=<name>`, exact-matched on `entry[].name`) with the
  entity routes as fallbacks. It returns the interesting parts as
  JSON *strings* inside the entry content — `description` holds the datasets
  and their fields, `acceleration` the summary settings. Both are parsed
  defensively; a malformed one must not take the popup down. A dataset's
  fields include the output fields of its calculations, not just `fields`.
- **Field info dialog**: name in `h2.field-info-header`; values in
  `table.table-field-values td.value a[data-value]` — `data-value` holds the
  raw (untruncated) value; copy from it, not display text.
- **Export button takeover**: on the search page nothing of ours is added to
  the job-control strip. `findExportButton()` is the single source of truth
  for what that button is — the click hook AND the dashboard fallback both
  ask it, so they cannot disagree and leave a page showing both the menu and
  a redundant Copy table bar. It requires a neighbouring strip control
  (print/share/pause/stop) in the button's parent or grandparent, so a
  dashboard panel's own export is never hijacked. Splunk's export button has its click intercepted by
  a capture-phase listener **on document**, not on the button: at the target
  element, capture and bubble listeners fire in registration order, so a
  listener bound to the button itself could lose the race to Splunk's own.
  The menu's "Export as File" replays `btn.click()` under an `exportBypass`
  flag that makes the hook stand aside. The button is never modified — no
  class, tag or attribute of it is copied or changed.
- Menus are `position: fixed` children of `<body>`, never nested in the
  control they hang from, so they cannot be clipped by it or disturb a
  `.btn-group`'s joined-button styling.
- **Copy table** reads the rendered DOM only — the current page of rows, in
  the current sort order. Rows on other pages are not in the DOM and are
  deliberately not fetched: paging the job's results would turn a passive
  read into a data pull. Data columns are those whose `th` carries a field
  identity (`data-sort-key` / `data-name` / `col-time`); row-number, checkbox
  and expand columns have none and are skipped.
- Avoid `:has()` in selectors — `minimum_chrome_version` is 102 and `:has()`
  landed in 105.
- All decorators are idempotent and re-applied by one MutationObserver pass
  coalesced with requestAnimationFrame (`decorateAll`). Splunk re-renders
  these surfaces constantly.

## Settings

`chrome.storage.sync`, applied live via `onChanged` (no reload). Keys:
`hoverMacros`, `hoverLookups`, `hoverSavedSearches`, `hoverIndexes`,
`hoverDatamodels`, `markUnknown`, `lookupSamples`, `copyStatHeaders`,
`copyEventHeaders`, `copyEventActions`, `copyDrilldownPair`, `copyFieldDialog`,
`copyTable`, `domains` (array of granted hosts).

Existence checks (`existPaths`) must use COLLECTION endpoints with `search=`,
never entity routes: a missing object then comes back 200-with-no-entries
rather than 404, and a search bar holding a few unknown names would otherwise
fill the browser console with failed-request errors for anyone debugging the
page. `search=` is fuzzy, so the result is always matched on the exact name.

`markUnknown` issues REST GETs for every distinct token in the search bar
~800 ms after typing stops (capped at 25 per pass, cached per tab whatever the
answer). It must never call `resolve()` — that fetches fields and samples and
can dispatch a search. `checkExists()` is the pure-REST path it uses instead,
and only a definite 404 marks a token: a 403 means "exists but not yours",
which must never be shown as a typo.

With `lookupSamples` off, `fetchLookupInfo` returns no fields and no sample, so
the builder appears only for definitions that declare `fields_list` — and it
must then render WITHOUT the Sample column and without the try-a-value inputs
(`.ssh-2col`), rather than showing them empty.

`lookupSamples` is the ONLY feature that dispatches searches (oneshot
`| inputlookup … | head 1` exports) under the user's account. Anything new
that dispatches a search must be gated behind it or its own toggle — the
"passive read-only mode" promise is part of the store listing and privacy
policy. Settings never reach `page-agent.js`; the content script drops
disabled hover kinds on receipt.

## Caching

Positive REST answers cache for the life of the tab; negative ones
(`notFound` / `forbidden` / `error`) expire after `NEGATIVE_TTL_MS` (30 s).
They must: running the search you are writing can create the very lookup the
popup just said was missing. For the same reason `outputlookup` hovers resolve
with `{ fresh: true }` — never served from cache — and the guard's row count
carries its own TTL. `resolve()` also promotes a token to "present" in
`existCache` and asks the agent to rescan, so an unknown-name underline clears
the moment a hover proves the name resolves.

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
- Options-page copy describes what a feature does for the user, not how it
  came to work that way. Reassurances that only make sense to someone who
  followed the build ("the sort arrows still sort", "nothing is added to the
  header") are build notes — they belong here, not in the UI.
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
2b. On a dark-themed stack, confirm the popup is dark (it reads the page's
   background luminance, so a theme switch must be picked up on next hover).
2c. Hover a `savedsearch` name and an `index=` value; mistype each and
   confirm the popup says so and the search bar underlines it.
2d. Hover `| outputlookup <existing file>` → overwrite warning with row
   count; `| outputlookup <new name>` → "will be created", not an error.
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
- Nested macros display verbatim in the popup; **Copy expanded** resolves
  them recursively (depth-limited to 8 — a macro may legitimately appear
  twice, so the guard is on nesting, not on repeated names). An unresolvable
  macro is left exactly as written rather than dropped.
