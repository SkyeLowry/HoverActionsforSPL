"use strict";

const DEFAULTS = {
  hoverMacros: true,
  hoverLookups: true,
  lookupSamples: true,
  copyStatHeaders: true,
  copyEventHeaders: true,
  copyFieldDialog: true,
};

document.getElementById("version").textContent =
  chrome.runtime.getManifest().version;

const savedEl = document.getElementById("saved");
let savedTimer = null;

chrome.storage.sync.get(DEFAULTS, (settings) => {
  for (const key of Object.keys(DEFAULTS)) {
    const box = document.getElementById(key);
    box.checked = settings[key];
    box.addEventListener("change", () => {
      chrome.storage.sync.set({ [key]: box.checked }, () => {
        savedEl.classList.add("show");
        if (savedTimer) clearTimeout(savedTimer);
        savedTimer = setTimeout(() => savedEl.classList.remove("show"), 1200);
      });
    });
  }
});
