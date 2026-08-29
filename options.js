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

// ---------------------------------------------------------------------------
// Feature toggles
// ---------------------------------------------------------------------------

const savedEl = document.getElementById("saved");
let savedTimer = null;

function flashSaved() {
  savedEl.classList.add("show");
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedEl.classList.remove("show"), 1200);
}

chrome.storage.sync.get(DEFAULTS, (settings) => {
  for (const key of Object.keys(DEFAULTS)) {
    const box = document.getElementById(key);
    box.checked = settings[key];
    box.addEventListener("change", () => {
      chrome.storage.sync.set({ [key]: box.checked }, flashSaved);
    });
  }
});

// ---------------------------------------------------------------------------
// Splunk domains
// ---------------------------------------------------------------------------

const domainInput = document.getElementById("domainInput");
const domainAdd = document.getElementById("domainAdd");
const domainErr = document.getElementById("domainErr");
const domainList = document.getElementById("domainList");

function normalizeDomain(raw) {
  let s = raw.trim().toLowerCase();
  // Accept a pasted URL and reduce it to the host.
  s = s.replace(/^[a-z]+:\/\//, "").split("/")[0].split(":")[0];
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) {
    return null;
  }
  return s;
}

async function getDomains() {
  const { domains = [] } = await chrome.storage.sync.get({ domains: [] });
  return domains;
}

async function renderDomains() {
  const domains = await getDomains();
  domainList.innerHTML = "";
  if (!domains.length) {
    const li = document.createElement("li");
    li.className = "domain-empty";
    li.textContent = "No domains added — the extension is inactive.";
    domainList.appendChild(li);
    return;
  }
  for (const d of domains) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = d;
    const rm = document.createElement("button");
    rm.className = "rm";
    rm.textContent = "remove";
    rm.addEventListener("click", () => removeDomain(d));
    li.appendChild(name);
    li.appendChild(rm);
    domainList.appendChild(li);
  }
}

async function addDomain() {
  domainErr.textContent = "";
  const host = normalizeDomain(domainInput.value);
  if (!host) {
    domainErr.textContent = "That doesn't look like a valid domain.";
    return;
  }
  const domains = await getDomains();
  if (domains.includes(host)) {
    domainErr.textContent = "Already added.";
    return;
  }
  let granted = false;
  try {
    granted = await chrome.permissions.request({
      origins: [`https://${host}/*`],
    });
  } catch (e) {
    domainErr.textContent = e.message || String(e);
    return;
  }
  if (!granted) {
    domainErr.textContent = "Permission was declined.";
    return;
  }
  domains.push(host);
  // The service worker watches this key and (re)registers content scripts.
  await chrome.storage.sync.set({ domains });
  domainInput.value = "";
  flashSaved();
  renderDomains();
}

async function removeDomain(host) {
  const domains = (await getDomains()).filter((d) => d !== host);
  await chrome.storage.sync.set({ domains });
  try {
    await chrome.permissions.remove({ origins: [`https://${host}/*`] });
  } catch (e) {
    // Best effort — registration sync keys off the stored list either way.
  }
  flashSaved();
  renderDomains();
}

domainAdd.addEventListener("click", addDomain);
domainInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") addDomain();
});

renderDomains();
