/* ================================================================
   Linn Tab Workspace — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, regroup tabs, focus tab)
   5. Stores local workspace preferences in chrome.storage.local
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

// Debounced refresh timer for tab/storage event listeners
let renderRefreshTimer = null;

let customCategories = [];
let customAssignments = {};
let pageKeywords = {};
let pageSummaries = {};
let uiPrefs = { theme: 'paper', controlPanelCollapsed: false, backgroundColor: '', cardColor: '', accentColor: '' };
let draggedTabUrl = '';
let workspaceSearchQuery = '';
const manuallyExpandedGroups = new Set();
const ALLOWED_THEMES = new Set(['paper', 'graphite', 'forest', 'blush']);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function getFaviconUrl(pageUrl, size = 16) {
  if (!pageUrl) return '';
  try {
    const favicon = new URL(chrome.runtime.getURL('/_favicon/'));
    favicon.searchParams.set('pageUrl', pageUrl);
    favicon.searchParams.set('size', String(size));
    return favicon.toString();
  } catch {
    return '';
  }
}

function scheduleDashboardRefresh(delay = 120) {
  clearTimeout(renderRefreshTimer);
  renderRefreshTimer = setTimeout(() => {
    renderDashboard().catch(err => console.warn('[linn-workspace] Refresh failed:', err));
  }, delay);
}

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Linn workspace pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // This extension's new-tab page lives at index.html
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      // Flag this workspace's own pages so we can detect duplicate new-tab instances
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeWorkspaceDupes()
 *
 * Closes duplicate Linn workspace new-tab pages except the current one.
 */
async function closeWorkspaceDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const workspaceTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (workspaceTabs.length <= 1) return;

  // Keep the active Linn workspace tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    workspaceTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    workspaceTabs.find(t => t.active) ||
    workspaceTabs[0];
  const toClose = workspaceTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Stores a tab record in local Chrome storage.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const normalizedUrl = (tab.url || '').trim();
  const normalizedTitle = (tab.title || tab.url || '').trim();

  const existing = deferred.find(item =>
    !item.dismissed &&
    !item.completed &&
    item.url === normalizedUrl
  );

  if (existing) return false;

  deferred.push({
    id:        (crypto.randomUUID?.() || Date.now().toString()),
    url:       normalizedUrl,
    title:     normalizedTitle,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
  return true;
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  const byNewestSaved = (a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0);
  const byNewestCompleted = (a, b) => new Date(b.completedAt || b.savedAt || 0) - new Date(a.completedAt || a.savedAt || 0);
  return {
    active:   visible.filter(t => !t.completed).sort(byNewestSaved),
    archived: visible.filter(t => t.completed).sort(byNewestCompleted),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}

async function loadWorkspaceState() {
  const data = await chrome.storage.local.get(['customCategories', 'customAssignments', 'pageKeywords', 'pageSummaries', 'uiPrefs']);

  customCategories = Array.isArray(data.customCategories) ? data.customCategories.filter(c => c && c.id && c.name) : [];
  customAssignments = data.customAssignments && typeof data.customAssignments === 'object' ? data.customAssignments : {};
  pageKeywords = data.pageKeywords && typeof data.pageKeywords === 'object' ? data.pageKeywords : {};
  pageSummaries = data.pageSummaries && typeof data.pageSummaries === 'object' ? data.pageSummaries : {};
  uiPrefs = {
    theme: 'paper',
    controlPanelCollapsed: false,
    backgroundColor: '',
    cardColor: '',
    accentColor: '',
    ...(data.uiPrefs && typeof data.uiPrefs === 'object' ? data.uiPrefs : {}),
  };

  if (!ALLOWED_THEMES.has(uiPrefs.theme)) uiPrefs.theme = 'paper';
}

async function saveWorkspaceState(partial) {
  await chrome.storage.local.set(partial);
}

function normalizeCategoryName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function applyUiPrefs() {
  document.body.dataset.theme = uiPrefs.theme || 'paper';

  const themeSelect = document.getElementById('themeSelect');
  if (themeSelect) themeSelect.value = uiPrefs.theme || 'paper';

  const backgroundColorInput = document.getElementById('backgroundColorInput');
  if (backgroundColorInput) backgroundColorInput.value = uiPrefs.backgroundColor || '#f8f5f0';

  const cardColorInput = document.getElementById('cardColorInput');
  if (cardColorInput) cardColorInput.value = uiPrefs.cardColor || '#fffdf9';

  const accentColorInput = document.getElementById('accentColorInput');
  if (accentColorInput) accentColorInput.value = uiPrefs.accentColor || '#c8713a';

  if (uiPrefs.backgroundColor) document.documentElement.style.setProperty('--page-bg', uiPrefs.backgroundColor);
  else document.documentElement.style.removeProperty('--page-bg');

  if (uiPrefs.cardColor) document.documentElement.style.setProperty('--card-bg-custom', uiPrefs.cardColor);
  else document.documentElement.style.removeProperty('--card-bg-custom');

  if (uiPrefs.accentColor) {
    document.documentElement.style.setProperty('--accent-custom', uiPrefs.accentColor);
    document.documentElement.style.setProperty('--accent-amber', uiPrefs.accentColor);
  } else {
    document.documentElement.style.removeProperty('--accent-custom');
    document.documentElement.style.removeProperty('--accent-amber');
  }

  const panel = document.getElementById('controlPanel');
  if (panel) panel.classList.toggle('is-collapsed', !!uiPrefs.controlPanelCollapsed);
}

function getCustomCategoryById(id) {
  return customCategories.find(category => category.id === id) || null;
}

function getGroupStableId(groupOrDomain) {
  const domain = typeof groupOrDomain === 'string' ? groupOrDomain : groupOrDomain?.domain || '';
  return 'domain-' + String(domain).replace(/[^a-z0-9:_-]/gi, '-');
}

async function createCustomCategory(name) {
  const normalized = normalizeCategoryName(name);
  if (!normalized) return { ok: false, reason: 'empty' };

  const exists = customCategories.find(category => category.name.toLowerCase() === normalized.toLowerCase());
  if (exists) return { ok: false, reason: 'duplicate' };

  const category = {
    id: crypto.randomUUID?.() || `cat-${Date.now()}`,
    name: normalized,
    createdAt: new Date().toISOString(),
  };

  customCategories = [...customCategories, category];
  await saveWorkspaceState({ customCategories });
  return { ok: true, category };
}

async function deleteCustomCategory(id) {
  customCategories = customCategories.filter(category => category.id !== id);
  customAssignments = Object.fromEntries(
    Object.entries(customAssignments).filter(([, categoryId]) => categoryId !== id)
  );
  await saveWorkspaceState({ customCategories, customAssignments });
}

async function assignTabToCategory(url, categoryId) {
  if (!url || !getCustomCategoryById(categoryId)) return;
  customAssignments = { ...customAssignments, [url]: categoryId };
  await saveWorkspaceState({ customAssignments });
}

async function clearTabCategory(url) {
  if (!url || !customAssignments[url]) return;
  const next = { ...customAssignments };
  delete next[url];
  customAssignments = next;
  await saveWorkspaceState({ customAssignments });
}

function getKeywordsForUrl(url) {
  const keywords = pageKeywords[url];
  return Array.isArray(keywords) ? keywords : [];
}

async function saveKeywordsForUrl(url, rawValue) {
  if (!url) return;
  const keywords = String(rawValue || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .slice(0, 6);

  const next = { ...pageKeywords };
  if (keywords.length > 0) next[url] = keywords;
  else delete next[url];

  pageKeywords = next;
  await saveWorkspaceState({ pageKeywords });
}

function inferTabSummary(tab) {
  if (!tab?.url) return '';
  try {
    const parsed = new URL(tab.url);
    const hostname = parsed.hostname;
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const cleanedTitle = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), hostname);

    if ((hostname === 'github.com' || hostname === 'www.github.com') && pathParts.length >= 2) {
      const [owner, repo, section, item] = pathParts;
      if (section === 'issues' && item) return `GitHub issue in ${owner}/${repo}`;
      if (section === 'pull' && item) return `GitHub pull request in ${owner}/${repo}`;
      if (section === 'blob' && pathParts[4]) return `Code file in ${owner}/${repo}`;
      return `Repository page for ${owner}/${repo}`;
    }

    if ((hostname === 'youtube.com' || hostname === 'www.youtube.com') && parsed.pathname === '/watch') return 'YouTube video page';
    if (hostname === 'docs.google.com') return 'Google document or spreadsheet';
    if (hostname === 'drive.google.com') return 'Google Drive file or folder';
    if (hostname === 'mail.google.com') return 'Email inbox or thread';
    if (hostname === 'www.notion.so' || hostname === 'notion.so') return 'Notion page or workspace doc';
    if (hostname === 'figma.com' || hostname === 'www.figma.com') return 'Figma design file or prototype';
    if (hostname === 'localhost') return parsed.port ? `Local project running on port ${parsed.port}` : 'Local development page';

    const pathHint = pathParts.slice(0, 2).join(' / ');
    if (cleanedTitle && cleanedTitle.length > 8) return `${friendlyDomain(hostname)} page about ${cleanedTitle}`;
    if (pathHint) return `${friendlyDomain(hostname)} · ${pathHint}`;
    return `${friendlyDomain(hostname)} homepage or main page`;
  } catch {
    return tab?.title || '';
  }
}

function getSummaryForTab(tab) {
  return (pageSummaries[tab.url] || inferTabSummary(tab) || '').trim();
}

async function saveSummaryForUrl(url, summary) {
  if (!url) return;
  const next = { ...pageSummaries };
  const trimmed = String(summary || '').trim();
  if (trimmed) next[url] = trimmed;
  else delete next[url];
  pageSummaries = next;
  await saveWorkspaceState({ pageSummaries });
}

async function setBackgroundColor(color) {
  uiPrefs = { ...uiPrefs, backgroundColor: color || '' };
  applyUiPrefs();
  await saveWorkspaceState({ uiPrefs });
}

async function setCardColor(color) {
  uiPrefs = { ...uiPrefs, cardColor: color || '' };
  applyUiPrefs();
  await saveWorkspaceState({ uiPrefs });
}

async function setAccentColor(color) {
  uiPrefs = { ...uiPrefs, accentColor: color || '' };
  applyUiPrefs();
  await saveWorkspaceState({ uiPrefs });
}

async function setTheme(theme) {
  if (!ALLOWED_THEMES.has(theme)) return;
  uiPrefs = { ...uiPrefs, theme };
  applyUiPrefs();
  await saveWorkspaceState({ uiPrefs });
}

async function toggleControlPanel() {
  uiPrefs = { ...uiPrefs, controlPanelCollapsed: !uiPrefs.controlPanelCollapsed };
  applyUiPrefs();
  await saveWorkspaceState({ uiPrefs });
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
  tag:     `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.568 3.05A2.25 2.25 0 0 1 11.197 2.25h6.303a2.25 2.25 0 0 1 2.25 2.25v6.303a2.25 2.25 0 0 1-.659 1.591l-6.697 6.697a2.25 2.25 0 0 1-3.182 0l-4.303-4.303a2.25 2.25 0 0 1 0-3.182l6.659-6.556Z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6.75h.008v.008h-.008z" /></svg>`,
  reset:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992V4.356m-2.585 13.263a9 9 0 1 1 2.1-9.222" /></svg>`,
  trash:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673A2.25 2.25 0 0 1 15.916 21.75H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0A48.108 48.108 0 0 0 15.75 5.25m3.478.54A48.11 48.11 0 0 1 12 4.5c-2.43 0-4.77.18-7.228.54m0 0A48.667 48.667 0 0 1 8.25 5.25m0 0h7.5" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkWorkspaceDupes()
 *
 * Counts how many Linn workspace pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkWorkspaceDupes() {
  const workspaceTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (workspaceTabs.length > 1) {
    if (countEl) countEl.textContent = workspaceTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   TAB CHIP + GROUP CARD RENDERERS
   ---------------------------------------------------------------- */

function normalizeSearchText(value) {
  return String(value || '').trim().toLowerCase();
}

function getGroupPriorityScore(group) {
  const tabs = group.tabs || [];
  const uniqueUrls = new Set(tabs.map(tab => tab.url)).size;
  const duplicateCount = tabs.length - uniqueUrls;
  let score = tabs.length;
  if (group.type === 'custom') score += 6;
  if (group.domain === '__landing-pages__') score += 2;
  score += duplicateCount * 4;
  return score;
}

function getGroupQuickSummary(group) {
  const tabs = group.tabs || [];
  if (tabs.length === 0) return 'Ready for a tab drop.';

  const uniqueUrls = new Set(tabs.map(tab => tab.url)).size;
  const duplicates = tabs.length - uniqueUrls;
  const docsCount = tabs.filter(tab => /docs|notion|sheet|calendar|drive|wiki|feishu/i.test(`${tab.title || ''} ${tab.url || ''}`)).length;
  const queryCount = tabs.filter(tab => /query|search|dashboard|editor/i.test(`${tab.title || ''} ${tab.url || ''}`)).length;

  const parts = [`${tabs.length} tab${tabs.length !== 1 ? 's' : ''}`];
  if (duplicates > 0) parts.push(`${duplicates} duplicate${duplicates !== 1 ? 's' : ''}`);
  if (docsCount > 0) parts.push(`${docsCount} doc${docsCount !== 1 ? 's' : ''}`);
  else if (queryCount > 0) parts.push(`${queryCount} tool${queryCount !== 1 ? 's' : ''}`);
  return parts.join(' · ');
}

function filterGroupForSearch(group, query) {
  const normalized = normalizeSearchText(query);
  if (!normalized) return { matches: true, group };

  const groupText = [group.label, group.domain, friendlyDomain(group.domain), getGroupQuickSummary(group)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const filteredTabs = (group.tabs || []).filter(tab => {
    const haystack = [
      tab.title,
      tab.url,
      getSummaryForTab(tab),
      getKeywordsForUrl(tab.url).join(' '),
      group.label,
      group.domain,
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(normalized);
  });

  if (groupText.includes(normalized)) return { matches: true, group };
  if (filteredTabs.length === 0) return { matches: false, group: null };
  return { matches: true, group: { ...group, tabs: filteredTabs } };
}

function shouldExpandGroup(group, index, query) {
  if (normalizeSearchText(query)) return true;
  if (manuallyExpandedGroups.has(group.domain)) return true;
  if (group.type === 'custom') return true;
  const tabs = group.tabs || [];
  const uniqueUrls = new Set(tabs.map(tab => tab.url)).size;
  const duplicates = tabs.length - uniqueUrls;
  return index < 4 || duplicates > 0 || tabs.length >= 6;
}

function buildSummaryStrip({ realTabs, visibleGroups, allGroups, query }) {
  const summaryStrip = document.getElementById('summaryStrip');
  if (!summaryStrip) return;

  const uniqueUrls = new Set(realTabs.map(tab => tab.url)).size;
  const duplicateCount = realTabs.length - uniqueUrls;
  const collapsedCount = visibleGroups.filter(group => group.isCollapsed).length;
  const docsCount = realTabs.filter(tab => /docs|notion|sheet|calendar|drive|wiki|feishu/i.test(`${tab.title || ''} ${tab.url || ''}`)).length;

  const chips = [
    `<div class="summary-chip strong">${realTabs.length} tabs</div>`,
    `<div class="summary-chip">${visibleGroups.length} groups in view</div>`,
    duplicateCount > 0 ? `<button class="summary-chip clickable" data-action="filter-search-preset" data-search-preset="duplicate">${duplicateCount} duplicates</button>` : '',
    docsCount > 0 ? `<button class="summary-chip clickable" data-action="filter-search-preset" data-search-preset="docs">${docsCount} docs</button>` : '',
    collapsedCount > 0 && !normalizeSearchText(query) ? `<button class="summary-chip clickable" data-action="expand-all-groups">Show ${collapsedCount} quieter group${collapsedCount !== 1 ? 's' : ''}</button>` : '',
    normalizeSearchText(query) ? `<button class="summary-chip clickable" data-action="clear-workspace-search">Clear search</button>` : '',
  ].filter(Boolean).join('');

  const hint = normalizeSearchText(query)
    ? `Showing results for “${escapeHtml(query)}”`
    : 'Focus on the highest-signal groups first.';

  summaryStrip.innerHTML = `${chips}<div class="summary-hint">${hint}</div>`;
}

function renderKeywordPills(url) {
  const keywords = getKeywordsForUrl(url);
  if (keywords.length === 0) return '';
  return `<div class="chip-keywords">${keywords.map(keyword => `<span class="chip-keyword">${escapeHtml(keyword)}</span>`).join('')}</div>`;
}

function renderTabChip(tab, group, urlCounts = {}) {
  let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
  try {
    const parsed = new URL(tab.url);
    if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
  } catch {}

  const count = urlCounts[tab.url] || 1;
  const dupeTag = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
  const chipClass = count > 1 ? ' chip-has-dupes' : '';
  const safeUrl = escapeAttr(tab.url || '');
  const safeTitle = escapeAttr(label);
  const safeLabel = escapeHtml(label);
  const faviconUrl = escapeAttr(getFaviconUrl(tab.url, 16));
  const keywordsHtml = renderKeywordPills(tab.url);
  const summary = getSummaryForTab(tab);
  const summaryHtml = summary ? `<div class="chip-summary">${escapeHtml(summary)}</div>` : '';
  const selectedCategoryId = customAssignments[tab.url] || '';
  const categoryOptions = [`<option value="">Automatic group</option>`]
    .concat(customCategories.map(category => `<option value="${escapeAttr(category.id)}" ${category.id === selectedCategoryId ? 'selected' : ''}>${escapeHtml(category.name)}</option>`))
    .concat([`<option value="__create__">＋ New group…</option>`])
    .join('');
  const resetButton = group.type === 'custom'
    ? `<button class="chip-action chip-reset" data-action="clear-custom-category" data-tab-url="${safeUrl}" title="Move back to automatic grouping">${ICONS.reset}</button>`
    : '';

  return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}" draggable="true">
    ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
    <div class="chip-body">
      <span class="chip-text">${safeLabel}</span>${dupeTag}
      ${summaryHtml}
      ${keywordsHtml}
      <div class="chip-grouping">
        <select class="chip-group-select" data-action="assign-category" data-tab-url="${safeUrl}" title="Move this tab to a custom group">
          ${categoryOptions}
        </select>
      </div>
    </div>
    <div class="chip-actions">
      <button class="chip-action chip-summary-btn" data-action="edit-summary" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Edit summary">${ICONS.focus}</button>
      <button class="chip-action chip-keywords-btn" data-action="edit-keywords" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Add keywords">${ICONS.tag}</button>
      ${resetButton}
      <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>
  </div>`;
}

function buildOverflowChips(hiddenTabs, group, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => renderTabChip(tab, group, urlCounts)).join('');
  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}

function renderDomainCard(group) {
  const isCollapsed = !!group.isCollapsed;
  const tabs = group.tabs || [];
  const tabCount = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const isCustom = group.type === 'custom';
  const stableId = getGroupStableId(group);

  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls = Object.entries(urlCounts).filter(([, count]) => count > 1);
  const hasDupes = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((sum, [, count]) => sum + count - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">${ICONS.tabs}${tabCount} tab${tabCount !== 1 ? 's' : ''}</span>`;
  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}</span>`
    : '';

  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) {
      seen.add(tab.url);
      uniqueTabs.push(tab);
    }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount = uniqueTabs.length - visibleTabs.length;
  const quickSummary = getGroupQuickSummary(group);

  const pageChips = tabCount > 0
    ? visibleTabs.map(tab => renderTabChip(tab, group, urlCounts)).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), group, urlCounts) : '')
    : (isCustom ? '<div class="custom-drop-hint">Drop tabs here to build your own topic-based group.</div>' : '');

  let actionsHtml = '';
  if (tabCount > 0) {
    actionsHtml += `
      <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
        ${ICONS.close}
        Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
      </button>`;
  }

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  if (isCustom) {
    actionsHtml += `
      <button class="action-btn danger" data-action="delete-category" data-category-id="${escapeAttr(group.categoryId)}">
        ${ICONS.trash}
        Delete category
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${isCollapsed ? 'is-collapsed-group' : ''} ${isCustom ? 'custom-category has-active-bar' : hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}" ${isCustom ? `data-category-id="${escapeAttr(group.categoryId)}"` : ''}>
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <div class="mission-heading">
            <span class="mission-name">${escapeHtml(isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain)))}</span>
            <div class="mission-summary-inline">${escapeHtml(quickSummary)}</div>
          </div>
          <div class="mission-badges">${tabBadge}${dupeBadge}</div>
        </div>
        ${isCollapsed
          ? `<button class="group-expand-btn" data-action="toggle-group-collapse" data-domain-id="${stableId}">Open group</button>`
          : `<div class="mission-pages">${pageChips}</div>${actionsHtml ? `<div class="actions">${actionsHtml}<button class="action-btn" data-action="toggle-group-collapse" data-domain-id="${stableId}">Collapse</button></div>` : `<div class="actions"><button class="action-btn" data-action="toggle-group-collapse" data-domain-id="${stableId}">Collapse</button></div>`}`}
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * Legacy deferred-column renderer kept for compatibility.
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[linn-workspace] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = escapeAttr(getFaviconUrl(item.url, 16));
  const ago = timeAgo(item.savedAt);
  const safeTitle = escapeAttr(item.title || item.url || '');
  const safeLabel = escapeHtml(item.title || item.url || '');
  const safeUrl = escapeAttr(item.url || '');

  return `
    <div class="deferred-item" data-deferred-id="${escapeAttr(item.id)}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${escapeAttr(item.id)}">
      <div class="deferred-info">
        <a href="${safeUrl}" target="_blank" rel="noopener" class="deferred-title" title="${safeTitle}">
          ${faviconUrl ? `<img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">` : ''}${safeLabel}
        </a>
        <div class="deferred-meta">
          <span>${escapeHtml(domain)}</span>
          <span>${escapeHtml(ago)}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${escapeAttr(item.id)}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${escapeAttr(item.url || '')}" target="_blank" rel="noopener" class="archive-item-title" title="${escapeAttr(item.title || item.url || '')}">
        ${escapeHtml(item.title || item.url || '')}
      </a>
      <span class="archive-item-date">${escapeHtml(ago)}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Handles the (now disabled) deferred column renderer
 */
async function renderStaticDashboard() {
  const greetingEl = document.getElementById('greeting');
  const dateEl = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl) dateEl.textContent = getDateDisplay();

  await loadWorkspaceState();
  applyUiPrefs();

  const searchInput = document.getElementById('workspaceSearch');
  if (searchInput && searchInput.value !== workspaceSearchQuery) searchInput.value = workspaceSearchQuery;

  await fetchOpenTabs();
  const realTabs = getRealTabs();

  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) => !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com', pathExact: ['/home'] },
    { hostname: 'www.linkedin.com', pathExact: ['/'] },
    { hostname: 'github.com', pathExact: ['/'] },
    { hostname: 'www.youtube.com', pathExact: ['/'] },
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(pattern => {
        const hostnameMatch = pattern.hostname
          ? parsed.hostname === pattern.hostname
          : pattern.hostnameEndsWith
            ? parsed.hostname.endsWith(pattern.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (pattern.test) return pattern.test(parsed.pathname, url);
        if (pattern.pathPrefix) return parsed.pathname.startsWith(pattern.pathPrefix);
        if (pattern.pathExact) return pattern.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch {
      return false;
    }
  }

  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(rule => {
        const hostMatch = rule.hostname
          ? parsed.hostname === rule.hostname
          : rule.hostnameEndsWith
            ? parsed.hostname.endsWith(rule.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (rule.pathPrefix) return parsed.pathname.startsWith(rule.pathPrefix);
        return true;
      }) || null;
    } catch {
      return null;
    }
  }

  domainGroups = [];
  const groupMap = {};
  const landingTabs = [];

  for (const category of customCategories) {
    const key = `__custom__:${category.id}`;
    groupMap[key] = { domain: key, type: 'custom', categoryId: category.id, label: category.name, tabs: [], createdAt: category.createdAt };
  }

  for (const tab of realTabs) {
    try {
      const assignedCategoryId = customAssignments[tab.url];
      const assignedCategory = assignedCategoryId ? getCustomCategoryById(assignedCategoryId) : null;
      if (assignedCategory) {
        const key = `__custom__:${assignedCategory.id}`;
        groupMap[key].tabs.push(tab);
        continue;
      }

      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) hostname = 'local-files';
      else hostname = new URL(tab.url).hostname;
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(pattern => pattern.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(pattern => pattern.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(suffix => domain.endsWith(suffix));
  }

  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aCustom = a.type === 'custom';
    const bCustom = b.type === 'custom';
    if (aCustom !== bCustom) return aCustom ? -1 : 1;
    if (aCustom && bCustom) return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);

    const aLanding = a.domain === '__landing-pages__';
    const bLanding = b.domain === '__landing-pages__';
    if (aLanding !== bLanding) return aLanding ? -1 : 1;

    const aPriority = isLandingDomain(a.domain);
    const bPriority = isLandingDomain(b.domain);
    if (aPriority !== bPriority) return aPriority ? -1 : 1;

    return getGroupPriorityScore(b) - getGroupPriorityScore(a);
  });

  const filteredGroups = domainGroups
    .map(group => filterGroupForSearch(group, workspaceSearchQuery))
    .filter(result => result.matches && result.group)
    .map(result => result.group);

  const visibleGroups = filteredGroups.map((group, index) => ({
    ...group,
    isCollapsed: !shouldExpandGroup(group, index, workspaceSearchQuery),
  }));

  const openTabsSection = document.getElementById('openTabsSection');
  const openTabsMissionsEl = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  buildSummaryStrip({ realTabs, visibleGroups, allGroups: domainGroups, query: workspaceSearchQuery });

  if (visibleGroups.length > 0 && openTabsSection) {
    const customCount = customCategories.length;
    const collapsedCount = visibleGroups.filter(group => group.isCollapsed).length;
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = normalizeSearchText(workspaceSearchQuery) ? 'Search results' : 'Your groups';
    openTabsSectionCount.innerHTML = `${visibleGroups.length} group${visibleGroups.length !== 1 ? 's' : ''}${customCount > 0 ? ` &nbsp;&middot;&nbsp; ${customCount} custom` : ''}${collapsedCount > 0 && !normalizeSearchText(workspaceSearchQuery) ? ` &nbsp;&middot;&nbsp; ${collapsedCount} collapsed` : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    openTabsMissionsEl.innerHTML = visibleGroups.map(group => renderDomainCard(group)).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'block';
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Search results';
    if (openTabsSectionCount) openTabsSectionCount.textContent = '0 matches';
    openTabsMissionsEl.innerHTML = `<div class="missions-empty-state"><div class="empty-title">No matching tabs</div><div class="empty-subtitle">Try another keyword like docs, github, duplicate, or a project name.</div></div>`;
  }

  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  const statGroups = document.getElementById('statGroups');
  if (statGroups) statGroups.textContent = String(domainGroups.length);

  const statCustomGroups = document.getElementById('statCustomGroups');
  if (statCustomGroups) statCustomGroups.textContent = String(customCategories.length);

  const footerStatus = document.getElementById('footerStatus');
  if (footerStatus) {
    footerStatus.textContent = normalizeSearchText(workspaceSearchQuery)
      ? `Focused on ${visibleGroups.length} matching group${visibleGroups.length !== 1 ? 's' : ''}`
      : customCategories.length > 0
        ? `Built around ${customCategories.length} custom topic${customCategories.length !== 1 ? 's' : ''}`
        : "Linn's tab workspace";
  }

  checkWorkspaceDupes();
  await renderDeferredColumn();
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  if (action === 'toggle-control-panel') {
    await toggleControlPanel();
    return;
  }

  if (action === 'create-category') {
    const input = document.getElementById('newCategoryInput');
    const name = input ? input.value : '';
    const result = await createCustomCategory(name);
    if (result.ok) {
      if (input) input.value = '';
      showToast(`Created ${result.category.name}`);
      await renderDashboard();
    } else {
      showToast(result.reason === 'duplicate' ? 'Category already exists' : 'Enter a category name');
    }
    return;
  }

  if (action === 'clear-workspace-search') {
    workspaceSearchQuery = '';
    const input = document.getElementById('workspaceSearch');
    if (input) input.value = '';
    await renderDashboard();
    return;
  }

  if (action === 'filter-search-preset') {
    workspaceSearchQuery = actionEl.dataset.searchPreset || '';
    const input = document.getElementById('workspaceSearch');
    if (input) input.value = workspaceSearchQuery;
    await renderDashboard();
    return;
  }

  if (action === 'expand-all-groups') {
    domainGroups.forEach(group => manuallyExpandedGroups.add(group.domain));
    await renderDashboard();
    return;
  }

  if (action === 'reset-background-color') {
    uiPrefs = { ...uiPrefs, backgroundColor: '', cardColor: '', accentColor: '' };
    applyUiPrefs();
    await saveWorkspaceState({ uiPrefs });
    showToast('Colors reset');
    return;
  }

  // ---- Close duplicate Linn workspace tabs ----
  if (action === 'close-tabout-dupes') {
    await closeWorkspaceDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra workspace tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    if (e.target.closest('.chip-grouping') || e.target.closest('button, select, input, option')) return;
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast('Tab closed');
    return;
  }


  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  if (action === 'edit-summary') {
    e.stopPropagation();
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;
    const tab = openTabs.find(item => item.url === tabUrl) || { url: tabUrl, title: actionEl.dataset.tabTitle || tabUrl };
    const current = pageSummaries[tabUrl] || getSummaryForTab(tab);
    const next = window.prompt('Write a short summary for this tab', current);
    if (next === null) return;
    await saveSummaryForUrl(tabUrl, next);
    showToast(next.trim() ? 'Summary saved' : 'Summary cleared');
    await renderDashboard();
    return;
  }

  if (action === 'edit-keywords') {
    e.stopPropagation();
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;
    const current = getKeywordsForUrl(tabUrl).join(', ');
    const next = window.prompt('Add comma-separated keywords for this page', current);
    if (next === null) return;
    await saveKeywordsForUrl(tabUrl, next);
    showToast(next.trim() ? 'Keywords saved' : 'Keywords cleared');
    await renderDashboard();
    return;
  }

  if (action === 'clear-custom-category') {
    e.stopPropagation();
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;
    await clearTabCategory(tabUrl);
    showToast('Moved back to automatic grouping');
    await renderDashboard();
    return;
  }

  if (action === 'delete-category') {
    const categoryId = actionEl.dataset.categoryId;
    const category = getCustomCategoryById(categoryId);
    if (!category) return;
    const confirmed = window.confirm(`Delete category “${category.name}”? Tabs will return to automatic grouping.`);
    if (!confirmed) return;
    await deleteCustomCategory(categoryId);
    showToast(`Deleted ${category.name}`);
    await renderDashboard();
    return;
  }

  if (action === 'toggle-group-collapse') {
    const domainId = actionEl.dataset.domainId;
    const group = domainGroups.find(item => getGroupStableId(item) === domainId);
    if (!group) return;
    if (manuallyExpandedGroups.has(group.domain)) manuallyExpandedGroups.delete(group.domain);
    else manuallyExpandedGroups.add(group.domain);
    await renderDashboard();
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group = domainGroups.find(g => getGroupStableId(g) === domainId);
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('All tabs closed. Fresh start.');
    return;
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id === 'workspaceSearch') {
    workspaceSearchQuery = e.target.value.trim();
    await renderDashboard();
    return;
  }

  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[linn-workspace] Archive search failed:', err);
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'themeSelect') {
    await setTheme(e.target.value);
    showToast('Theme updated');
    return;
  }

  if (e.target.id === 'backgroundColorInput') {
    await setBackgroundColor(e.target.value);
    showToast('Background updated');
    return;
  }

  if (e.target.id === 'cardColorInput') {
    await setCardColor(e.target.value);
    showToast('Module color updated');
    return;
  }

  if (e.target.id === 'accentColorInput') {
    await setAccentColor(e.target.value);
    showToast('Accent color updated');
    return;
  }

  if (e.target.matches('.chip-group-select')) {
    const tabUrl = e.target.dataset.tabUrl;
    const value = e.target.value;
    if (!tabUrl) return;

    if (value === '__create__') {
      const name = window.prompt('Create a new group for this tab');
      if (!name) {
        await renderDashboard();
        return;
      }
      const result = await createCustomCategory(name);
      if (!result.ok && result.reason !== 'duplicate') {
        showToast('Could not create group');
        await renderDashboard();
        return;
      }
      const category = result.ok ? result.category : customCategories.find(category => category.name.toLowerCase() === normalizeCategoryName(name).toLowerCase());
      if (category) {
        await assignTabToCategory(tabUrl, category.id);
        showToast(`Moved to ${category.name}`);
      }
      await renderDashboard();
      return;
    }

    if (!value) {
      await clearTabCategory(tabUrl);
      showToast('Moved to automatic grouping');
      await renderDashboard();
      return;
    }

    await assignTabToCategory(tabUrl, value);
    const category = getCustomCategoryById(value);
    showToast(category ? `Moved to ${category.name}` : 'Group updated');
    await renderDashboard();
  }
});

document.addEventListener('keydown', async (e) => {
  if (e.target.id === 'newCategoryInput' && e.key === 'Enter') {
    e.preventDefault();
    const result = await createCustomCategory(e.target.value);
    if (result.ok) {
      e.target.value = '';
      showToast(`Created ${result.category.name}`);
      await renderDashboard();
    } else {
      showToast(result.reason === 'duplicate' ? 'Category already exists' : 'Enter a category name');
    }
  }
});

document.addEventListener('dragstart', (e) => {
  const chip = e.target.closest('.page-chip[data-tab-url]');
  if (!chip) return;
  draggedTabUrl = chip.dataset.tabUrl || '';
  if (e.dataTransfer) {
    e.dataTransfer.setData('text/plain', draggedTabUrl);
    e.dataTransfer.effectAllowed = 'move';
  }
});

document.addEventListener('dragend', () => {
  draggedTabUrl = '';
  document.querySelectorAll('.mission-card.custom-category.drag-target').forEach(el => el.classList.remove('drag-target'));
});

document.addEventListener('dragover', (e) => {
  const card = e.target.closest('.mission-card.custom-category');
  if (!card) return;
  e.preventDefault();
  card.classList.add('drag-target');
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
});

document.addEventListener('dragleave', (e) => {
  const card = e.target.closest('.mission-card.custom-category');
  if (!card) return;
  const related = e.relatedTarget;
  if (!related || !card.contains(related)) card.classList.remove('drag-target');
});

document.addEventListener('drop', async (e) => {
  const card = e.target.closest('.mission-card.custom-category');
  if (!card) return;
  e.preventDefault();
  card.classList.remove('drag-target');

  const tabUrl = draggedTabUrl || e.dataTransfer?.getData('text/plain');
  const categoryId = card.dataset.categoryId;
  if (!tabUrl || !categoryId) return;

  await assignTabToCategory(tabUrl, categoryId);
  const category = getCustomCategoryById(categoryId);
  showToast(category ? `Moved to ${category.name}` : 'Moved');
  await renderDashboard();
});


/* ----------------------------------------------------------------
   LIVE SYNC
   ---------------------------------------------------------------- */
chrome.tabs.onCreated.addListener(() => scheduleDashboardRefresh());
chrome.tabs.onRemoved.addListener(() => scheduleDashboardRefresh());
chrome.tabs.onUpdated.addListener(() => scheduleDashboardRefresh(180));
chrome.tabs.onActivated.addListener(() => scheduleDashboardRefresh(100));
chrome.windows.onFocusChanged.addListener(() => scheduleDashboardRefresh(100));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.deferred || changes.customCategories || changes.customAssignments || changes.pageKeywords || changes.pageSummaries || changes.uiPrefs) {
    scheduleDashboardRefresh(60);
  }
});

/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
renderDashboard();
