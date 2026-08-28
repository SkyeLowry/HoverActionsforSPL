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
    lookupSamples: true,
    copyStatHeaders: true,
    copyEventHeaders: true,
    copyFieldDialog: true,
  };

  function applyCopySettings() {
    if (!settings.copyStatHeaders) {
      document
        .querySelectorAll("th[data-sort-key] .ssh-copy")
        .forEach((b) => b.remove());
    }
    if (!settings.copyEventHeaders) {
      document
        .querySelectorAll("th.reorderable .ssh-copy, th.col-time .ssh-copy")
        .forEach((b) => b.remove());
    }
    if (!settings.copyFieldDialog) {
      document
        .querySelectorAll(".field-info-header .ssh-copy, .ssh-copy-value")
        .forEach((b) => b.remove());
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
      if (!settings.hoverMacros && !settings.hoverLookups && popup) {
        popup.style.display = "none";
      }
    });
  }

  // ---------------------------------------------------------------------------
  // REST resolver with per-tab cache
  // ---------------------------------------------------------------------------

  const cache = new Map(); // key: kind|name → resolved object or Error marker

  async function restGet(path) {
    const resp = await fetch(path, { credentials: "same-origin" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  async function resolve(token) {
    const key = `${token.kind}|${token.restName || token.name}`;
    if (cache.has(key)) return cache.get(key);

    let result;
    try {
      if (token.kind === "macro") {
        result = await resolveMacro(token);
      } else if (token.kind === "lookup_file") {
        result = await resolveLookupFile(token);
      } else {
        result = await resolveLookupDef(token);
      }
    } catch (e) {
      result = { error: e.message || String(e) };
    }
    cache.set(key, result);
    return result;
  }

  async function resolveMacro(token) {
    const name = encodeURIComponent(token.restName);
    const data = await restGet(
      `${RAW}/servicesNS/-/-/admin/macros/${name}?output_mode=json&count=0`
    );
    if (!data.entry || data.entry.length === 0) return { notFound: true };
    return {
      entries: data.entry.map((e) => ({
        app: e.acl.app,
        owner: e.acl.owner,
        definition: e.content.definition,
        args: e.content.args,
      })),
    };
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

  function ensurePopup() {
    if (popup) return popup;
    popup = document.createElement("div");
    popup.id = "ssh-popup";
    popup.addEventListener("mouseenter", () => cancelHide());
    popup.addEventListener("mouseleave", () => scheduleHide());
    // Field chips are click-to-copy; builder controls are delegated here too
    // since the popup body is rebuilt on every hover.
    popup.addEventListener("click", async (ev) => {
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
        const filters = [...popup.querySelectorAll(".ssh-m-row")].map((r) => ({
          field: r.querySelector(".ssh-m-field").value,
          value: r.querySelector(".ssh-m-sample").value,
        }));
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
  };

  const MAX_FIELD_CHIPS = 24;

  function fieldsHtml(fields) {
    if (!fields || fields.length === 0) return "";
    const shown = fields.slice(0, MAX_FIELD_CHIPS);
    let h = `<div class="ssh-fields">`;
    h += shown.map((f) => `<span class="ssh-field">${esc(f)}</span>`).join("");
    if (fields.length > shown.length) {
      h += `<span class="ssh-field ssh-field-more">+${fields.length - shown.length} more</span>`;
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
      `<input class="ssh-m-sample" type="text" placeholder="try a value…" title="Type a value to preview the matching row">` +
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
    h += `<div class="ssh-o-head"><span>Field</span><span>AS</span><span>Sample</span></div>`;
    h += `<div class="ssh-b-outputs">`;
    for (const f of [...fields, ...extras]) {
      const inc = outMap.has(f);
      const alias = outMap.get(f) || "";
      const sv = sampleText(sample ? sample[f] : undefined);
      h +=
        `<div class="ssh-o-row${inc ? "" : " ssh-o-off"}">` +
        `<label><input type="checkbox" class="ssh-o-inc" data-field="${esc(f)}"${inc ? " checked" : ""}>` +
        `<span class="ssh-o-name">${esc(f)}${extras.includes(f) ? " ⚠" : ""}</span></label>` +
        `<input class="ssh-o-as" type="text" value="${esc(alias)}" placeholder="${esc(f)}"${inc ? "" : " disabled"}>` +
        `<span class="ssh-o-sample" data-field="${esc(f)}" title="${esc(sv)}">${esc(sv)}</span>` +
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

    if (resolved.error) {
      html += `<div class="ssh-err">Lookup failed: ${esc(resolved.error)}</div>`;
    } else if (resolved.notFound) {
      html += `<div class="ssh-err">Not found — typo, or not shared to an app you can see.</div>`;
    } else {
      resolved.entries.forEach((e) => {
        const multi = resolved.entries.length > 1;
        html += `<div class="ssh-entry">`;
        if (multi) html += `<div class="ssh-app">app: ${esc(e.app)}</div>`;

        if (token.kind === "macro") {
          html += `<pre class="ssh-def">${esc(e.definition)}</pre>`;
          if (e.args) html += `<div class="ssh-meta">args: ${esc(e.args)}</div>`;
          html +=
            `<a class="ssh-action" target="_blank" rel="noopener" ` +
            `href="${macroEditUrl(token.restName, e.app, e.owner)}">Open definition ↗</a>`;
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
  // Copy-field buttons on results table headers
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
    // Events-table headers are jQuery-UI drag handles — a mousedown on the
    // icon would start a column reorder. Stop it at the source.
    btn.addEventListener("mousedown", (ev) => ev.stopPropagation());
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (await copyText(field)) flashCopied(btn);
    });
    return btn;
  }

  function decorateHeaders(root) {
    if (!settings.copyStatHeaders) return;
    root.querySelectorAll("th[data-sort-key]").forEach((th) => {
      if (th.querySelector(".ssh-copy")) return;
      const field = th.dataset.sortKey;
      if (!field) return;

      // suppress-sort is Splunk's own class for header buttons that must not
      // trigger the column sort (the paintbrush uses it).
      const btn = makeCopyBtn(field, "ssh-copy suppress-sort pull-right");
      const fmt = th.querySelector(".btn-col-format");
      if (fmt) fmt.after(btn);
      else th.appendChild(btn);
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
  function decorateEventsHeaders(root) {
    if (!settings.copyEventHeaders) return;
    root.querySelectorAll("th.reorderable[data-name], th.col-time").forEach((th) => {
      if (th.querySelector(".ssh-copy")) return;
      const field = th.dataset.name || th.getAttribute("aria-label");
      if (!field) return;
      th.appendChild(makeCopyBtn(field, "ssh-copy"));
    });
  }

  // Results tables and field-info dialogs re-render on interaction —
  // re-decorate on DOM changes, coalesced to one pass per frame.
  function decorateAll() {
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
      const isMacro = msg.token.kind === "macro";
      if (isMacro && !settings.hoverMacros) return;
      if (!isMacro && !settings.hoverLookups) return;
      cancelHide();
      anchor = { x: msg.x, y: msg.y };
      const el = ensurePopup();
      el.innerHTML =
        `<div class="ssh-head"><span class="ssh-kind">${KIND_LABEL[msg.token.kind]}</span>` +
        `<span class="ssh-name">${esc(msg.token.name)}</span></div>` +
        `<div class="ssh-meta">resolving…</div>`;
      position(el, msg.x, msg.y);

      const resolved = await resolve(msg.token);
      render(msg.token, resolved);
      position(el, msg.x, msg.y);
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
