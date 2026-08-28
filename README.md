# Hover Actions for SPL

A Chrome extension that adds hover popups, a lookup clause builder, and
one-click field copying to Splunk Web (`*.splunkcloud.com`).

## Features

**Hover popups in the search bar**
- Hover a `` `macro` `` to see its full definition inline, with a jump to the
  definition page.
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
- Statistics and dashboard table headers
- Events table (View: Table) column headers, including `_time`
- Field info dialog — the field name and each listed value (full raw value,
  even when the display truncates)
- Field and sample cells in the hover popups

**Options page** — every feature toggles on/off, including a switch that
disables all search-dispatching functionality (sample fetch and live preview)
for a passive, read-only mode.

## Install

**From source (unpacked):**
1. Clone this repository
2. Open `chrome://extensions`, enable **Developer mode**
3. **Load unpacked** → select the repository folder

**From the Chrome Web Store:** _link pending review_

## Privacy

No data collection, no external hosts, no telemetry. All requests are
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

- `page-agent.js` (MAIN world) — talks to the Ace editor instance directly:
  converts mouse position to document coordinates, tokenizes SPL, applies
  clause rewrites with a stale-text guard.
- `content.js` (isolated world) — popup UI, REST resolution, clipboard,
  settings.
- No background service worker; `storage` is the only Chrome permission.

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
