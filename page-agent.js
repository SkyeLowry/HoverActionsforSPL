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
 */
(() => {
  "use strict";

  const MSG_SOURCE = "ssh";
  const HOVER_DELAY_MS = 250;

  // ---------------------------------------------------------------------------
  // Line tokenizer: find actionable tokens in one logical line of SPL.
  // Returns [{ kind, name, args, start, end }] with start/end as column offsets.
  //   kind: "macro" | "lookup_file" | "lookup_def"
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
      const argCount = m[2] !== undefined ? splitMacroArgs(m[2]).length : 0;
      tokens.push({
        kind: "macro",
        name: m[1],
        restName: m[2] !== undefined ? `${m[1]}(${argCount})` : m[1],
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
        name,
        start,
        end: start + name.length,
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
        name,
        start,
        end: start + name.length,
        clauseStart: kwStart,
        clauseEnd: kwStart + clauseText.length,
        clauseText,
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

  function attach(el) {
    if (el.dataset.sshAttached) return;
    const editor = el.env && el.env.editor;
    if (!editor) return; // not an initialized Ace instance yet
    el.dataset.sshAttached = "1";

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

      const hit = tokenizeLine(line).find(
        (t) => pos.column >= t.start && pos.column < t.end
      );
      if (!hit) { clear(); return; }

      const key = `${pos.row}:${hit.start}:${hit.name}`;
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
    if (!m || m.source !== "ssh-x" || m.type !== "replace") return;

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
