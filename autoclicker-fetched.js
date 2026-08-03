// ============================================================
// autoclicker.js — LinkedIn Job Auto-Clicker (v6 — merged)
// Injected by background.js via chrome.scripting.executeScript
// only when the user explicitly clicks "Start". Never runs on load.
//
// Architecture:
//   Start → check LICENSE_STATUS → if active → click loop
//   Before each click cycle → re-check LICENSE_STATUS
//   If license flips to cancelled mid-run → stop self + notify popup
//
// Delay: randomized 8–35s per click.
// Floor: 8s minimum hardcoded in getDelay() — NOT bypassable
//   by any caller, including raw message.
//
// BRIDGE ARCHITECTURE:
//   MV3 blocks extension API access from dynamically-evaluated code
//   (new Function()) regardless of ISOLATED/MAIN world. This file is
//   therefore written as a FACTORY function that accepts a "bridge"
//   object as its only parameter. The bridge is built in background.js's
//   STATIC extension code (which legitimately has chrome.* access) and
//   passed into the eval'd code. The factory never touches chrome.*
//   directly — it uses bridge.sendMessage() and bridge.onMessage().
//
//   bridge interface:
//     bridge.sendMessage(msg, callback?) → chrome.runtime.sendMessage
//     bridge.onMessage(handler)          → chrome.runtime.onMessage.addListener
// ============================================================

function autoClickerFactory(bridge){ "use strict";

var MIN_DELAY = 8000;  // 8-second hard floor (NOT bypassable)
var MAX_DELAY = 35000;  // 35-second default max
var DEFAULT_MIN = 18000;
var DEFAULT_MAX = 35000;

var state = {
  isRunning: false,
  currentIndex: 0,
  jobCards: [],
  delayMin: DEFAULT_MIN,
  delayMax: DEFAULT_MAX,
  totalClicked: 0,
  totalFound: 0,
  currentPage: 1,
  totalPages: 0,
  licenseActive: false
};

// ── LICENSE CHECK (mid-run enforcement) ──────────────────────

function checkLicense() {
  return new Promise(function(resolve, reject) {
    bridge.sendMessage({ type: "LICENSE_STATUS" }, function(resp) {
      resolve(resp && resp.effectivelyActive === true);
    });
  });
}

// ── RANDOMIZED DELAY ─────────────────────────────────────────

/**
 * Returns a random delay (ms) between MIN_DELAY and the configured max.
 * The 8s floor is enforced HERE, regardless of what delayMin/delayMax
 * values are sent from the popup.
 */
function getDelay() {
  var min = state.delayMin;
  var max = state.delayMax;

  // Enforce the hard floor — can never go below 8s
  if (min < MIN_DELAY) min = MIN_DELAY;
  if (max < MIN_DELAY) max = MIN_DELAY + 5000;
  if (min > max) max = min + 5000;

  // Cap at MAX_DELAY
  if (min > MAX_DELAY) min = MAX_DELAY;
  if (max > MAX_DELAY) max = MAX_DELAY;
  if (min > max) { var tmp = min; min = max; max = tmp; }

  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── MESSAGE DISPATCH ──────────────────────────────────────────
// Uses bridge.onMessage() instead of chrome.runtime.onMessage.addListener()

bridge.onMessage(function(msg, sender, sendResponse) {
  if (msg.source !== "popup") return;

  if (msg.action === "PING") {
    sendResponse({ alive: true });
    return true;
  }

  if (msg.action === "START") {
    state.delayMin = msg.delayMin || DEFAULT_MIN;
    state.delayMax = msg.delayMax || DEFAULT_MAX;
    startAutoClick();
    sendResponse({ success: true });
    return true;
  }

  if (msg.action === "STOP") {
    stopAutoClick();
    sendResponse({ success: true });
    return true;
  }

  if (msg.action === "GET_STATUS") {
    sendResponse({
      isRunning: state.isRunning,
      currentIndex: state.currentIndex,
      totalFound: state.totalFound,
      totalClicked: state.totalClicked,
      currentPage: state.currentPage,
      totalPages: state.totalPages
    });
    return true;
  }

  if (msg.action === "GET_JOB_COUNT") {
    var cards = getJobCards();
    var pages = getTotalPages();
    sendResponse({ count: cards.length, totalPages: pages });
    return true;
  }
});

// ── Job Card Detection ────────────────────────────────────────

function getJobCards() {
  var column = document.querySelector('[data-testid="lazy-column"]');
  if (column) {
    var roleBtns = Array.from(column.querySelectorAll('div[role="button"][tabindex="0"]'));
    var cards = roleBtns.filter(function(el) {
      var label = (el.getAttribute('aria-label') || '').toLowerCase();
      if (label.indexOf('dismiss') === 0) return false;
      return el.querySelector('p') !== null;
    });
    if (cards.length > 0) return filterVisible(cards);
  }

  var cards = Array.from(document.querySelectorAll('[data-occludable-job-id]'));
  if (cards.length > 0) return filterVisible(cards);

  var anchors = Array.from(document.querySelectorAll('a[href*="/jobs/view/"]'));
  cards = deduplicateByJobId(anchors);
  if (cards.length > 0) return filterVisible(cards);

  cards = Array.from(document.querySelectorAll(
    '.scaffold-layout__list-item, .jobs-search-results__list-item'
  ));
  if (cards.length > 0) return filterVisible(cards);

  return [];
}

function deduplicateByJobId(anchors) {
  var seen = {};
  return anchors.filter(function(a) {
    var match = a.href.match(/\/jobs\/view\/(\d+)/);
    if (!match) return false;
    if (seen[match[1]]) return false;
    seen[match[1]] = true;
    return true;
  });
}

function filterVisible(els) {
  return els.filter(function(el) {
    var rect = el.getBoundingClientRect();
    return rect.height > 10 && rect.width > 10;
  });
}

function getClickableElement(card) {
  if (card.getAttribute('role') === 'button') return card;
  var inner = card.querySelector(
    '.job-card-container, .job-card-list__entity-lockup, [class*="job-card-container"], [class*="job-card-list"]'
  );
  return inner || card;
}

// ── Pagination ────────────────────────────────────────────────

function getNextPageButton() {
  var exact = document.querySelector('[data-testid="pagination-controls-next-button-visible"]');
  if (exact && !exact.disabled) return exact;

  var hidden = document.querySelector('[data-testid="pagination-controls-next-button-hidden"]');
  if (hidden) return null;

  var byAriaLabel = document.querySelector('button[aria-label*="next" i]:not([disabled])');
  if (byAriaLabel) return byAriaLabel;

  var allBtns = Array.from(document.querySelectorAll('button'));
  for (var i = 0; i < allBtns.length; i++) {
    if (allBtns[i].textContent.trim() === 'Next' && !allBtns[i].disabled) {
      return allBtns[i];
    }
  }
  return null;
}

function getTotalPages() {
  var indicators = Array.from(document.querySelectorAll('[data-testid^="pagination-indicator-"]'));
  if (indicators.length > 0) {
    var nums = indicators.map(function(b) {
      var n = parseInt(b.getAttribute('data-testid').replace('pagination-indicator-', ''), 10);
      return isNaN(n) ? 0 : n;
    });
    return Math.max.apply(null, nums) + 1;
  }

  var pageBtns = Array.from(document.querySelectorAll('[data-testid="pagination-controls-list"] button'));
  var nums = pageBtns.map(function(b) { return parseInt(b.textContent.trim(), 10); })
    .filter(function(n) { return !isNaN(n); });
  if (nums.length > 0) return Math.max.apply(null, nums);

  return 0;
}

function getCurrentPage() {
  var active = document.querySelector('[data-testid^="pagination-indicator-"][aria-current="true"]');
  if (active) {
    var idx = parseInt(active.getAttribute('data-testid').replace('pagination-indicator-', ''), 10);
    if (!isNaN(idx)) return idx + 1;
    var num = parseInt(active.textContent.trim(), 10);
    if (!isNaN(num)) return num;
  }

  try {
    var url = new URL(window.location.href);
    var start = url.searchParams.get('start');
    if (start) return Math.floor(parseInt(start, 10) / 25) + 1;
  } catch(e) {}

  return 1;
}

function getPageSnapshot() {
  var cards = getJobCards();
  if (cards.length === 0) return '__empty__';
  return cards[0].textContent.trim().slice(0, 120);
}

// ── Auto-Click Logic ──────────────────────────────────────────

async function startAutoClick() {
  if (state.isRunning) return;
  await sleep(800);

  state.totalClicked = 0;
  state.currentPage  = getCurrentPage();
  state.totalPages   = getTotalPages();
  state.isRunning    = true;

  await clickCurrentPage();
}

async function clickCurrentPage() {
  if (!state.isRunning) return;

  await sleep(1200); // let React finish rendering

  state.jobCards    = getJobCards().slice(0, 25);
  state.totalFound  = state.jobCards.length;
  state.currentIndex = 0;

  if (state.jobCards.length === 0) {
    notifyPopup({ type: 'ERROR', message: 'No job listings found. Make sure the jobs list is loaded on the left side.' });
    state.isRunning = false;
    return;
  }

  state.currentPage = getCurrentPage();
  state.totalPages  = getTotalPages();

  notifyPopup({
    type: 'PAGE_START',
    page: state.currentPage,
    totalPages: state.totalPages,
    totalOnPage: state.jobCards.length,
    totalClicked: state.totalClicked
  });

  clickNext();
}

async function clickNext() {
  if (!state.isRunning) return;

  // LICENSE CHECK — every click cycle
  var licActive = await checkLicense();
  state.licenseActive = licActive;
  if (!licActive) {
    notifyPopup({ type: 'LICENSE_CANCELLED', totalClicked: state.totalClicked });
    state.isRunning = false;
    return;
  }

  if (state.currentIndex >= state.jobCards.length) {
    // Page done — look for next
    var nextBtn = getNextPageButton();

    if (!nextBtn) {
      state.isRunning = false;
      notifyPopup({ type: 'ALL_DONE', totalClicked: state.totalClicked, totalPages: state.currentPage });
      return;
    }

    notifyPopup({ type: 'NAVIGATING', page: state.currentPage + 1, totalClicked: state.totalClicked });

    var snapshotBefore = getPageSnapshot();

    try { nextBtn.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(e) {}
    await sleep(800);
    nextBtn.click();

    await waitForPageChange(snapshotBefore);

    scrollListToTop();
    await sleep(2000);

    await clickCurrentPage();
    return;
  }

  var card = state.jobCards[state.currentIndex];
  try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(e) {}
  await sleep(500);

  try { getClickableElement(card).click(); } catch(e) {}

  state.totalClicked++;
  state.currentIndex++;

  notifyPopup({
    type: 'PROGRESS',
    currentIndex: state.currentIndex,
    totalClicked: state.totalClicked,
    totalOnPage: state.totalFound,
    page: state.currentPage,
    totalPages: state.totalPages
  });

  var delay = getDelay();
  console.log("[AUTOCLICKER] Next click in " + (delay / 1000).toFixed(1) + "s");
  setTimeout(function() { clickNext(); }, delay);
}

function waitForPageChange(snapshotBefore) {
  return new Promise(function(resolve) {
    var checks = 0;
    var interval = setInterval(function() {
      checks++;
      var snap = getPageSnapshot();
      if ((snap !== '__empty__' && snap !== snapshotBefore) || checks >= 40) {
        clearInterval(interval);
        resolve();
      }
    }, 500);
  });
}

function scrollListToTop() {
  var panel = document.querySelector(
    '[data-testid="lazy-column"], .jobs-search-results-list, .scaffold-layout__list'
  );
  if (panel) panel.scrollTo({ top: 0, behavior: 'smooth' });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function stopAutoClick() {
  state.isRunning = false;
  notifyPopup({ type: 'STOPPED', totalClicked: state.totalClicked });
}

// ── Notify popup via bridge ──────────────────────────────────
// Uses bridge.sendMessage() instead of chrome.runtime.sendMessage()

function notifyPopup(data) {
  try {
    bridge.sendMessage(
      Object.assign({}, data, { source: 'autoclicker' })
    );
  } catch(e) {}
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

} // end autoClickerFactory