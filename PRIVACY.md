# Privacy Policy — Hover Actions for SPL

_Last updated: August 2026_

## Summary

This extension collects no data. Nothing you do in your browser is transmitted
to the developer or to any third party.

## Details

**Data collection:** None. The extension has no backend, no analytics, no
telemetry, and no error reporting. The developer receives no information about
you or your usage.

**Network requests:** All requests made by the extension are same-origin calls
to the Splunk instance you are already logged into (your `*.splunkcloud.com`
domain), using your existing authenticated session. These requests read Splunk
object metadata (macro definitions, lookup configurations) and, if the
"Sample data & live preview" feature is enabled, run small one-shot
`| inputlookup` searches to display sample rows. No request is ever made to
any other host.

**Storage:** The extension stores only its own settings — six on/off feature
toggles — using Chrome's `storage.sync` API, which keeps them in your browser
profile. No page content, search text, lookup data, or personal information is
stored.

**Clipboard:** Copy-to-clipboard actions are user-initiated (clicking a copy
icon) and write to your own clipboard only.

**Permissions:**
- `storage` — persist the feature toggles and your domain list.
- `scripting` — register the extension's content scripts for the domains you
  add.
- Host access is **optional and user-granted**: the extension has no access
  to any website until you add your own Splunk domain on the options page,
  and it runs only on the domains you have added. A domain may be written as
  a wildcard (`*.splunkcloud.com`) to cover several stacks in one grant;
  Chrome shows you the scope before you approve it.

## Changes

Any change to this policy will be published in this repository and reflected
in the extension's store listing before taking effect.

## Contact

Questions or concerns: open an issue in this repository.
