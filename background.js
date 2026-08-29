/**
 * Hover Actions for SPL — service worker
 *
 * The extension ships with no host access. Users add their Splunk domain(s)
 * on the options page, which requests an optional host permission and stores
 * the domain list. This worker keeps the dynamic content-script
 * registrations in sync with that list (on install, browser startup, and
 * whenever the list changes), registering only domains whose permission is
 * actually granted.
 */
"use strict";

const SCRIPT_IDS = ["hasp-agent", "hasp-content"];

async function grantedDomains() {
  const { domains = [] } = await chrome.storage.sync.get({ domains: [] });
  const granted = [];
  for (const d of domains) {
    try {
      if (await chrome.permissions.contains({ origins: [`https://${d}/*`] })) {
        granted.push(d);
      }
    } catch (e) {
      // Malformed entry — skip it rather than fail the whole sync.
      console.warn("[HASP] skipping domain:", d, e.message || e);
    }
  }
  return granted;
}

async function syncRegistrations() {
  const existing = await chrome.scripting.getRegisteredContentScripts({
    ids: SCRIPT_IDS,
  });
  if (existing.length) {
    await chrome.scripting.unregisterContentScripts({
      ids: existing.map((s) => s.id),
    });
  }

  const domains = await grantedDomains();
  if (!domains.length) return;
  const matches = domains.map((d) => `https://${d}/*`);

  await chrome.scripting.registerContentScripts([
    {
      id: "hasp-agent",
      js: ["page-agent.js"],
      matches,
      world: "MAIN",
      runAt: "document_idle",
    },
    {
      id: "hasp-content",
      js: ["content.js"],
      css: ["popup.css"],
      matches,
      runAt: "document_idle",
    },
  ]);
  console.log("[HASP] content scripts registered for:", domains.join(", "));
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") chrome.runtime.openOptionsPage();
  await syncRegistrations();
});

chrome.runtime.onStartup.addListener(() => {
  syncRegistrations();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.domains) syncRegistrations();
});
