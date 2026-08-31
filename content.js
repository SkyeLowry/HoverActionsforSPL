/**
 * Hover Actions for SPL — content script (isolated world)
 *
 * Receives hover events from page-agent.js, resolves the token against the
 * Splunk REST API (same-origin, rides the existing session), and renders the
 * hover popup with actions.
 */
(() => {
  "use strict";

  const MSG_SOURCE = "ssh";
  const HIDE_DELAY_MS = 300;

  // Locale prefix ("/en-GB") derived from the URL — never hardcoded.
  const LOCALE = "/" + window.location.pathname.split("/")[1];
  const RAW = `${LOCALE}/splunkd/__raw`;

  // ---------------------------------------------------------------------------
  // Settings (options page, chrome.storage.sync). Defaults apply until the
  // async load lands; changes apply live without a reload.
  // ---------------------------------------------------------------------------

  const settings = {
    hoverMacros: true,
    hoverLookups: true,
    hoverSavedSearches: true,
    hoverIndexes: true,
    hoverDatamodels: true,
    markUnknown: true,
    lookupSamples: true,
    copyStatHeaders: true,
    copyEventHeaders: true,
    copyFieldDialog: true,
    copyEventActions: true,
    copyDrilldownPair: true,
    copyTable: true,
  };

  function applyCopySettings() {
    if (!settings.copyStatHeaders) undecorateHeaders("th[data-sort-key]");
    if (!settings.copyEventHeaders) {
      undecorateHeaders("th.reorderable");
      undecorateHeaders("th.col-time");
    }
    if (!settings.copyFieldDialog) {
      document
        .querySelectorAll(".field-info-header .ssh-copy, .ssh-copy-value")
        .forEach((b) => b.remove());
    }
    if (!settings.copyEventActions) clearMenuItems();
    if (!settings.copyTable) {
      document
        .querySelectorAll(".ssh-tblcopy-btn, .ssh-tblcopy-menu, .ssh-tblbar")
        .forEach((el) => el.remove());
    }
    if (!settings.copyDrilldownPair) {
      document.querySelectorAll(".ssh-pair").forEach((span) => {
        span.replaceWith(document.createTextNode(span.textContent));
      });
    }
    // Re-decorating enabled surfaces happens via the shared observer pass.
    decorateAll();
  }

  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(settings, (loaded) => {
      Object.assign(settings, loaded);
      applyCopySettings();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      for (const [k, v] of Object.entries(changes)) {
        if (k in settings) settings[k] = v.newValue;
      }
      applyCopySettings();
      if (!enabledFor("macro") && !enabledFor("lookup_file") && popup) {
        popup.style.display = "none";
      }
      // Marks are the page agent's to draw; ask for a fresh pass either way.
      window.postMessage(
        { source: "ssh-x", type: settings.markUnknown ? "rescan" : "marks", bad: [] },
        window.location.origin
      );
    });
  }

  // ---------------------------------------------------------------------------
  // REST resolver with per-tab cache
  // ---------------------------------------------------------------------------

  // key: kind|name → { at, value }. Positive answers keep indefinitely; a
  // negative one is only good for a moment — the object may be created by the
  // very search you are writing, which is exactly what happens with
  // outputlookup.
  const cache = new Map();
  // key: kind|name → { at, verdict }. Shared with resolve(), which promotes a
  // token to "present" as soon as it resolves one.
  const existCache = new Map();
  const NEGATIVE_TTL_MS = 30000;

  function isNegative(v) {
    return !!v && (v.notFound || v.forbidden || v.error);
  }

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (isNegative(hit.value) && Date.now() - hit.at > NEGATIVE_TTL_MS) {
      cache.delete(key);
      return undefined;
    }
    return hit.value;
  }

  async function restGet(path) {
    const resp = await fetch(path, { credentials: "same-origin" });
    if (!resp.ok) {
      // Status matters downstream: 404 means "no such object", 403 means
      // "exists but not yours to see" — never report the latter as a typo.
      const err = new Error(`HTTP ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }

  async function resolve(token, opts = {}) {
    const key = `${token.kind}|${token.restName || token.name}`;
    if (!opts.fresh) {
      const hit = cacheGet(key);
      if (hit !== undefined) return hit;
    }

    let result;
    try {
      if (token.kind === "macro") {
        result = await resolveMacro(token);
      } else if (token.kind === "saved_search") {
        result = await resolveSavedSearch(token);
      } else if (token.kind === "index") {
        result = await resolveIndex(token);
      } else if (token.kind === "datamodel") {
        result = await resolveDatamodel(token);
      } else if (token.kind === "lookup_file") {
        result = await resolveLookupFile(token);
      } else {
        result = await resolveLookupDef(token);
      }
    } catch (e) {
      if (e.status === 404) result = { notFound: true };
      else if (e.status === 403) result = { forbidden: true };
      else result = { error: e.message || String(e) };
    }
    cache.set(key, { at: Date.now(), value: result });

    // Something that resolves now must not stay underlined as unknown.
    if (!isNegative(result)) {
      const was = existCache.get(key);
      existCache.set(key, { at: Date.now(), verdict: true });
      if (was && was.verdict === false) {
        window.postMessage(
          { source: "ssh-x", type: "rescan" },
          window.location.origin
        );
      }
    }
    return result;
  }

  // Saved searches / reports / alerts. Names allow spaces, so the REST name is
  // the whole (unquoted) title, percent-encoded.
  async function resolveSavedSearch(token) {
    const name = encodeURIComponent(token.name);
    const data = await restGet(
      `${RAW}/servicesNS/-/-/saved/searches/${name}?output_mode=json&count=0`
    );
    if (!data.entry || data.entry.length === 0) return { notFound: true };
    return {
      entries: data.entry.map((e) => ({
        app: e.acl.app,
        owner: e.acl.owner,
        search: e.content.search,
        disabled: e.content.disabled,
        scheduled: e.content.is_scheduled,
        cron: e.content.cron_schedule || null,
        nextRun: e.content.next_scheduled_time || null,
        alertType: e.content.alert_type || null,
        description: e.content.description || null,
      })),
    };
  }

  // Index existence and shape. Non-admin roles can usually read this; a 403
  // is reported as "can't verify", never as a typo.
  async function resolveIndex(token) {
    const name = encodeURIComponent(token.name);
    const data = await restGet(
      `${RAW}/servicesNS/-/-/data/indexes/${name}?output_mode=json&count=0`
    );
    if (!data.entry || data.entry.length === 0) return { notFound: true };
    const c = data.entry[0].content || {};
    return {
      entries: [
        {
          app: data.entry[0].acl.app,
          owner: data.entry[0].acl.owner,
          events: c.totalEventCount,
          sizeMB: c.currentDBSizeMB,
          minTime: c.minTime || null,
          maxTime: c.maxTime || null,
          frozenSecs: c.frozenTimePeriodInSecs || null,
          datatype: c.datatype || null,
          disabled: c.disabled,
        },
      ],
    };
  }

  // Macro reads have to try more than one endpoint. `admin/macros` is the
  // historical path and resolves most macros, but some — app-scoped, owner
  // nobody, in an app that isn't the current one — 404 there and resolve on
  // `data/macros`, which is also what the verified edit URL uses. The last
  // resort is a filtered list, which finds a macro the entity routes miss.
  function macroPaths(restName) {
    const enc = encodeURIComponent(restName);
    // The collection query goes first for two reasons: it finds app-scoped
    // macros the entity routes miss, and a miss comes back 200-with-no-
    // entries instead of a 404 the browser logs as a console error. Its
    // search term is the bare name — a REST name like foo(2) carries parens
    // that don't belong in a search expression — so callers must still match
    // the full name exactly.
    const base = encodeURIComponent(restName.replace(/\(.*$/, ""));
    return [
      `${RAW}/servicesNS/-/-/data/macros?search=${base}&output_mode=json&count=0`,
      `${RAW}/servicesNS/-/-/data/macros/${enc}?output_mode=json&count=0`,
      `${RAW}/servicesNS/-/-/admin/macros/${enc}?output_mode=json&count=0`,
    ];
  }

  // Data models. The interesting parts arrive as JSON *strings* inside the
  // entry content: `description` holds the datasets and their fields,
  // `acceleration` the summary settings. Both are parsed defensively — a
  // malformed one must not take the popup down.
  function parseJson(text, fallback) {
    try {
      return JSON.parse(text || "");
    } catch {
      return fallback;
    }
  }

  function datasetFields(obj) {
    const names = (obj.fields || []).map((f) => f.fieldName);
    // Calculated fields (eval / lookup / rex) contribute output fields too.
    (obj.calculations || []).forEach((c) => {
      (c.outputFields || []).forEach((f) => names.push(f.fieldName));
    });
    return [...new Set(names.filter(Boolean))];
  }

  // The entity route 500s on some stacks (observed on Splunk Cloud with the
  // -/- namespace), so the collection query leads: it is the one the marking
  // pass already relies on, and a miss returns an empty list rather than an
  // error.
  function datamodelPaths(name) {
    const enc = encodeURIComponent(name);
    return [
      `${RAW}/servicesNS/-/-/datamodel/model?search=${enc}&output_mode=json&count=0`,
      `${RAW}/servicesNS/-/-/datamodel/model/${enc}?output_mode=json&count=0`,
      `${RAW}/services/datamodel/model/${enc}?output_mode=json&count=0`,
    ];
  }

  async function resolveDatamodel(token) {
    const tried = [];
    let e = null;
    let lastErr = null;

    for (const path of datamodelPaths(token.name)) {
      try {
        const data = await restGet(path);
        const hit = (data.entry || []).find((x) => x.name === token.name);
        if (hit) {
          e = hit;
          break;
        }
        tried.push(`${path} → 200, no exact match`);
      } catch (err) {
        lastErr = err;
        tried.push(`${path} → ${err.status || err.message}`);
      }
    }
    if (!e) {
      console.log(`[SSH] data model "${token.name}" unresolved:`, tried);
      if (lastErr && lastErr.status && lastErr.status !== 404) throw lastErr;
      return { notFound: true };
    }

    const model = parseJson(e.content.description, {});
    const accel = parseJson(e.content.acceleration, {});
    const objects = model.objects || [];
    const wanted = token.dataset
      ? objects.find((o) => o.objectName === token.dataset)
      : null;
    return {
      entries: [
        {
          app: e.acl.app,
          owner: e.acl.owner,
          displayName: model.displayName || null,
          datasets: objects.map((o) => o.objectName),
          dataset: token.dataset || null,
          datasetMissing: !!token.dataset && !wanted,
          fields: wanted ? datasetFields(wanted) : null,
          accelerated: accel.enabled === true || accel.enabled === "1",
          accelRange: accel.earliest_time || null,
        },
      ],
    };
  }

  async function resolveMacro(token) {
    const restName = token.restName || token.name;
    const tried = [];
    let lastErr = null;

    for (const path of macroPaths(restName)) {
      let data;
      try {
        data = await restGet(path);
      } catch (e) {
        lastErr = e;
        tried.push(`${path} → ${e.status || e.message}`);
        continue; // 404 here doesn't mean the macro is gone — try the next
      }
      const entries = (data.entry || []).filter((e) => e.name === restName);
      if (entries.length) {
        return {
          entries: entries.map((e) => ({
            app: e.acl.app,
            owner: e.acl.owner,
            definition: e.content.definition,
            args: e.content.args,
          })),
        };
      }
      tried.push(`${path} → 200, no exact match`);
    }
    // Diagnostics for the next stack that routes macros differently.
    console.log(`[SSH] macro "${restName}" unresolved:`, tried);
    if (lastErr && lastErr.status && lastErr.status !== 404) throw lastErr;
    return { notFound: true };
  }

  // Splunk web CSRF token (needed for POSTs through the splunkweb proxy).
  // Cookie name is splunkweb_csrf_token_<port>; not httpOnly by design.
  function getCsrfToken() {
    const m = document.cookie.match(/splunkweb_csrf_token_[^=]*=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Once both lookup_editor endpoints 404 on this page, stop retrying them.
  let lookupContentsDead = false;

  // POST a oneshot search to the export endpoint, return the first result
  // row as an object (or null). Used for lookup samples and live preview.
  async function runExportFirstRow(spl) {
    const csrf = getCsrfToken();
    if (!csrf) {
      console.log("[SSH] export: no CSRF cookie found");
      return null;
    }
    try {
      const resp = await fetch(
        `${RAW}/services/search/jobs/export?output_mode=json`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Splunk-Form-Key": csrf,
            "X-Requested-With": "XMLHttpRequest",
          },
          body: new URLSearchParams({
            search: spl,
            adhoc_search_level: "fast",
            earliest_time: "0",
            latest_time: "now",
          }).toString(),
        }
      );
      if (!resp.ok) {
        console.log("[SSH] export HTTP", resp.status, spl);
        return null;
      }
      const text = await resp.text();
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj && obj.result) return obj.result;
      }
      return null; // ran fine, zero rows
    } catch (e) {
      console.log("[SSH] export failed:", e.message || e, spl);
      return null;
    }
  }

  // Quote a name/field for inline SPL (builder-side q() handles clause text;
  // this one is for names inside generated preview searches).
  function qSpl(s) {
    return /^[\w.$-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
  }
  function escSplValue(v) {
    return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // Fields + one sample row for a lookup (file name or definition name —
  // inputlookup takes both, so KV-backed definitions work too). Tries the
  // Lookup File Editor handler first where not known-dead, since it avoids
  // a search dispatch; falls back to a head-1 export.
  async function fetchLookupInfo(name, app, owner) {
    if (!settings.lookupSamples) return { fields: null, sample: null };
    if (!lookupContentsDead && name.toLowerCase().endsWith(".csv")) {
      const params =
        `?lookup_file=${encodeURIComponent(name)}` +
        `&namespace=${encodeURIComponent(app)}` +
        `&owner=${encodeURIComponent(owner || "nobody")}` +
        `&lookup_type=csv&header_only=1`;
      const endpoints = [
        `${RAW}/services/data/lookup_edit/lookup_contents${params}`,
        `${RAW}/servicesNS/nobody/lookup_editor/data/lookup_edit/lookup_contents${params}`,
      ];
      let failures = 0;
      for (const url of endpoints) {
        try {
          const data = await restGet(url);
          if (Array.isArray(data) && Array.isArray(data[0])) {
            const fields = data[0];
            const sample = Array.isArray(data[1])
              ? Object.fromEntries(fields.map((f, i) => [f, data[1][i]]))
              : null;
            console.log("[SSH] lookup info via lookup_contents:", url);
            return { fields, sample };
          }
          if (Array.isArray(data) && data.length && typeof data[0] === "object") {
            console.log("[SSH] lookup info via lookup_contents (object rows):", url);
            return { fields: Object.keys(data[0]), sample: data[0] };
          }
          failures++;
        } catch (e) {
          console.log("[SSH] lookup_contents failed:", url, e.message || e);
          failures++;
        }
      }
      if (failures >= 2) lookupContentsDead = true;
    }

    const row = await runExportFirstRow(`| inputlookup ${qSpl(name)} | head 1`);
    if (row) {
      console.log("[SSH] lookup info via export");
      return { fields: Object.keys(row), sample: row };
    }
    return { fields: null, sample: null };
  }

  // Row count for the outputlookup guard — how much is about to be replaced.
  // This dispatches a search, so it rides the same toggle as sampling.
  const rowCounts = new Map();
  async function fetchRowCount(name) {
    if (!settings.lookupSamples) return null;
    const hit = rowCounts.get(name);
    // Short-lived: writing to the lookup changes it, and the whole point of
    // the guard is what the file holds right now.
    if (hit && Date.now() - hit.at < NEGATIVE_TTL_MS) return hit.n;
    const row = await runExportFirstRow(
      `| inputlookup ${qSpl(name)} | stats count`
    );
    const n = row && row.count != null ? Number(row.count) : null;
    const value = Number.isFinite(n) ? n : null;
    rowCounts.set(name, { at: Date.now(), n: value });
    return value;
  }

  // Live preview: first row matching the typed sample value(s).
  async function fetchPreviewRow(name, filters) {
    if (!settings.lookupSamples) return null;
    const conds = filters
      .filter((f) => f.value.trim() !== "")
      .map((f) => `${qSpl(f.field)}="${escSplValue(f.value.trim())}"`);
    if (!conds.length) return null;
    return runExportFirstRow(
      `| inputlookup ${qSpl(name)} | search ${conds.join(" ")} | head 1`
    );
  }

  async function resolveLookupFile(token) {
    const data = await restGet(
      `${RAW}/servicesNS/-/-/data/lookup-table-files` +
        `?search=${encodeURIComponent(token.name)}&output_mode=json&count=0`
    );
    const entries = (data.entry || []).filter((e) => e.name === token.name);
    if (entries.length === 0) return { notFound: true };
    const resolved = entries.map((e) => ({
      app: e.acl.app,
      owner: e.acl.owner,
      path: e.content["eai:data"],
      fields: null,
      sample: null,
    }));
    // One info fetch covers all apps' copies for display purposes; per-app
    // divergence is possible but not worth N search dispatches on hover.
    const info = await fetchLookupInfo(token.name, resolved[0].app, "nobody");
    resolved.forEach((e) => {
      e.fields = info.fields;
      e.sample = info.sample;
    });
    return { entries: resolved };
  }

  async function resolveLookupDef(token) {
    const name = encodeURIComponent(token.name);
    const data = await restGet(
      `${RAW}/servicesNS/-/-/data/transforms/lookups/${name}?output_mode=json&count=0`
    );
    if (!data.entry || data.entry.length === 0) return { notFound: true };
    const resolved = data.entry.map((e) => ({
      app: e.acl.app,
      owner: e.acl.owner,
      filename: e.content.filename || null,
      collection: e.content.collection || null,
      external_cmd: e.content.external_cmd || null,
      fields: e.content.fields_list
        ? e.content.fields_list.split(",").map((f) => f.trim()).filter(Boolean)
        : null,
      sample: null,
    }));
    // Sample (and fields fallback) through the definition itself — works for
    // file- and KV-backed definitions alike.
    const info = await fetchLookupInfo(token.name, resolved[0].app, "nobody");
    resolved.forEach((e) => {
      if (!e.fields) e.fields = info.fields;
      e.sample = info.sample;
    });
    return { entries: resolved };
  }

  // ---------------------------------------------------------------------------
  // Macro expansion
  //
  // The macro regex and arg splitter are duplicated from page-agent.js on
  // purpose: that file runs in the MAIN world and there is no module system
  // to share them through. Keep the two in sync — they must agree on what a
  // macro call looks like.
  // ---------------------------------------------------------------------------

  const MACRO_RE = /`\s*([\w.:-]+)(?:\(([^`]*)\))?\s*`/g;
  const MAX_EXPAND_DEPTH = 8;

  function splitMacroArgs(argStr) {
    const args = [];
    let cur = "", depth = 0, quote = null;
    for (const ch of argStr) {
      if (quote) {
        cur += ch;
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        cur += ch; quote = ch;
      } else if (ch === "(") {
        cur += ch; depth++;
      } else if (ch === ")") {
        cur += ch; depth--;
      } else if (ch === "," && depth === 0) {
        args.push(cur); cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur.trim() !== "" || args.length > 0) args.push(cur);
    return args;
  }

  // Splunk strips the quotes off a quoted argument before substituting it.
  function unquote(v) {
    const t = v.trim();
    return /^"[\s\S]*"$|^'[\s\S]*'$/.test(t) ? t.slice(1, -1) : t;
  }

  // Replace $argname$ with the value passed at the call site. `args` is the
  // macro's declaration ("src,dest"); values come from the call.
  function substituteArgs(definition, declared, values) {
    if (!declared || !values || !values.length) return definition;
    const names = declared.split(",").map((n) => n.trim()).filter(Boolean);
    let out = definition;
    names.forEach((n, i) => {
      if (i >= values.length) return;
      out = out.split(`$${n}$`).join(unquote(values[i]));
    });
    return out;
  }

  // Display variant: the same substitution, but each replaced value is marked
  // so you can see at a glance what came from the call site. Returns escaped
  // HTML, so callers must not escape it again.
  function substituteArgsHtml(definition, declared, values) {
    if (!declared || !values || !values.length) return esc(definition);
    const names = declared.split(",").map((n) => n.trim()).filter(Boolean);
    const byName = new Map();
    names.forEach((n, i) => {
      if (i < values.length) byName.set(n, unquote(values[i]));
    });
    if (!byName.size) return esc(definition);

    const pattern = new RegExp(
      `\\$(${[...byName.keys()]
        .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|")})\\$`,
      "g"
    );
    let out = "";
    let last = 0;
    for (let m; (m = pattern.exec(definition)); ) {
      out += esc(definition.slice(last, m.index));
      out += `<span class="ssh-sub" title="${esc(m[0])}">${esc(
        byName.get(m[1])
      )}</span>`;
      last = m.index + m[0].length;
    }
    return out + esc(definition.slice(last));
  }

  async function macroDefinition(name, args) {
    const restName = args ? `${name}(${args.length})` : name;
    const r = await resolve({ kind: "macro", name, restName });
    if (!r || !r.entries || !r.entries.length) return null;
    const e = r.entries[0];
    return substituteArgs(e.definition, e.args, args);
  }

  // Depth-limited rather than cycle-detecting: a macro may legitimately
  // appear twice in one search, so the guard has to be on nesting, not on
  // having seen a name before.
  async function expandMacros(text, depth = 0) {
    if (depth >= MAX_EXPAND_DEPTH || !text) return text;
    const calls = [...text.matchAll(MACRO_RE)];
    if (!calls.length) return text;

    let out = "";
    let last = 0;
    for (const m of calls) {
      out += text.slice(last, m.index);
      const args = m[2] !== undefined ? splitMacroArgs(m[2]) : null;
      const def = await macroDefinition(m[1], args);
      // An unresolvable macro is left exactly as written rather than dropped.
      out += def === null ? m[0] : await expandMacros(def, depth + 1);
      last = m.index + m[0].length;
    }
    return out + text.slice(last);
  }

  // ---------------------------------------------------------------------------
  // Existence checks for unknown-token marks
  //
  // Deliberately NOT resolve(): that fetches fields and sample rows, which for
  // lookups can dispatch a search. Marking must stay a pure REST read — the
  // user is typing, not asking. One GET per distinct token per tab, cached
  // whatever the answer.
  // ---------------------------------------------------------------------------

  const MAX_MARK_TOKENS = 25;

  // Existence checks use COLLECTION endpoints with search=, never the entity
  // route. A missing object then comes back 200 with an empty entry list —
  // an entity route would 404, and the browser logs every one of those as a
  // console error. Typing a few unknown names would otherwise bury the
  // console for anyone debugging the page. Every result is matched on the
  // exact name, since search= is fuzzy.
  function existPaths(token) {
    const enc = encodeURIComponent(token.name);
    switch (token.kind) {
      case "macro":
        return macroPaths(token.restName || token.name).slice(0, 1);
      case "saved_search":
        return [`${RAW}/servicesNS/-/-/saved/searches?search=${enc}&output_mode=json&count=0`];
      case "index":
        return [`${RAW}/servicesNS/-/-/data/indexes?search=${enc}&output_mode=json&count=0`];
      case "lookup_file":
        return [
          `${RAW}/servicesNS/-/-/data/lookup-table-files` +
            `?search=${enc}&output_mode=json&count=0`,
        ];
      case "lookup_def":
        return [
          `${RAW}/servicesNS/-/-/data/transforms/lookups?search=${enc}&output_mode=json&count=0`,
        ];
      case "datamodel":
        return datamodelPaths(token.name).slice(0, 1);
      default:
        return [];
    }
  }

  // true = exists, false = definitely absent, null = couldn't tell (403, a
  // network error). Only false ever draws a mark.
  async function checkExists(token) {
    const key = `${token.kind}|${token.restName || token.name}`;
    const hit = existCache.get(key);
    // "Absent" and "couldn't tell" both expire; "present" does not.
    if (hit && (hit.verdict === true || Date.now() - hit.at < NEGATIVE_TTL_MS)) {
      return hit.verdict;
    }

    // One probe: true = found, false = definitely absent, null = can't tell.
    const exact = token.kind === "macro" ? token.restName || token.name : token.name;
    async function probe(path) {
      try {
        const resp = await fetch(path, { credentials: "same-origin" });
        if (resp.status === 404) return false;
        if (!resp.ok) return null; // 403 and friends: unknown, never a typo
        const data = await resp.json().catch(() => null);
        const entries = data && Array.isArray(data.entry) ? data.entry : null;
        if (!entries) return true;
        // search= is fuzzy, so an exact name match is the only proof.
        return entries.some((e) => e.name === exact);
      } catch {
        return null;
      }
    }

    // Absent everywhere is the only thing that marks a token: one path
    // finding it settles the matter, and one path being unsure spoils it.
    const paths = existPaths(token);
    let verdict = paths.length ? false : null;
    for (const path of paths) {
      const found = await probe(path);
      if (found === true) {
        verdict = true;
        break;
      }
      if (found === null) {
        verdict = null;
        break;
      }
    }
    existCache.set(key, { at: Date.now(), verdict });
    return verdict;
  }

  async function markUnknownTokens(tokens) {
    if (!settings.markUnknown) return;
    const list = tokens
      .filter((t) => enabledFor(t.kind))
      .slice(0, MAX_MARK_TOKENS);
    const verdicts = await Promise.all(
      list.map(async (t) => [t, await checkExists(t)])
    );
    const bad = verdicts
      .filter(([, ok]) => ok === false)
      .map(([t]) => `${t.kind}|${t.restName || t.name}`);
    window.postMessage(
      { source: "ssh-x", type: "marks", bad },
      window.location.origin
    );
  }

  // ---------------------------------------------------------------------------
  // URL builders
  // ---------------------------------------------------------------------------

  function macroEditUrl(restName, app, owner) {
    // Verified against this stack: manager route is data/macros (not
    // admin/macros), with the owning app in ns= and in the uri namespace.
    const uri = `/servicesNS/${owner}/${app}/data/macros/${restName}`;
    return (
      `${LOCALE}/manager/launcher/data/macros/` +
      `${encodeURIComponent(restName)}?action=edit` +
      `&ns=${encodeURIComponent(app)}` +
      `&uri=${encodeURIComponent(uri)}`
    );
  }

  // Same manager route shape as macros/transforms (launcher app + uri).
  function savedSearchEditUrl(name, app, owner) {
    const uri = `/servicesNS/${owner}/${app}/saved/searches/${name}`;
    return (
      `${LOCALE}/manager/launcher/saved/searches/` +
      `${encodeURIComponent(name)}?action=edit` +
      `&ns=${encodeURIComponent(app)}` +
      `&uri=${encodeURIComponent(uri)}`
    );
  }

  function datamodelManagerUrl(name) {
    return `${LOCALE}/manager/launcher/data/models?search=${encodeURIComponent(name)}`;
  }

  function indexManagerUrl(name) {
    return `${LOCALE}/manager/launcher/data/indexes?search=${encodeURIComponent(name)}`;
  }

  function lookupEditorUrl(filename, app) {
    return (
      `${LOCALE}/app/lookup_editor/lookup_edit` +
      `?owner=nobody&namespace=${encodeURIComponent(app)}` +
      `&lookup=${encodeURIComponent(filename)}&type=csv`
    );
  }

  function transformsEditUrl(name, app, owner) {
    const uri = `/servicesNS/${owner}/${app}/data/transforms/lookups/${name}`;
    return (
      `${LOCALE}/manager/launcher/data/transforms/lookups/` +
      `${encodeURIComponent(name)}?action=edit&uri=${encodeURIComponent(uri)}`
    );
  }

  // ---------------------------------------------------------------------------
  // Popup
  // ---------------------------------------------------------------------------

  let popup = null;
  let macroCtx = null;              // hovered macro, for the expand action
  let hideTimer = null;
  let anchor = null;                 // {x, y} of the hover that opened the popup
  const pointer = { x: -1, y: -1 };  // live mouse position
  const CORRIDOR_PAD = 40;           // px of grace around the popup rect
  const ANCHOR_RADIUS = 56;          // px of grace around the hover point

  function popupVisible() {
    return popup && popup.style.display === "block";
  }

  // True while the pointer is on/near the popup or near the original hover
  // point — i.e. anywhere along the travel path between token and popup —
  // or while any builder control inside the popup has keyboard focus.
  function inCorridor() {
    if (!popupVisible()) return false;
    if (popup.contains(document.activeElement)) return true;
    const r = popup.getBoundingClientRect();
    if (
      pointer.x >= r.left - CORRIDOR_PAD &&
      pointer.x <= r.right + CORRIDOR_PAD &&
      pointer.y >= r.top - CORRIDOR_PAD &&
      pointer.y <= r.bottom + CORRIDOR_PAD
    ) {
      return true;
    }
    if (anchor) {
      const dx = pointer.x - anchor.x;
      const dy = pointer.y - anchor.y;
      if (dx * dx + dy * dy <= ANCHOR_RADIUS * ANCHOR_RADIUS) return true;
    }
    return false;
  }

  document.addEventListener(
    "mousemove",
    (ev) => {
      pointer.x = ev.clientX;
      pointer.y = ev.clientY;
      if (!popupVisible()) return;
      if (inCorridor()) cancelHide();
      else scheduleHide();
    },
    true
  );

  // Splunk's light and dark themes don't announce themselves in any stable
  // way, so read the page's own background luminance instead. Sampled per
  // hover: a theme switch re-renders the page under us.
  function isDarkPage() {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).backgroundColor);
      if (!m) continue;
      const p = m[1].split(",").map((v) => parseFloat(v));
      if (p.length > 3 && p[3] === 0) continue; // transparent: keep looking
      return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2] < 128;
    }
    return false;
  }

  function ensurePopup() {
    if (popup) {
      popup.classList.toggle("ssh-dark", isDarkPage());
      return popup;
    }
    popup = document.createElement("div");
    popup.id = "ssh-popup";
    popup.classList.toggle("ssh-dark", isDarkPage());
    popup.addEventListener("mouseenter", () => cancelHide());
    popup.addEventListener("mouseleave", () => scheduleHide());
    // Field chips are click-to-copy; builder controls are delegated here too
    // since the popup body is rebuilt on every hover.
    popup.addEventListener("click", async (ev) => {
      const more = ev.target.closest(".ssh-field-more");
      if (more) {
        ev.preventDefault();
        more.parentElement
          .querySelectorAll(".ssh-field-hidden")
          .forEach((f) => f.classList.remove("ssh-field-hidden"));
        more.remove();
        // The popup just got taller — keep it on screen.
        if (anchor) position(popup, anchor.x, anchor.y);
        return;
      }
      const chip = ev.target.closest(".ssh-field:not(.ssh-field-more)");
      if (chip) {
        ev.preventDefault();
        if (await copyText(chip.textContent)) {
          chip.classList.add("ssh-copied");
          setTimeout(() => chip.classList.remove("ssh-copied"), 900);
        }
        return;
      }
      const sampleCell = ev.target.closest(".ssh-o-sample");
      if (sampleCell) {
        ev.preventDefault();
        const v = sampleCell.textContent;
        if (v && !sampleCell.classList.contains("ssh-nomatch")) {
          if (await copyText(v)) {
            sampleCell.classList.add("ssh-copied");
            setTimeout(() => sampleCell.classList.remove("ssh-copied"), 900);
          }
        }
        return;
      }
      const expand = ev.target.closest(".ssh-expand");
      if (expand) {
        ev.preventDefault();
        if (!macroCtx) return;
        const label = expand.textContent;
        expand.textContent = "Expanding…";
        const def = await macroDefinition(macroCtx.name, macroCtx.args);
        const full = def === null ? null : await expandMacros(def, 1);
        const ok = full !== null && (await copyText(full));
        expand.textContent = ok ? "Copied ✓" : "Couldn't expand";
        setTimeout(() => {
          expand.textContent = label;
        }, 1200);
        return;
      }
      if (ev.target.closest(".ssh-apply")) {
        ev.preventDefault();
        applyBuilder();
        return;
      }
      const del = ev.target.closest(".ssh-m-del");
      if (del) {
        ev.preventDefault();
        const rows = popup.querySelectorAll(".ssh-m-row");
        if (rows.length > 1) del.closest(".ssh-m-row").remove();
        return;
      }
      if (ev.target.closest(".ssh-m-add")) {
        ev.preventDefault();
        if (builderCtx) {
          popup
            .querySelector(".ssh-b-matches")
            .insertAdjacentHTML(
              "beforeend",
              matchRowHtml({ field: builderCtx.fields[0] || "", as: "" }, builderCtx.fields)
            );
        }
        return;
      }
    });
    // The expand chip is focusable, so it has to answer the keyboard too.
    popup.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      const more = ev.target.closest && ev.target.closest(".ssh-field-more");
      if (!more) return;
      ev.preventDefault();
      more.click();
    });
    popup.addEventListener("change", (ev) => {
      const inc = ev.target.closest(".ssh-o-inc");
      if (inc) {
        const row = inc.closest(".ssh-o-row");
        row.querySelector(".ssh-o-as").disabled = !inc.checked;
        row.classList.toggle("ssh-o-off", !inc.checked);
      }
    });
    // Live preview: typing a sample value re-queries the lookup for the
    // matching row and refreshes the sample column. Debounced; a sequence
    // counter drops stale responses that arrive out of order.
    let previewTimer = null;
    let previewSeq = 0;
    popup.addEventListener("input", (ev) => {
      if (!ev.target.closest(".ssh-m-sample")) return;
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(async () => {
        if (!builderCtx) return;
        const filters = [...popup.querySelectorAll(".ssh-m-row")].map((r) => {
          const sample = r.querySelector(".ssh-m-sample");
          return {
            field: r.querySelector(".ssh-m-field").value,
            value: sample ? sample.value : "",
          };
        });
        const seq = ++previewSeq;
        const anyTyped = filters.some((f) => f.value.trim() !== "");
        const row = anyTyped
          ? await fetchPreviewRow(builderCtx.name, filters)
          : builderCtx.sample;
        if (seq !== previewSeq) return; // a newer preview superseded this one
        updateSampleColumn(row, anyTyped);
      }, 450);
    });
    document.body.appendChild(popup);
    return popup;
  }

  function updateSampleColumn(row, typed) {
    popup.querySelectorAll(".ssh-o-sample").forEach((sp) => {
      sp.classList.remove("ssh-nomatch");
      if (row) {
        const v = sampleText(row[sp.dataset.field]);
        sp.textContent = v;
        sp.title = v;
      } else if (typed) {
        sp.textContent = "no match";
        sp.title = "";
        sp.classList.add("ssh-nomatch");
      } else {
        sp.textContent = "";
        sp.title = "";
      }
    });
  }

  function scheduleHide() {
    cancelHide();
    hideTimer = setTimeout(() => {
      if (popup) popup.style.display = "none";
    }, HIDE_DELAY_MS);
  }

  function cancelHide() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  function position(el, x, y) {
    el.style.display = "block";
    el.style.left = "0px";
    el.style.top = "0px";
    const r = el.getBoundingClientRect();
    const px = Math.min(x + 8, window.innerWidth - r.width - 8);
    const py =
      y + 10 + r.height > window.innerHeight ? y - r.height - 6 : y + 10;
    el.style.left = `${Math.max(4, px)}px`;
    el.style.top = `${Math.max(4, py)}px`;
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  const KIND_LABEL = {
    macro: "Macro",
    lookup_file: "Lookup file",
    lookup_def: "Lookup definition",
    saved_search: "Saved search",
    index: "Index",
    datamodel: "Data model",
  };

  function enabledFor(kind) {
    if (kind === "macro") return settings.hoverMacros;
    if (kind === "saved_search") return settings.hoverSavedSearches;
    if (kind === "index") return settings.hoverIndexes;
    if (kind === "datamodel") return settings.hoverDatamodels;
    return settings.hoverLookups;
  }

  function fmtInt(n) {
    const v = Number(n);
    return Number.isFinite(v) ? v.toLocaleString() : String(n);
  }

  // Splunk reports index times as epoch seconds or ISO strings depending on
  // version; accept both.
  function fmtTime(t) {
    if (!t) return null;
    const d = /^\d+$/.test(String(t)) ? new Date(Number(t) * 1000) : new Date(t);
    return isNaN(d.getTime()) ? String(t) : d.toLocaleString();
  }

  const MAX_FIELD_CHIPS = 24;

  // Every field is rendered; the ones past the cap are hidden until the
  // "+N more" chip is clicked. Expanding is then a class change rather than a
  // re-render, so it can't lose the list or disturb anything else in the
  // popup.
  function fieldsHtml(fields) {
    if (!fields || fields.length === 0) return "";
    let h = `<div class="ssh-fields">`;
    h += fields
      .map(
        (f, i) =>
          `<span class="ssh-field${
            i >= MAX_FIELD_CHIPS ? " ssh-field-hidden" : ""
          }">${esc(f)}</span>`
      )
      .join("");
    if (fields.length > MAX_FIELD_CHIPS) {
      h +=
        `<span class="ssh-field ssh-field-more" role="button" tabindex="0" ` +
        `title="Show all ${fields.length} fields">+${
          fields.length - MAX_FIELD_CHIPS
        } more</span>`;
    }
    h += `</div>`;
    return h;
  }

  // ---------------------------------------------------------------------------
  // Lookup clause builder: parse / emit / render / apply
  // ---------------------------------------------------------------------------

  function unq(s) {
    return /^".*"$/.test(s) ? s.slice(1, -1).replace(/\\"/g, '"') : s;
  }
  function q(s) {
    return /^[\w.$-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
  }

  function parsePairs(s) {
    const toks = (s.match(/"(?:[^"\\]|\\.)*"|[^\s,]+/g) || []).filter(Boolean);
    const pairs = [];
    for (let i = 0; i < toks.length; i++) {
      if (/^as$/i.test(toks[i])) continue;
      const field = unq(toks[i]);
      if (/^as$/i.test(toks[i + 1] || "")) {
        pairs.push({ field, as: unq(toks[i + 2] || "") });
        i += 2;
      } else {
        pairs.push({ field, as: "" });
      }
    }
    return pairs;
  }

  function parseLookupClause(clause) {
    let rest = clause.replace(/^lookup\s+/i, "");
    const opts = [];
    let m;
    while ((m = rest.match(/^([\w-]+\s*=\s*\S+)\s+/))) {
      opts.push(m[1]);
      rest = rest.slice(m[0].length);
    }
    const nm = rest.match(/^("(?:[^"\\]|\\.)*"|[\w.$-]+)\s*/);
    const name = nm ? unq(nm[1]) : "";
    rest = nm ? rest.slice(nm[0].length) : rest;
    const parts = rest.split(/\b(OUTPUTNEW|OUTPUT)\b/i);
    return {
      opts,
      name,
      matches: parsePairs(parts[0] || ""),
      outKeyword: parts[1] ? parts[1].toUpperCase() : null,
      outputs: parts[1] ? parsePairs(parts.slice(2).join("")) : null,
    };
  }

  function emitPairs(pairs) {
    return pairs
      .map((p) =>
        p.as && p.as !== p.field ? `${q(p.field)} AS ${q(p.as)}` : q(p.field)
      )
      .join(", ");
  }

  function emitLookupClause(p) {
    let out = "lookup";
    if (p.opts.length) out += " " + p.opts.join(" ");
    out += " " + q(p.name);
    if (p.matches.length) out += " " + emitPairs(p.matches);
    if (p.outputs && p.outputs.length) {
      out += ` ${p.outKeyword || "OUTPUT"} ${emitPairs(p.outputs)}`;
    }
    return out;
  }

  // Context of the builder currently shown in the popup.
  let builderCtx = null;

  function fieldOption(f, selected, missing) {
    return (
      `<option value="${esc(f)}"${selected ? " selected" : ""}>` +
      `${esc(f)}${missing ? " (not in lookup)" : ""}</option>`
    );
  }

  function matchRowHtml(pair, fields) {
    const known = fields.includes(pair.field);
    let opts = fields.map((f) => fieldOption(f, f === pair.field, false)).join("");
    if (!known && pair.field) opts = fieldOption(pair.field, true, true) + opts;
    return (
      `<div class="ssh-m-row">` +
      `<select class="ssh-m-field">${opts}</select>` +
      `<span class="ssh-kw">AS</span>` +
      `<input class="ssh-m-as" type="text" value="${esc(pair.as)}" placeholder="${esc(pair.field)}">` +
      // With sampling off there is nothing to preview against, so the input
      // and the Sample column it feeds are both left out rather than shown
      // dead.
      (settings.lookupSamples
        ? `<input class="ssh-m-sample" type="text" placeholder="try a value…" title="Type a value to preview the matching row">`
        : "") +
      `<a href="#" class="ssh-m-del" title="Remove match">✕</a>` +
      `</div>`
    );
  }

  function sampleText(v) {
    if (v === undefined || v === null) return "";
    return Array.isArray(v) ? v.join(", ") : String(v);
  }

  function builderHtml(parsed, fields, sample) {
    // No OUTPUT clause in SPL = all fields returned; reflect that as all
    // checked so Apply makes the implicit explicit.
    const outMap = new Map(
      (parsed.outputs || fields.map((f) => ({ field: f, as: "" }))).map((p) => [
        p.field,
        p.as,
      ])
    );
    const extras = [...outMap.keys()].filter((f) => !fields.includes(f));

    let h = `<div class="ssh-builder">`;
    h += `<div class="ssh-b-title">Match</div><div class="ssh-b-matches">`;
    h += (parsed.matches.length ? parsed.matches : [{ field: fields[0] || "", as: "" }])
      .map((p) => matchRowHtml(p, fields))
      .join("");
    h += `</div><a href="#" class="ssh-m-add">+ add match</a>`;

    h +=
      `<div class="ssh-b-title">Output ` +
      `<select class="ssh-out-kw">` +
      `<option${parsed.outKeyword !== "OUTPUTNEW" ? " selected" : ""}>OUTPUT</option>` +
      `<option${parsed.outKeyword === "OUTPUTNEW" ? " selected" : ""}>OUTPUTNEW</option>` +
      `</select></div>`;
    const withSamples = settings.lookupSamples;
    const cols = withSamples ? "" : " ssh-2col";
    h +=
      `<div class="ssh-o-head${cols}"><span>Field</span><span>AS</span>` +
      (withSamples ? `<span>Sample</span>` : "") +
      `</div>`;
    h += `<div class="ssh-b-outputs">`;
    for (const f of [...fields, ...extras]) {
      const inc = outMap.has(f);
      const alias = outMap.get(f) || "";
      const sv = sampleText(sample ? sample[f] : undefined);
      h +=
        `<div class="ssh-o-row${cols}${inc ? "" : " ssh-o-off"}">` +
        `<label><input type="checkbox" class="ssh-o-inc" data-field="${esc(f)}"${inc ? " checked" : ""}>` +
        `<span class="ssh-o-name">${esc(f)}${extras.includes(f) ? " ⚠" : ""}</span></label>` +
        `<input class="ssh-o-as" type="text" value="${esc(alias)}" placeholder="${esc(f)}"${inc ? "" : " disabled"}>` +
        (withSamples
          ? `<span class="ssh-o-sample" data-field="${esc(f)}" title="${esc(sv)}">${esc(sv)}</span>`
          : "") +
        `</div>`;
    }
    h += `</div>`;
    h +=
      `<div class="ssh-b-actions">` +
      `<a href="#" class="ssh-action ssh-apply">Apply to search</a>` +
      `<span class="ssh-b-status"></span>` +
      `</div>`;
    h += `</div>`;
    return h;
  }

  // Read-only sample explorer for inputlookup/outputlookup hovers: same
  // preview machinery as the builder (.ssh-m-field/.ssh-m-sample inputs and
  // .ssh-o-sample cells drive the shared handlers), minus clause editing.
  function explorerHtml(fields, sample) {
    // Nothing to explore without samples — show the fields and stop.
    if (!settings.lookupSamples) {
      return (
        `<div class="ssh-builder"><div class="ssh-b-title">Fields</div>` +
        fieldsHtml(fields) +
        `</div>`
      );
    }
    let h = `<div class="ssh-builder">`;
    h += `<div class="ssh-b-title">Preview</div>`;
    h += `<div class="ssh-m-row">`;
    h += `<select class="ssh-m-field">${fields
      .map((f) => fieldOption(f, false, false))
      .join("")}</select>`;
    h += `<input class="ssh-m-sample" type="text" placeholder="try a value…" title="Type a value to preview the matching row">`;
    h += `</div>`;
    h += `<div class="ssh-o-head ssh-2col"><span>Field</span><span>Sample</span></div>`;
    h += `<div class="ssh-b-outputs">`;
    for (const f of fields) {
      const sv = sampleText(sample ? sample[f] : undefined);
      h +=
        `<div class="ssh-o-row ssh-2col">` +
        `<span class="ssh-o-name">${esc(f)}</span>` +
        `<span class="ssh-o-sample" data-field="${esc(f)}" title="${esc(sv)}">${esc(sv)}</span>` +
        `</div>`;
    }
    h += `</div></div>`;
    return h;
  }

  function collectBuilder() {
    const p = {
      opts: builderCtx.parsed.opts,
      name: builderCtx.parsed.name,
      outKeyword: popup.querySelector(".ssh-out-kw").value,
      matches: [],
      outputs: [],
    };
    popup.querySelectorAll(".ssh-m-row").forEach((row) => {
      const field = row.querySelector(".ssh-m-field").value.trim();
      const as = row.querySelector(".ssh-m-as").value.trim();
      if (field) p.matches.push({ field, as });
    });
    popup.querySelectorAll(".ssh-o-row").forEach((row) => {
      const inc = row.querySelector(".ssh-o-inc");
      if (!inc.checked) return;
      p.outputs.push({
        field: inc.dataset.field,
        as: row.querySelector(".ssh-o-as").value.trim(),
      });
    });
    return p;
  }

  function applyBuilder() {
    if (!builderCtx) return;
    const text = emitLookupClause(collectBuilder());
    window.postMessage(
      {
        source: "ssh-x",
        type: "replace",
        row: builderCtx.token.row,
        start: builderCtx.token.clauseStart,
        end: builderCtx.token.clauseEnd,
        oldText: builderCtx.token.clauseText,
        text,
      },
      window.location.origin
    );
  }

  function render(token, resolved) {
    const el = ensurePopup();
    let html =
      `<div class="ssh-head"><span class="ssh-kind">${KIND_LABEL[token.kind]}</span>` +
      `<span class="ssh-name">${esc(token.name)}</span></div>`;

    const willWrite = token.cmd === "outputlookup";

    if (resolved.error) {
      html += `<div class="ssh-err">Lookup failed: ${esc(resolved.error)}</div>`;
    } else if (resolved.forbidden) {
      // 403, not 404 — say so plainly rather than implying a typo.
      html +=
        `<div class="ssh-entry"><div class="ssh-meta">` +
        `Your role can't read this object's details.</div></div>`;
    } else if (resolved.notFound) {
      // A missing outputlookup target is the normal case, not an error.
      html += willWrite
        ? `<div class="ssh-ok">New file — this search will create it.</div>`
        : `<div class="ssh-err">Not found — typo, or not shared to an app you can see.</div>`;
    } else {
      if (willWrite) {
        html +=
          `<div class="ssh-warn">⚠ This ${
            token.kind === "lookup_file" ? "file" : "lookup"
          } already exists — running this search overwrites it` +
          `${resolved.rows != null ? `, replacing ${esc(fmtInt(resolved.rows))} row${resolved.rows === 1 ? "" : "s"}` : ""}.</div>`;
      }
      resolved.entries.forEach((e) => {
        const multi = resolved.entries.length > 1;
        html += `<div class="ssh-entry">`;
        if (multi) html += `<div class="ssh-app">app: ${esc(e.app)}</div>`;

        if (token.kind === "saved_search") {
          if (e.description) {
            html += `<div class="ssh-meta">${esc(e.description)}</div>`;
          }
          html += `<pre class="ssh-def">${esc(e.search)}</pre>`;
          const bits = [`app: ${e.app}`, `owner: ${e.owner}`];
          if (e.disabled === true || e.disabled === "1") bits.push("disabled");
          if (e.alertType && e.alertType !== "always") {
            bits.push(`alert: ${e.alertType}`);
          }
          if (e.scheduled === true || e.scheduled === "1") {
            bits.push(e.cron ? `schedule: ${e.cron}` : "scheduled");
          }
          html += `<div class="ssh-meta">${esc(bits.join(" · "))}</div>`;
          const next = fmtTime(e.nextRun);
          if (next) html += `<div class="ssh-meta">next run: ${esc(next)}</div>`;
          html +=
            `<a class="ssh-action" target="_blank" rel="noopener" ` +
            `href="${savedSearchEditUrl(token.name, e.app, e.owner)}">Open report ↗</a>`;
        } else if (token.kind === "index") {
          const bits = [];
          if (e.events != null) bits.push(`${fmtInt(e.events)} events`);
          if (e.sizeMB != null) bits.push(`${fmtInt(e.sizeMB)} MB`);
          if (e.datatype && e.datatype !== "event") bits.push(e.datatype);
          if (e.disabled === true || e.disabled === "1") bits.push("disabled");
          if (bits.length) {
            html += `<div class="ssh-meta">${esc(bits.join(" · "))}</div>`;
          }
          const from = fmtTime(e.minTime);
          const to = fmtTime(e.maxTime);
          if (from || to) {
            html += `<div class="ssh-meta">${esc(from || "?")} → ${esc(to || "?")}</div>`;
          }
          html +=
            `<a class="ssh-action" target="_blank" rel="noopener" ` +
            `href="${indexManagerUrl(token.name)}">Open indexes ↗</a>`;
        } else if (token.kind === "datamodel") {
          const bits = [`app: ${e.app}`];
          if (e.accelerated) {
            bits.push(e.accelRange ? `accelerated (${e.accelRange})` : "accelerated");
          }
          html += `<div class="ssh-meta">${esc(bits.join(" · "))}</div>`;
          if (e.dataset) {
            html += e.datasetMissing
              ? `<div class="ssh-err">No dataset "${esc(e.dataset)}" in this model.</div>`
              : `<div class="ssh-meta">dataset: ${esc(e.dataset)}</div>`;
          }
          // With a dataset named, its fields are the useful thing; otherwise
          // the list of datasets is.
          const chips = e.fields && e.fields.length ? e.fields : e.datasets;
          if (chips && chips.length) {
            html += `<div class="ssh-meta">${e.fields ? "fields" : "datasets"}</div>`;
            html += fieldsHtml(chips);
          }
          html +=
            `<a class="ssh-action" target="_blank" rel="noopener" ` +
            `href="${datamodelManagerUrl(token.name)}">Open data models ↗</a>`;
        } else if (token.kind === "macro") {
          // Show the definition as it will actually run: arguments from this
          // call site substituted for $name$.
          html += `<pre class="ssh-def">${substituteArgsHtml(
            e.definition,
            e.args,
            token.args
          )}</pre>`;
          if (e.args) {
            const names = e.args.split(",").map((n) => n.trim()).filter(Boolean);
            const pairs = token.args
              ? names.map((n, i) => `${n}=${unquote(token.args[i] || "")}`)
              : names;
            html += `<div class="ssh-meta">args: ${esc(pairs.join(", "))}</div>`;
          }
          html +=
            `<a class="ssh-action" target="_blank" rel="noopener" ` +
            `href="${macroEditUrl(token.restName, e.app, e.owner)}">Open definition ↗</a>` +
            `<a class="ssh-action ssh-expand" href="#" ` +
            `title="Copy this macro fully expanded, nested macros included">Copy expanded</a>`;
        } else if (token.kind === "lookup_file") {
          if (!multi) html += `<div class="ssh-app">app: ${esc(e.app)}</div>`;
          html +=
            `<a class="ssh-action" target="_blank" rel="noopener" ` +
            `href="${lookupEditorUrl(token.name, e.app)}">Edit lookup ↗</a>`;
        } else {
          const backing = e.filename
            ? `file: ${esc(e.filename)}`
            : e.collection
              ? `KV store: ${esc(e.collection)}`
              : e.external_cmd
                ? `external: ${esc(e.external_cmd)}`
                : "no backing file";
          html += `<div class="ssh-meta">${backing}</div>`;
          html +=
            `<a class="ssh-action" target="_blank" rel="noopener" ` +
            `href="${transformsEditUrl(token.name, e.app, e.owner)}">Edit definition ↗</a>`;
          if (e.filename && e.filename.toLowerCase().endsWith(".csv")) {
            html +=
              `<a class="ssh-action" target="_blank" rel="noopener" ` +
              `href="${lookupEditorUrl(e.filename, e.app)}">Edit backing file ↗</a>`;
          }
        }
        html += `</div>`;
      });

      // Clause builder for `| lookup` hovers; read-only sample explorer for
      // inputlookup/outputlookup hovers. Both need known fields.
      // The explorer stays on outputlookup hovers: seeing what the file
      // currently holds is the point of the warning above it.
      macroCtx = token.kind === "macro" ? token : null;

      builderCtx = null;
      if (token.kind === "lookup_file" || token.kind === "lookup_def") {
        const withFields = resolved.entries.find(
          (e) => e.fields && e.fields.length
        );
        if (withFields) {
          const parsed = token.clauseText
            ? parseLookupClause(token.clauseText)
            : null;
          builderCtx = {
            token,
            parsed,
            fields: withFields.fields,
            sample: withFields.sample || null,
            name: token.name,
          };
          html += token.clauseText
            ? builderHtml(parsed, withFields.fields, withFields.sample || null)
            : explorerHtml(withFields.fields, withFields.sample || null);
        }
      }
    }
    el.innerHTML = html;
  }

  // ---------------------------------------------------------------------------
  // Clipboard
  // ---------------------------------------------------------------------------

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback for stricter contexts
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { /* noop */ }
      ta.remove();
      return ok;
    }
  }

  // ---------------------------------------------------------------------------
  // Copy-field affordances: table headers copy from their own label text (no
  // icon, no reflow); the field-info dialog uses icon buttons.
  // ---------------------------------------------------------------------------

  const COPY_SVG =
    `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">` +
    `<path fill="currentColor" d="M5 1h8a1 1 0 0 1 1 1v8h-2V3H5V1z"/>` +
    `<path fill="currentColor" d="M2 4h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v7h6V6H3z"/>` +
    `</svg>`;
  const CHECK_SVG =
    `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">` +
    `<path fill="currentColor" d="M6.2 12.6 2 8.4l1.4-1.4 2.8 2.8 6.4-6.4L14 4.8z"/>` +
    `</svg>`;

  function flashCopied(btn) {
    btn.innerHTML = CHECK_SVG;
    btn.classList.add("ssh-copied");
    setTimeout(() => {
      btn.innerHTML = COPY_SVG;
      btn.classList.remove("ssh-copied");
    }, 900);
  }

  function makeCopyBtn(field, className) {
    const btn = document.createElement("a");
    btn.href = "#";
    btn.setAttribute("role", "button");
    btn.className = className;
    btn.title = `Copy "${field}"`;
    btn.setAttribute("aria-label", `Copy field name ${field}`);
    btn.innerHTML = COPY_SVG;
    btn.addEventListener("mousedown", (ev) => ev.stopPropagation());
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (await copyText(field)) flashCopied(btn);
    });
    return btn;
  }

  // Statistics / dashboard headers: no icon is added — the field name itself
  // is the copy target, so the header never changes size or layout. The sort
  // arrows and the format paintbrush are left alone and keep sorting.
  function labelNode(th, field) {
    const walker = document.createTreeWalker(th, NodeFilter.SHOW_TEXT);
    let first = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement.closest(".ssh-hdr")) return null; // already wrapped
      const text = n.nodeValue.trim();
      if (!text) continue;
      if (text === field) return n;
      if (!first) first = n;
    }
    // Display text can differ from the sort key (renamed columns).
    return first;
  }

  // blockMousedown: the Statistics header binds its sort to the header itself,
  // so mousedown has to stop too. Events headers are jQuery-UI drag handles —
  // stopping mousedown there would kill column reordering from the name, so
  // only the click (the sort) is intercepted; a real drag suppresses it.
  function wrapLabel(th, field, blockMousedown) {
    const node = labelNode(th, field);
    if (!node) return;

    const span = document.createElement("span");
    span.className = "ssh-hdr";
    span.title = `Click to copy "${field}"`;
    span.textContent = node.nodeValue;
    node.parentNode.replaceChild(span, node);

    if (blockMousedown) {
      span.addEventListener("mousedown", (ev) => ev.stopPropagation());
    }
    span.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!(await copyText(field))) return;
      span.classList.add("ssh-copied");
      setTimeout(() => span.classList.remove("ssh-copied"), 900);
    });
  }

  function decorateHeaders(root) {
    if (!settings.copyStatHeaders) return;
    root.querySelectorAll("th[data-sort-key]").forEach((th) => {
      if (th.dataset.sortKey) wrapLabel(th, th.dataset.sortKey, true);
    });
  }

  function undecorateHeaders(selector) {
    document.querySelectorAll(selector + " .ssh-hdr").forEach((span) => {
      span.replaceWith(document.createTextNode(span.textContent));
    });
  }

  // Field-info popdown on the Events tab (click a field in the sidebar):
  // copy icon beside the field name in the header, and beside each value.
  function decorateFieldInfo(root) {
    if (!settings.copyFieldDialog) return;
    root.querySelectorAll("h2.field-info-header").forEach((h2) => {
      if (h2.querySelector(".ssh-copy")) return;
      const field = h2.textContent.trim();
      if (!field) return;
      h2.appendChild(makeCopyBtn(field, "ssh-copy ssh-copy-inline"));
    });

    // Values table: data-value holds the raw value (display can truncate).
    root
      .querySelectorAll("table.table-field-values td.value a[data-value]")
      .forEach((a) => {
        if (a.parentElement.querySelector(".ssh-copy")) return;
        const val = a.dataset.value;
        if (val === undefined) return;
        a.before(makeCopyBtn(val, "ssh-copy ssh-copy-value"));
      });
  }

  // Events tab, View: Table — headers are th.reorderable[data-name].
  // _time has no data-name; its aria-label carries the field name.
  // Same treatment as the Statistics headers: the label text is the copy
  // target, nothing is added to the cell.
  function decorateEventsHeaders(root) {
    if (!settings.copyEventHeaders) return;
    root
      .querySelectorAll("th.reorderable[data-name], th.col-time")
      .forEach((th) => {
        const field = th.dataset.name || th.getAttribute("aria-label");
        if (field) wrapLabel(th, field, false);
      });
  }

  // Expanded-event field table: a "Copy Value" entry in each row's Actions
  // dropdown. Splunk builds that menu lazily and usually mounts it in a
  // body-level popdown, not inside the row — so rather than decorating the
  // table, note which row was clicked and inject into whatever menu opens.
  const MENU_ITEM_CLASS = "ssh-menu-item";
  const MENU_LABEL_MAX = 44;

  function elide(text, max) {
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }
  let menuValue = null;
  let menuField = null;

  // data-value carries the raw text where the display truncates.
  function cellText(cell) {
    if (!cell) return null;
    const raw = cell.querySelector("[data-value]");
    const val = raw ? raw.getAttribute("data-value") : cell.textContent;
    return (val || "").trim() || null;
  }

  function fieldOfHeader(h) {
    if (!h) return null;
    return (
      h.dataset.sortKey ||
      h.dataset.name ||
      (h.classList.contains("col-time") ? "_time" : null)
    );
  }

  // The column header names the field — for a results table. Returns null for
  // anything else, which is what tells the two table shapes apart.
  //
  // Matched on the column's left edge, NOT on cell index: the leading info /
  // expand column's header is not a <th>, so indexing a th list by the body
  // cell's position shifts every field one column right (a source cell
  // offering sourcetype). Columns in a table line up exactly, so geometry is
  // both simpler and immune to whatever the leading cells turn out to be.
  function headerField(td) {
    const table = td.closest("table");
    if (!table) return null;
    const heads = [...table.querySelectorAll("thead th, thead td")];
    if (!heads.length) return null;

    const left = td.getBoundingClientRect().left;
    let best = null;
    let bestDelta = Infinity;
    for (const h of heads) {
      const d = Math.abs(h.getBoundingClientRect().left - left);
      if (d < bestDelta) {
        bestDelta = d;
        best = h;
      }
    }
    // A column that doesn't line up isn't this cell's header.
    return bestDelta <= 4 ? fieldOfHeader(best) : null;
  }

  // Field cell of the expanded-event table: the one before Value. It also
  // holds a checkbox and a dropdown caret, so take the first field-shaped run
  // of text rather than the cell's whole textContent.
  function rowField(tr) {
    const cell =
      tr.querySelector("td.field") || tr.children[tr.children.length - 3];
    if (!cell) return null;
    const link = cell.querySelector("a");
    const text = ((link ? link.textContent : cell.textContent) || "").trim();
    const m = /[\w.:{}\[\]$-]+/.exec(text);
    return m ? m[0] : null;
  }

  // Two different tables open a menu from a cell click and they carry the
  // field name in completely different places:
  //   results table  — the clicked cell IS the value, its column header names
  //                    the field, and every cell is clickable.
  //   expanded event — Type | Field | Value | Actions, where only the last
  //                    cell opens a menu and the field is a sibling cell.
  // Getting these the wrong way round reads the neighbouring column as the
  // field name, which is how "Copy Spruce=..." happened on a sourcetype cell.
  function cellContext(td, tr) {
    const field = headerField(td);
    if (field) return { field, value: cellText(td) };
    if (td !== tr.lastElementChild) return null;
    return {
      field: rowField(tr),
      value: cellText(tr.querySelector("td.value") || tr.children[tr.children.length - 2]),
    };
  }

  // Popups mount asynchronously and the passes below are idempotent, so just
  // retry over the next few hundred ms rather than observing for them.
  function defer(fn) {
    requestAnimationFrame(fn);
    setTimeout(fn, 60);
    setTimeout(fn, 200);
  }

  function clearMenuItems() {
    document
      .querySelectorAll("." + MENU_ITEM_CLASS)
      .forEach((el) => el.remove());
  }

  // The Statistics drilldown popup is not a .dropdown-menu, so when no such
  // menu is open, fall back to the popup that carries the "field = value"
  // line — located by content, exactly as decoratePair does. Climb from it to
  // the container holding the popup's own action links, and append there.
  function pairHost(value) {
    let node = document.querySelector(".ssh-pair");
    if (!node) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.nodeValue.trim();
        if (!text.endsWith(value)) continue;
        const m = PAIR_RE.exec(text);
        if (m && m[3] === value) {
          node = n;
          break;
        }
      }
    }
    if (!node) return null;
    let el = node.parentElement;
    for (let i = 0; el && i < 8; i++, el = el.parentElement) {
      if (el.querySelectorAll("a").length >= 2) return el;
    }
    return null;
  }

  // Our entries can push a menu past the height Splunk sized it for, leaving
  // it scrolling when there is screen to spare. Grow whatever is scrolling to
  // the room actually available below it, and only keep a scrollbar if the
  // content still doesn't fit the viewport.
  function relaxScroll(start) {
    let el = start;
    for (let i = 0; el && i < 6; i++, el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (!/auto|scroll/.test(cs.overflowY)) continue;
      if (el.scrollHeight <= el.clientHeight + 2) continue; // not scrolling
      const room = Math.max(
        140,
        window.innerHeight - el.getBoundingClientRect().top - 12
      );
      el.style.maxHeight = `${Math.round(room)}px`;
      el.style.overflowY = el.scrollHeight > room ? "auto" : "visible";
    }
  }

  function injectMenuItem() {
    if (menuValue === null) return;
    const value = menuValue;
    const menus = [...document.querySelectorAll(".dropdown-menu")].filter(
      (m) => {
        const r = m.getBoundingClientRect();
        return r.width && r.height;
      }
    );
    if (!menus.length) {
      const host = pairHost(value);
      if (host) menus.push(host);
    }
    menus.forEach((menu) => {
      if (menu.querySelector("." + MENU_ITEM_CLASS)) return;

      const list = menu.querySelector("ul") || menu;
      const field = menuField;

      // Every entry is labelled with exactly what it will copy, elided to
      // keep the menu narrow. The clipboard always gets the full text, and
      // the tooltip carries it too.
      const items = [["Copy ", value]];
      if (field) items.push(["Copy ", `${field}="${escSplValue(value)}"`]);

      items.forEach(([prefix, payload]) => {
        const label = prefix + elide(payload, MENU_LABEL_MAX);
        const wrap = document.createElement(list.tagName === "UL" ? "li" : "div");
        wrap.className = MENU_ITEM_CLASS;
        const a = document.createElement("a");
        a.href = "#";
        a.textContent = label;
        a.title = payload;
        a.addEventListener("click", async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const ok = await copyText(payload);
          a.textContent = ok ? "Copied \u2713" : "Copy failed";
          setTimeout(() => {
            a.textContent = label;
          }, 900);
        });
        wrap.appendChild(a);
        list.appendChild(wrap);
      });
      relaxScroll(list);
    });
  }

  document.addEventListener(
    "click",
    (ev) => {
      const t = ev.target;
      if (!(t instanceof Element)) return;
      if (t.closest(".ssh-pair")) return; // our own copy targets
      if (t.closest("." + MENU_ITEM_CLASS)) return; // our own item
      // Any other click either opens a different menu or closes this one;
      // drop the stale entry so a reused menu never shows the wrong value.
      clearMenuItems();
      menuValue = null;
      menuField = null;
      pairValue = null;
      if (!settings.copyEventActions && !settings.copyDrilldownPair) return;

      const td = t.closest("td");
      const tr = td && td.parentElement;
      if (!td || !tr || tr.tagName !== "TR") return;

      const ctx = cellContext(td, tr);
      if (!ctx || ctx.value === null) return;

      if (settings.copyEventActions) {
        menuValue = ctx.value;
        menuField = ctx.field;
        defer(injectMenuItem);
      }
      if (settings.copyDrilldownPair) {
        pairValue = ctx.value;
        defer(decoratePair);
      }
    },
    true
  );

  // Drilldown popup on a results-table cell: the "field = value" line is
  // click-to-copy in two halves — the field name copies the whole pair as
  // field="value", the value copies itself bare. The popup carries no stable
  // class, so it is located by matching the exact pair text produced by the
  // cell that was clicked (the cell holds the value alone and the header the
  // field alone, so a "<something> = <that value>" node is the popup's).
  const PAIR_RE = /^(.+?)(\s*=\s*)(.+)$/;
  let pairValue = null;

  function copySpan(className, text, title, payload) {
    const span = document.createElement("span");
    span.className = "ssh-pair " + className;
    span.textContent = text;
    span.title = title;
    span.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation(); // keep the popup open to show the flash
      if (!(await copyText(payload))) return;
      span.classList.add("ssh-copied");
      setTimeout(() => span.classList.remove("ssh-copied"), 900);
    });
    return span;
  }

  function decoratePair() {
    if (pairValue === null) return;
    const value = pairValue;
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT
    );
    const hits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue.trim();
      if (!text.endsWith(value)) continue;
      const m = PAIR_RE.exec(text);
      if (!m || m[3] !== value) continue;
      if (n.parentElement.querySelector(".ssh-pair")) continue;
      hits.push({ node: n, field: m[1], sep: m[2] });
    }

    hits.forEach(({ node, field, sep }) => {
      const raw = node.nodeValue;
      const lead = raw.slice(0, raw.length - raw.trimStart().length);
      const tail = raw.slice(raw.trimEnd().length);
      const pair = `${field}="${escSplValue(value)}"`;

      const frag = document.createDocumentFragment();
      if (lead) frag.appendChild(document.createTextNode(lead));
      frag.appendChild(
        copySpan("ssh-pair-field", field, `Copy ${pair}`, pair)
      );
      frag.appendChild(document.createTextNode(sep));
      frag.appendChild(
        copySpan("ssh-pair-value", value, `Copy "${value}"`, value)
      );
      if (tail) frag.appendChild(document.createTextNode(tail));
      node.parentNode.replaceChild(frag, node);
    });
  }

  // ---------------------------------------------------------------------------
  // Copy the visible table
  //
  // Reads only what is rendered: the current page of rows, in the current sort
  // order, with the current columns. No REST call and no search dispatch — the
  // other 480 rows of a 500-row result set are simply not in the DOM, and
  // fetching them would be a different (and no longer passive) feature.
  // ---------------------------------------------------------------------------

  // Data columns only: the row-number, checkbox and expand cells carry no
  // field name and are skipped.
  function dataColumns(table) {
    const heads = table.querySelectorAll("thead th, tr:first-child th");
    const cols = [];
    heads.forEach((th) => {
      const field =
        th.dataset.sortKey ||
        th.dataset.name ||
        (th.classList.contains("col-time")
          ? th.getAttribute("aria-label") || "_time"
          : null);
      if (field) cols.push({ index: th.cellIndex, field: field.trim() });
    });
    return cols;
  }

  // A cell can hold several values (multivalue fields render one element
  // each). data-value carries the raw text where Splunk truncates the display.
  function cellValues(td) {
    if (!td) return [];
    const raw = td.querySelectorAll("[data-value]");
    if (raw.length) {
      return [...raw].map((el) => el.getAttribute("data-value"));
    }
    return (td.innerText || "")
      .split("\n")
      .map((v) => v.trim())
      .filter((v) => v !== "");
  }

  function tableMatrix(table) {
    const cols = dataColumns(table);
    if (!cols.length) return null;
    const rows = [];
    table.querySelectorAll("tbody tr").forEach((tr) => {
      // Expanded-event detail rows have no cells of their own.
      if (!tr.querySelector("td")) return;
      const cells = tr.children;
      rows.push(cols.map((c) => cellValues(cells[c.index])));
    });
    return { fields: cols.map((c) => c.field), rows };
  }

  function toTsv(m) {
    const cell = (vals) =>
      vals.join("; ").replace(/\t/g, " ").replace(/\s*\n\s*/g, " ");
    return [m.fields.join("\t"), ...m.rows.map((r) => r.map(cell).join("\t"))].join(
      "\n"
    );
  }

  function toMarkdown(m) {
    const cell = (vals) =>
      vals.join("<br>").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
    const head = `| ${m.fields.map((f) => f.replace(/\|/g, "\\|")).join(" | ")} |`;
    const rule = `| ${m.fields.map(() => "---").join(" | ")} |`;
    const body = m.rows.map((r) => `| ${r.map(cell).join(" | ")} |`);
    return [head, rule, ...body].join("\n");
  }

  // The popup is ours, but it sits on a Splunk page that may be light or dark.
  // Sampling the body is more reliable than guessing the theme class.
  function themeColors() {
    const cs = getComputedStyle(document.body);
    return { bg: cs.backgroundColor || "#fff", fg: cs.color || "#333" };
  }

  function resultTables(root) {
    const tables = new Set();
    root
      .querySelectorAll("th[data-sort-key], th.reorderable")
      .forEach((th) => {
        const table = th.closest("table");
        if (table) tables.add(table);
      });
    return [...tables];
  }

  // The search page has one results table, but which one it is changes with
  // the tab (Events / Statistics), so resolve it at click time.
  function visibleResultTable() {
    return (
      resultTables(document).find((t) => t.getBoundingClientRect().height) ||
      null
    );
  }

  // Menus live on <body> as position:fixed so they can never be clipped by,
  // or disturb the layout of, whatever they hang from.
  function buildMenu(items) {
    const menu = document.createElement("div");
    menu.className = "ssh-tblcopy-menu";
    menu.hidden = true;
    const theme = themeColors();
    menu.style.background = theme.bg;
    menu.style.color = theme.fg;

    items.forEach(({ label, run }) => {
      const item = document.createElement("a");
      item.href = "#";
      item.textContent = label;
      item.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const done = await run();
        if (done === undefined) {
          menu.hidden = true;
          return;
        }
        // Report the outcome in place — the anchor may be Splunk's own
        // button, which we must not mutate.
        item.textContent = done;
        setTimeout(() => {
          item.textContent = label;
          menu.hidden = true;
        }, 900);
      });
      menu.appendChild(item);
    });

    document.body.appendChild(menu);
    return menu;
  }

  function openMenuAt(menu, el) {
    const r = el.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 3)}px`;
    menu.style.left = `${Math.round(r.right)}px`;
    menu.hidden = false;
  }

  function copyItems(getTable) {
    return [
      ["Copy as TSV", toTsv],
      ["Copy as Markdown", toMarkdown],
    ].map(([label, fmt]) => ({
      label,
      run: async () => {
        const table = getTable();
        const m = table && tableMatrix(table);
        if (!m || !m.rows.length) return "Nothing to copy";
        if (!(await copyText(fmt(m)))) return "Copy failed";
        const n = m.rows.length;
        return `Copied ${n} row${n === 1 ? "" : "s"} ✓`;
      },
    }));
  }

  // One listener for every menu — anchors are rebuilt whenever Splunk
  // re-renders, so per-anchor listeners would pile up.
  function closeTableMenus() {
    document
      .querySelectorAll(".ssh-tblcopy-menu")
      .forEach((m) => (m.hidden = true));
  }
  document.addEventListener("click", closeTableMenus);

  // ---------------------------------------------------------------------------
  // Export button takeover
  //
  // Splunk's export button downloads immediately. Clicking it now opens a menu
  // whose first entry is that same export, with the copy formats beneath. The
  // button is Splunk's own: nothing about it is modified, the click is simply
  // intercepted in the capture phase (on document, so it lands before any
  // handler bound to the button itself) and replayed under a bypass flag when
  // "Export as File" is chosen.
  // ---------------------------------------------------------------------------

  let exportMenu = null;
  let exportAnchor = null;
  let exportBypass = false;

  const STRIP_ICONS =
    "[class*='icon-print'], [class*='icon-share'], [class*='icon-pause']," +
    " [class*='icon-stop'], [class*='icon-export'], [class*='icon-download']";

  // The one place that decides what the job-control export button is. Both
  // the click hook and the dashboard fallback ask this, so they can never
  // disagree and leave the page with a menu AND a redundant Copy table bar.
  function findExportButton() {
    for (const icon of document.querySelectorAll(
      "[class*='icon-export'], [class*='icon-download']"
    )) {
      const btn = icon.closest("a, button");
      if (!btn) continue;
      // Needs a neighbouring control to prove it's the strip and not a
      // dashboard panel's own export. Buttons may sit in one group or in
      // adjacent groups, so look at the parent and the one above it.
      for (const scope of [btn.parentElement, btn.parentElement?.parentElement]) {
        if (!scope) continue;
        const others = [...scope.querySelectorAll(STRIP_ICONS)].filter(
          (el) => !btn.contains(el)
        );
        if (others.length) return btn;
      }
    }
    return null;
  }

  function ensureExportMenu() {
    if (exportMenu) return exportMenu;
    exportMenu = buildMenu([
      {
        label: "Export as File",
        run: () => {
          // Replay the original click; the capture hook stands aside for it.
          const btn = exportAnchor;
          exportBypass = true;
          try {
            if (btn) btn.click();
          } finally {
            exportBypass = false;
          }
        },
      },
      ...copyItems(visibleResultTable),
    ]);
    return exportMenu;
  }

  document.addEventListener(
    "click",
    (ev) => {
      if (exportBypass || !settings.copyTable) return;
      const t = ev.target;
      if (!(t instanceof Element)) return;
      const btn = t.closest("a, button");
      if (!btn || btn !== findExportButton()) return;

      ev.preventDefault();
      ev.stopPropagation();
      const menu = ensureExportMenu();
      const open = menu.hidden;
      closeTableMenus();
      if (!open) return;
      exportAnchor = btn;
      openMenuAt(menu, btn);
    },
    true
  );

  // Dashboards have no job-control strip — give each table its own button.
  let warnedNoExport = false;
  function decorateTables(root) {
    if (!settings.copyTable) return;
    if (findExportButton()) return; // the export menu covers this page
    if (!warnedNoExport) {
      warnedNoExport = true;
      console.log("[SSH] no export button found — using the Copy table bar");
    }

    resultTables(root).forEach((table) => {
      const prev = table.previousElementSibling;
      if (prev && prev.classList.contains("ssh-tblbar")) return;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ssh-tblcopy-btn";
      btn.textContent = "Copy table ▾";
      btn.title = "Copy the rows shown on this page";
      const menu = buildMenu(copyItems(() => table));
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const open = menu.hidden;
        closeTableMenus();
        if (open) openMenuAt(menu, btn);
      });

      const bar = document.createElement("div");
      bar.className = "ssh-tblbar";
      bar.appendChild(btn);
      table.parentNode.insertBefore(bar, table);
    });
  }

  // Results tables and field-info dialogs re-render on interaction —
  // re-decorate on DOM changes, coalesced to one pass per frame.
  function decorateAll() {
    decorateTables(document);
    decorateHeaders(document);
    decorateEventsHeaders(document);
    decorateFieldInfo(document);
  }
  let decorateRaf = null;
  const tableObserver = new MutationObserver(() => {
    if (decorateRaf) return;
    decorateRaf = requestAnimationFrame(() => {
      decorateRaf = null;
      decorateAll();
    });
  });
  tableObserver.observe(document.body, { childList: true, subtree: true });
  decorateAll();

  // ---------------------------------------------------------------------------
  // Message wiring
  // ---------------------------------------------------------------------------

  window.addEventListener("message", async (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.source !== MSG_SOURCE) return;

    if (msg.type === "hover") {
      if (!enabledFor(msg.token.kind)) return;
      cancelHide();
      anchor = { x: msg.x, y: msg.y };
      const el = ensurePopup();
      el.innerHTML =
        `<div class="ssh-head"><span class="ssh-kind">${KIND_LABEL[msg.token.kind]}</span>` +
        `<span class="ssh-name">${esc(msg.token.name)}</span></div>` +
        `<div class="ssh-meta">resolving…</div>`;
      position(el, msg.x, msg.y);

      // An outputlookup target is the one thing guaranteed to change under
      // us — the search being written creates or rewrites it — so never serve
      // that guard from cache.
      const resolved = await resolve(msg.token, {
        fresh: msg.token.cmd === "outputlookup",
      });
      if (msg.token.cmd === "outputlookup" && resolved.entries) {
        resolved.rows = await fetchRowCount(msg.token.name);
      }
      render(msg.token, resolved);
      position(el, msg.x, msg.y);
    } else if (msg.type === "tokens") {
      markUnknownTokens(msg.tokens || []);
    } else if (msg.type === "replace-done") {
      const st = popup && popup.querySelector(".ssh-b-status");
      if (st) {
        st.textContent = "Applied ✓";
        st.className = "ssh-b-status ssh-b-ok";
      }
      setTimeout(() => {
        if (popup) popup.style.display = "none";
      }, 650);
    } else if (msg.type === "replace-failed") {
      const st = popup && popup.querySelector(".ssh-b-status");
      if (st) {
        st.textContent = "Line changed since hover — re-hover and retry";
        st.className = "ssh-b-status ssh-b-err";
      }
    } else if (msg.type === "clear" || msg.type === "editor-leave") {
      // Only hide if the pointer isn't travelling toward / sitting on the
      // popup. The corridor covers the popup rect (+pad) and the hover point.
      if (!inCorridor()) scheduleHide();
    }
  });
})();
