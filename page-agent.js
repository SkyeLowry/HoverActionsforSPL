/**
 * Hover Actions for SPL — page agent (MAIN world)
 *
 * Runs in the page's JS context so it can reach the Ace editor instance that
 * Splunk attaches to each .ace_editor element (el.env.editor). Uses Ace's own
 * coordinate APIs, so soft-wrapped lines and re-renders are non-issues.
 *
 * Emits window.postMessage events consumed by content.js (isolated world):
 *   { source: "ssh", type: "hover",  token: {...}, x, y }
 *   { source: "ssh", type: "clear" }
 *   { source: "ssh", type: "tokens", tokens: [...] }   (for mark-unknown)
 */
(() => {
  "use strict";

  const MSG_SOURCE = "ssh";
  const HOVER_DELAY_MS = 250;
  const SCAN_DELAY_MS = 800;

  // ---------------------------------------------------------------------------
  // Line tokenizer: find actionable tokens in one logical line of SPL.
  // Returns [{ kind, name, args, start, end }] with start/end as column offsets.
  //   start/end  the name itself — what gets rewritten and underlined
  //   hitStart/hitEnd  what counts as a hover, widened to include the command
  //         keyword ("inputlookup foo.csv" is all hoverable, not just the
  //         file name). Falls back to start/end when absent.
  //   kind: "macro" | "lookup_file" | "lookup_def" | "saved_search" | "index"
  //   cmd:  for lookups, which command introduced it (lookup / inputlookup /
  //         outputlookup) — outputlookup means "will be written", which
  //         changes both the popup and whether a missing file is an error
  // ---------------------------------------------------------------------------

  // Split macro args on commas, respecting quotes — arg COUNT is part of the
  // REST name: `foo(a,b)` is stored as foo(2).
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

  function tokenizeLine(line) {
    const tokens = [];

    // 1. Macros: `name` or `name(args)`
    const macroRe = /`\s*([\w.:-]+)(?:\(([^`]*)\))?\s*`/g;
    for (let m; (m = macroRe.exec(line)); ) {
      const args = m[2] !== undefined ? splitMacroArgs(m[2]) : null;
      tokens.push({
        kind: "macro",
        name: m[1],
        // The values, not just the count — the popup substitutes them into
        // the definition in place of $argname$.
        args: args ? args.map((a) => a.trim()) : null,
        restName: args ? `${m[1]}(${args.length})` : m[1],
        start: m.index,
        end: m.index + m[0].length,
      });
    }

    // 2. inputlookup / outputlookup <file-or-def>
    //    Skip leading key=value options (append=t, override_if_empty=f, ...).
    const ioRe = /\b(inputlookup|outputlookup)\s+((?:[\w-]+\s*=\s*\S+\s+)*)([\w.$-]+)/gi;
    for (let m; (m = ioRe.exec(line)); ) {
      const name = m[3];
      const start = m.index + m[0].length - name.length;
      tokens.push({
        kind: name.toLowerCase().endsWith(".csv") ? "lookup_file" : "lookup_def",
        cmd: m[1].toLowerCase(),
        name,
        start,
        end: start + name.length,
        hitStart: m.index,
        hitEnd: start + name.length,
      });
    }

    // 3. | lookup [options] <name> — also capture the whole clause extent so
    //    the builder can parse and rewrite it. Quote-aware scan to the next
    //    unquoted pipe / closing bracket.
    function clauseEndIdx(from) {
      let inQ = null;
      for (let i = from; i < line.length; i++) {
        const ch = line[i];
        if (inQ) { if (ch === inQ) inQ = null; continue; }
        if (ch === '"' || ch === "'") inQ = ch;
        else if (ch === "|" || ch === "]") return i;
      }
      return line.length;
    }
    const lkRe = /(?:^|\|)\s*lookup\s+((?:[\w-]+\s*=\s*\S+\s+)*)([\w.$-]+)/gi;
    for (let m; (m = lkRe.exec(line)); ) {
      const name = m[2];
      const start = m.index + m[0].length - name.length;
      const kwStart = m.index + m[0].search(/lookup/i);
      const cEndRaw = clauseEndIdx(kwStart);
      const clauseText = line.slice(kwStart, cEndRaw).replace(/\s+$/, "");
      tokens.push({
        kind: name.toLowerCase().endsWith(".csv") ? "lookup_file" : "lookup_def",
        cmd: "lookup",
        name,
        start,
        end: start + name.length,
        hitStart: kwStart,
        hitEnd: start + name.length,
        clauseStart: kwStart,
        clauseEnd: kwStart + clauseText.length,
        clauseText,
      });
    }

    // 4. | savedsearch <name> — the name is often quoted (reports allow
    //    spaces), so keep the quotes in the hover extent but strip them for
    //    the REST lookup.
    const ssRe = /(?:^|\|)\s*savedsearch\s+("[^"]*"|'[^']*'|[\w.:{}$-]+)/gi;
    for (let m; (m = ssRe.exec(line)); ) {
      const raw = m[1];
      const start = m.index + m[0].length - raw.length;
      tokens.push({
        kind: "saved_search",
        name: raw.replace(/^["']|["']$/g, ""),
        start,
        end: start + raw.length,
        hitStart: m.index + m[0].search(/savedsearch/i),
        hitEnd: start + raw.length,
      });
    }

    // 5. index=<name>. Wildcards can't be validated or described, so they are
    //    not tokenized at all.
    const idxRe = /\bindex\s*=\s*("[^"]*"|'[^']*'|[\w*.:-]+)/gi;
    for (let m; (m = idxRe.exec(line)); ) {
      const raw = m[1];
      const name = raw.replace(/^["']|["']$/g, "");
      if (!name || name.includes("*")) continue;
      const start = m.index + m[0].length - raw.length;
      tokens.push({
        kind: "index",
        name,
        start,
        end: start + raw.length,
        hitStart: m.index, // the whole index=<name>
        hitEnd: start + raw.length,
      });
    }

    // 6. Data models: `datamodel=Foo.Bar` / `datamodel:Foo.Bar` (tstats, from)
    //    and `| datamodel Foo Bar`. The name before the first dot is the
    //    model; anything after it is a dataset within it.
    const DM_COMMANDS = new Set(["search", "flat", "acceleration_search"]);
    const dmEqRe = /\bdatamodel\s*[=:]\s*("[^"]*"|'[^']*'|[\w.:${}-]+)/gi;
    for (let m; (m = dmEqRe.exec(line)); ) {
      const raw = m[1];
      const full = raw.replace(/^["']|["']$/g, "");
      if (!full || full.includes("$")) continue;
      const dot = full.indexOf(".");
      const start = m.index + m[0].length - raw.length;
      tokens.push({
        kind: "datamodel",
        name: dot === -1 ? full : full.slice(0, dot),
        dataset: dot === -1 ? null : full.slice(dot + 1),
        start,
        end: start + raw.length,
        hitStart: m.index,
        hitEnd: start + raw.length,
      });
    }

    const dmCmdRe = /(?:^|\|)\s*datamodel\s+([\w.:-]+)(?:\s+([\w.:-]+))?/gi;
    for (let m; (m = dmCmdRe.exec(line)); ) {
      const name = m[1];
      const start = m.index + m[0].indexOf(name, m[0].search(/datamodel/i));
      tokens.push({
        kind: "datamodel",
        name,
        dataset: m[2] && !DM_COMMANDS.has(m[2].toLowerCase()) ? m[2] : null,
        start,
        end: start + name.length,
        hitStart: m.index + m[0].search(/datamodel/i),
        hitEnd: start + name.length,
      });
    }

    return tokens;
  }

  // ---------------------------------------------------------------------------
  // Editor attachment
  // ---------------------------------------------------------------------------

  function post(msg) {
    window.postMessage({ source: MSG_SOURCE, ...msg }, window.location.origin);
  }

  // ---------------------------------------------------------------------------
  // Unknown-token marks
  //
  // The content script decides what is unknown (it owns the REST calls); this
  // side only reports the tokens present and draws the squiggles it is told
  // to. Marks are cleared the moment the text changes, because a marker holds
  // a position that the edit has already invalidated.
  // ---------------------------------------------------------------------------

  const editors = new Set();
  const markers = new Map(); // editor → [markerId]
  let scanTimer = null;

  // Ace's Range class, by whichever route this build offers. ace.require is
  // the documented one but isn't always exposed on the page; every selection
  // also carries a Range instance whose constructor is the class itself.
  let RangeCls = null;
  function rangeCtor(editor) {
    if (RangeCls) return RangeCls;
    try {
      const mod = window.ace && window.ace.require && window.ace.require("ace/range");
      if (mod && mod.Range) return (RangeCls = mod.Range);
    } catch (e) { /* not exposed on this build */ }
    try {
      const sel = editor.selection || (editor.getSelection && editor.getSelection());
      const r = sel && sel.getRange && sel.getRange();
      // Must be a real Range: Ace calls clipRows/toScreenRange on it.
      if (r && typeof r.clipRows === "function" && typeof r.toScreenRange === "function") {
        return (RangeCls = r.constructor);
      }
      console.log("[SSH] selection range unusable:", r);
    } catch (e) {
      console.log("[SSH] no Range class:", e.message || e);
    }
    return null;
  }

  function clearMarks(editor) {
    const ids = markers.get(editor);
    if (!ids) return;
    ids.forEach((id) => editor.session.removeMarker(id));
    markers.set(editor, []);
  }

  // Splunk rebuilds the search bar on navigation, so editors go stale. Drop
  // any whose container has left the document before each pass.
  function liveEditors() {
    editors.forEach((editor) => {
      const el = editor.container;
      if (el && !document.contains(el)) {
        editors.delete(editor);
        markers.delete(editor);
      }
    });
    return editors;
  }

  function eachToken(editor, fn) {
    const n = editor.session.getLength();
    for (let row = 0; row < n; row++) {
      const line = editor.session.getLine(row);
      if (line) tokenizeLine(line).forEach((t) => fn(t, row));
    }
  }

  function postTokens() {
    const seen = new Map();
    liveEditors().forEach((editor) => {
      eachToken(editor, (t) => {
        // outputlookup names are usually meant not to exist yet, and macro
        // arguments ($file$) can't be resolved at all.
        if (t.cmd === "outputlookup") return;
        if (t.name.includes("$")) return;
        const key = `${t.kind}|${t.restName || t.name}`;
        if (!seen.has(key)) {
          seen.set(key, { kind: t.kind, name: t.name, restName: t.restName });
        }
      });
    });
    if (seen.size) post({ type: "tokens", tokens: [...seen.values()] });
  }

  function scheduleScan() {
    editors.forEach(clearMarks);
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(postTokens, SCAN_DELAY_MS);
  }

  // Ace's built-in marker drawing positioned these underlines at the start of
  // the line regardless of the range handed to addMarker (observed: a range
  // of 6-15 drew at column 0 with the right width). A custom renderer sidesteps
  // whatever mangles that: Ace still calls it with its own `left`, from which
  // the layer's padding can be recovered, but the column positions come from
  // the document coordinates captured here.
  function markerRenderer(session, row, startCol, endCol) {
    return function (html, screenRange, left, top, config) {
      const cw = config.characterWidth;
      const padding = left - screenRange.start.column * cw;
      const s = session.documentToScreenPosition({ row, column: startCol });
      const e = session.documentToScreenPosition({ row, column: endCol });
      const x = padding + s.column * cw;
      const w = Math.max(cw, (e.column - s.column) * cw);
      html.push(
        "<div class='ssh-bad-token' style='position:absolute;left:",
        x, "px;width:", w, "px;top:", top, "px;height:", config.lineHeight, "px;'></div>"
      );
    };
  }

  function applyMarks(bad) {
    liveEditors().forEach((editor) => {
      clearMarks(editor);
      const Range = rangeCtor(editor);
      if (!Range) return;
      const ids = markers.get(editor) || [];
      const drawn = [];
      eachToken(editor, (t, row) => {
        if (t.cmd === "outputlookup") return;
        if (!bad.has(`${t.kind}|${t.restName || t.name}`)) return;
        ids.push(
          editor.session.addMarker(
            new Range(row, t.start, row, t.end),
            "ssh-bad-token",
            markerRenderer(editor.session, row, t.start, t.end)
          )
        );
        drawn.push(`${t.name} @${row}:${t.start}-${t.end}`);
      });
      markers.set(editor, ids);
      if (!drawn.length) return;
      // Read back where the underlines actually landed, so a mismatch between
      // the range and the pixels is visible without a debugger.
      setTimeout(() => {
        const els = [...editor.container.querySelectorAll(".ssh-bad-token")];
        console.log(
          "[SSH] marked:",
          drawn,
          "drawn as:",
          els.map((el) => `left:${el.style.left} width:${el.style.width}`)
        );
      }, 50);
    });
  }

  function attach(el) {
    if (el.dataset.sshAttached) return;
    const editor = el.env && el.env.editor;
    if (!editor) return; // not an initialized Ace instance yet
    el.dataset.sshAttached = "1";
    editors.add(editor);
    markers.set(editor, []);
    // On the editor, not the session: Splunk swaps sessions, and a listener
    // bound to the old one stops firing, leaving markers frozen at positions
    // the edits have already moved.
    editor.on("change", scheduleScan);
    scheduleScan();

    let hoverTimer = null;
    let lastKey = null;

    function clear() {
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
      if (lastKey !== null) { lastKey = null; post({ type: "clear" }); }
    }

    el.addEventListener("mousemove", (ev) => {
      // Convert screen coords → logical document position via Ace itself.
      const pos = editor.renderer.screenToTextCoordinates(ev.clientX, ev.clientY);
      const line = editor.session.getLine(pos.row);
      if (line === undefined) { clear(); return; }

      // Guard against Ace clamping the column when the pointer is past EOL.
      if (pos.column >= line.length) { clear(); return; }

      const hit = tokenizeLine(line).find((t) => {
        const from = t.hitStart != null ? t.hitStart : t.start;
        const to = t.hitEnd != null ? t.hitEnd : t.end;
        return pos.column >= from && pos.column < to;
      });
      if (!hit) { clear(); return; }

      const key = `${pos.row}:${hit.start}:${hit.name}`; // one popup per token
      if (key === lastKey) return; // already showing / pending
      if (hoverTimer) clearTimeout(hoverTimer);

      hoverTimer = setTimeout(() => {
        lastKey = key;
        post({ type: "hover", token: { ...hit, row: pos.row }, x: ev.clientX, y: ev.clientY });
      }, HOVER_DELAY_MS);
    });

    el.addEventListener("mouseleave", () => {
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
      // Don't post clear here — the user may be moving onto the popup.
      // content.js owns hide-on-mouseout for the popup itself.
      post({ type: "editor-leave" });
    });
  }

  function scan() {
    document.querySelectorAll(".ace_editor").forEach(attach);
  }

  // Splunk builds the search bar late and rebuilds it on navigation.
  const mo = new MutationObserver(() => scan());
  mo.observe(document.documentElement, { childList: true, subtree: true });
  scan();

  // Clause replacement requests from the builder (content.js). Guarded: the
  // original text must still be at the stated position, so a stale popup can
  // never clobber a line that changed since the hover.
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const m = ev.data;
    if (!m || m.source !== "ssh-x") return;

    if (m.type === "marks") {
      applyMarks(new Set(m.bad || []));
      return;
    }
    if (m.type === "rescan") {
      scheduleScan();
      return;
    }
    if (m.type !== "replace") return;

    for (const el of document.querySelectorAll(".ace_editor")) {
      const editor = el.env && el.env.editor;
      if (!editor) continue;
      const line = editor.session.getLine(m.row);
      if (line == null) continue;
      if (line.slice(m.start, m.end) !== m.oldText) continue;
      editor.session.replace(
        { start: { row: m.row, column: m.start }, end: { row: m.row, column: m.end } },
        m.text
      );
      post({ type: "replace-done" });
      return;
    }
    post({ type: "replace-failed" });
  });
})();
