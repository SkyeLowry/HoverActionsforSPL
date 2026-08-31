# Hover Actions for SPL

A Chrome extension that adds hover popups, a lookup clause builder, and
one-click field copying to Splunk Web (`*.splunkcloud.com`).

## Features

**Hover popups in the search bar**
- Hover a `` `macro` `` to see its full definition inline, with a jump to the
  definition page.
- Hover a `savedsearch` name for its SPL, owner, app, schedule and next run.
- Macro popups show the definition with this call's arguments substituted, and
  copy it fully expanded (nested macros included).
- Hover `datamodel=Foo.Bar` for its datasets, fields and acceleration state.
- Hover `index=<name>` for event count, size and the earliest/latest event —
  or a plain "no such index" before you run the search.
- Unknown macros, lookups, indexes and reports get a dotted red underline in
  the search bar as you type (REST reads only, cached per tab).
- `| outputlookup <file>` warns when the file already exists, with what it
  currently holds — or confirms it will be created.
- Hover a lookup file or lookup definition to see the owning app, backing
  source (CSV or KV store), fields, and a sample row, plus edit links.
- Same-named objects in multiple apps are all listed with their app.

**Lookup clause builder** — hover any `| lookup` command:
- See every field the lookup contains, with sample values (click a sample to
  copy it).
- Change match fields, edit `AS` aliases, check/uncheck `OUTPUT` fields.
- Type a value against a match field to live-preview the row the lookup would
  return.
- Apply rewrites the clause in your search — refused safely if the line
  changed since you hovered.

**Copy icons** for field names and values:
- Statistics and dashboard table headers — click the field name itself
- Events table (View: Table) column headers, including `_time` — click the
  field name itself
- Expanded event field table — a **Copy Value** entry in each row's Actions
  menu (raw value)
- Results-table drilldown popup — the `field = value` line copies as
  `field="value"` or as the bare value
- Field info dialog — the field name and each listed value (full raw value,
  even when the display truncates)
- Whole visible table — from the export button's menu, TSV or Markdown,
  current page only
- Field and sample cells in the hover popups

**Options page** — every feature toggles on/off, including a switch that
disables all search-dispatching functionality (sample fetch and live preview)
for a passive, read-only mode.

## Install

**From source (unpacked):**
1. Clone this repository
2. Open `chrome://extensions`, enable **Developer mode**
3. **Load unpacked** → select the repository folder
4. The options page opens — add your Splunk domain (the extension has no
   host access until you do). `*.splunkcloud.com` covers every stack under it.

**From the Chrome Web Store:** _link pending review_

## Privacy

No data collection, no external hosts, no telemetry, and **no host access by
default** — you grant permission for your own Splunk domain(s) from the
options page, and the extension runs nowhere else. All requests are
same-origin calls to your own Splunk instance on your existing session.
See [PRIVACY.md](PRIVACY.md).

## Compatibility notes

Built and tested against Splunk Cloud. Known variance between stacks:

- "Edit lookup" deep links require the **Lookup File Editor** app.
- Some Settings/manager URLs differ across Splunk Web versions. If an edit
  link 404s on your stack, open an issue and include the working URL from
  your own Settings pages.
- Sample data uses a POST to `search/jobs/export`; stacks that also expose the
  Lookup File Editor REST handler will use it instead where available.

## Architecture

- `background.js` (service worker) — registers content scripts dynamically
  for exactly the domains you've granted, and keeps registrations in sync.
- `page-agent.js` (MAIN world) — talks to the Ace editor instance directly:
  converts mouse position to document coordinates, tokenizes SPL, applies
  clause rewrites with a stale-text guard.
- `content.js` (isolated world) — popup UI, REST resolution, clipboard,
  settings.
- Permissions: `storage` (settings), `scripting` (dynamic registration); host access is optional and user-granted per domain.

## Issues & contributions

Bug reports and PRs welcome. For stack-specific URL breakage, include your
Splunk version and the working URL — that class of bug is fixed by evidence,
not guesswork.

## License

MIT — see [LICENSE](LICENSE).

## Trademark

This is an independent project, not affiliated with, endorsed by, or
sponsored by Splunk LLC or Cisco. Splunk is a registered trademark of
Splunk LLC.

## Version history

- **0.20.0** — Wildcard domains: add `*.splunkcloud.com` once to cover every
  stack under it, instead of one entry per host.
- **0.19.4** — Options copy describes what each feature does rather than how it
  got there; sample data greys out when lookup hovers are off.
- **0.19.3** — Options page regrouped into four capability sections with each
  setting under the group it belongs to; the lookup tools get a proper writeup.
- **0.19.2** — Negative lookups (not found, no permission, errors) expire after
  30s instead of lasting the tab's life, so a file the search just created is
  seen; outputlookup guards always read fresh.
- **0.19.1** — With sample data off, the builder and explorer drop the Sample
  column and the try-a-value box instead of showing them empty.
- **0.19.0** — “+N more” on a field list expands it in place.
- **0.18.5** — Grow a cell menu to the room available on screen instead of
  letting the added entries make it scroll.
- **0.18.4** — The copy entries now appear in the Statistics drilldown popup
  too, which isn't a .dropdown-menu and was being skipped.
- **0.18.3** — Cell-menu entries are labelled with the text they copy, elided
  with an ellipsis when long; the full value still reaches the clipboard.
- **0.18.2** — Match a results-table cell to its header by column position
  rather than cell index, fixing the field name landing one column right.
- **0.18.1** — Fix the copy-the-pair entry naming the wrong field in results
  tables: the field comes from the column header there, not a sibling cell.
- **0.18.0** — Substituted macro arguments are highlighted in the definition;
  data model reads fall back through the collection endpoint (the entity route
  500s on some stacks); Actions menu shows the resolved pair; Copy SPL removed.
- **0.17.0** — Macro popups substitute the call's arguments and offer **Copy
  expanded** (nested macros resolved); data model / `tstats` hovers; a resolved
  copy-the-pair entry in the event Actions menu.
- **0.16.4** — One shared test for the job-control export button, so the
  dashboard-only Copy table bar can't appear on the search page too.
- **0.16.3** — Draw the unknown-name underline with a custom Ace marker
  renderer, fixing underlines landing at the start of the line.
- **0.16.2** — Existence checks query collection endpoints, so a missing name
  returns an empty list rather than a 404 the browser logs; macro reads try
  the collection first, which also resolves app-scoped macros.
- **0.16.1** — Unknown-name marks: bind the rescan to the editor rather than
  the session (Splunk swaps sessions, freezing markers), find Ace's Range
  class more robustly, and log what gets marked under `[SSH]`.
- **0.16.0** — Hovering the command word (`inputlookup`, `lookup`,
  `savedsearch`, `index=`) opens the popup, not just the name; macro reads
  fall back through `data/macros` when `admin/macros` 404s; builder columns
  no longer overlap.
- **0.15.0** — Dark theme for the hover popup (page luminance, not a Splunk
  class); saved-search and index hovers; outputlookup overwrite guard;
  unknown-name marking in the search bar.
- **0.14.0** — The search page's export button now opens a menu: **Export as
  File** (Splunk's own export, unchanged) plus Copy as TSV / Markdown. Nothing
  of ours in the toolbar; dashboards keep a per-table button.
- **0.13.2** — Copy-table icon matches its neighbours' tag, fixing the gap in
  the job-control strip.
- **0.13.1** — Copy table moves into the job-control strip as an icon beside
  share / print / export; dashboards keep a per-table button.
- **0.13.0** — Copy table button: the rows on the current page, in the current
  sort order, as TSV or Markdown with headers. Reads the DOM only.
- **0.12.0** — Results-table drilldown popup: click the field name to copy
  `field="value"`, click the value to copy it alone.
- **0.11.0** — Events-table headers follow the same pattern: the icon is gone,
  the field name copies on click; column drag and sort unchanged.
- **0.10.0** — Statistics/dashboard headers: the copy icon is gone; the field
  name itself copies on click (green flash), sort arrows unchanged.
- **0.9.0** — "Copy Value" entry in the Actions dropdown of each row in an
  expanded event's field table (own options toggle).
- **0.8.2** — Fix events-table copy icon wrapping onto a second line
  (the reorderable label is block-level; it now shrinks to its content).
- **0.8.1** — Events-table copy icon is now always visible and sits to the
  right of the sort arrows; hovering a header no longer shifts the column.
- **0.6.0** — Options page: feature toggles (hovers, samples/preview,
  each copy surface), live-applied via storage.sync; description and
  clipboard-surface list.
- **0.5.0** — Sample explorer on inputlookup/outputlookup hovers (Field |
  Sample table + try-a-value preview); quieter builder layout (three-column
  grid, borderless inputs, dimmed unchecked rows).
- **0.4.0** — Lookup sample data in the builder: first-row values per field,
  live row preview from typed match values (debounced export query),
  definition sampling through inputlookup (KV-backed included).
- **0.3.0** — Lookup clause builder (edit match/AS/OUTPUT in place); copy-field
  icons on Statistics/events table headers, field-info dialog header and
  values; field chips on lookup popups; CSV header via POST export fallback
  (lookup_editor REST handler blocked on Cloud); grace-corridor hover fix;
  verified macro edit URL (`data/macros` + `ns=`).
- **0.2.0** — Scope widened from one stack to `*.splunkcloud.com`.
- **0.1.0** — Initial: macro / lookup file / lookup definition hovers with
  REST resolution and edit links.
