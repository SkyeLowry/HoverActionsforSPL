# Chrome Web Store listing

Source of truth for the store copy. Keep this in step with the product —
the listing described 0.8 for a long time after the product had moved on.

Plain text only: the store renders no Markdown in the description field.
Bullets below use `•` because that is what survives the paste.

---

## Short description (132 char limit)

```
Hover popups, a lookup clause builder, and one-click copying for Splunk Web. No site access until you add your own domain.
```

---

## Detailed description

```
Hover Actions for SPL adds inline answers to Splunk Web. Hover a macro, lookup, saved search, index or data model in the search bar and see what it actually is — without opening Settings in another tab and losing your place.

It runs entirely against your existing Splunk session. There are no external servers, no accounts, and no telemetry.


IN THE SEARCH BAR

• Macros — see the full definition, with this call's arguments filled in and highlighted. Copy the whole thing with nested macros resolved.
• Lookups — the owning app, whether a definition is CSV- or KV-backed, its fields, and links to edit either the definition or its backing file.
• Saved searches and reports — the SPL behind the name, its owner, app, schedule and next run.
• Indexes — event count, size, and the earliest and latest event behind index=<name>.
• Data models — datasets, fields and acceleration state, which is what you want when writing tstats.
• Names that don't exist get a dotted red underline as you type, so a typo shows up before you run the search rather than after.


THE LOOKUP CLAUSE BUILDER

Hover a | lookup clause and you get more than a description of it — you get an editor for it.

• Change the match fields, rename them with AS, tick and untick OUTPUT fields, switch between OUTPUT and OUTPUTNEW.
• See a real sample row from the lookup alongside each field.
• Type a value against a match field to preview the row that lookup would actually return, before committing to the clause.
• Apply writes the rewritten clause back into your search. If the line changed while the popup was open, the rewrite is refused rather than overwriting your edit.
• Hovering | outputlookup on a file that already exists warns you first, with its current row count and contents. On a new name it simply confirms the file will be created.


COPYING FIELDS AND VALUES

Getting a field name or a value out of Splunk Web usually means selecting text precisely. This turns the things you already click into copy targets.

• Click a column header's field name in Statistics, dashboard and Events tables to copy it. Nothing is added to the header, so no column changes size or position.
• Cell menus gain two entries: the value on its own, and field="value" ready to paste into a search.
• The field = value line at the top of a drilldown popup splits into two copy targets — the pair, or the value alone.
• The field info dialog gets copy buttons on the field name and on each value, copying the full value even where the display truncates it.


COPYING A WHOLE TABLE

The search page's export button becomes a menu: Splunk's own Export as File, unchanged, plus Copy as TSV for spreadsheets and Copy as Markdown for tickets and docs, headers included. Dashboard tables get their own button.

You get the rows in front of you, in their current sort and columns — not pages you haven't loaded.


PRIVACY AND PERMISSIONS

The extension has no access to any website when you install it. You add your own Splunk domain on the options page, and Chrome asks you to approve that domain specifically. It runs nowhere else. A wildcard such as *.splunkcloud.com is accepted if you have several stacks.

All requests are same-origin calls to your own Splunk instance, using the session you are already signed in with. Nothing is sent anywhere else, and nothing is stored outside your browser.

One feature dispatches searches under your account: Sample data & live preview, which runs a oneshot "| inputlookup ... | head 1" to read a sample row and to preview values you type. It has its own switch. Turn it off and the extension only reads configuration and the page in front of you.

Every feature has a toggle, and they apply immediately without reloading.


COMPATIBILITY

Built and tested against Splunk Cloud, and works with self-hosted Splunk Web. Some Settings and manager URLs differ between Splunk versions — if an edit link doesn't resolve on your stack, please open an issue with the working URL from your own Settings pages, and it will be fixed.

Requires Chrome 102 or later.


OPEN SOURCE

Source, privacy policy and issue tracker: https://github.com/SkyeLowry/HoverActionsforSPL


This is an independent project. It is not affiliated with, endorsed by, or sponsored by Splunk LLC or Cisco. Splunk is a registered trademark of Splunk LLC.
```

---

## Notes for whoever updates this

- Screenshots use the `http_status.csv` fixture — never a real lookup, never
  real event data.
- Keep the privacy paragraph true against `PRIVACY.md` and the code. If a
  change would make a sentence here false, the change is wrong or both files
  need updating first.
- No employer names, no internal filenames, no domain-specific identifiers.
- Re-read this whenever `manifest.json` gains a permission.
