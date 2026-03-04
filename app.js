/* ══════════════════════════════════════════════════════════════════
   FactCheckAI  –  app.js
   ══════════════════════════════════════════════════════════════════ */

const API_BASE   = "https://fact-checker-chrome-ext.onrender.com";
const ARCHIVE_KEY = "factcheck_archive";   // localStorage key

/* ── Server wake-up ping ─────────────────────────────────────────── */
// Render free tier sleeps after inactivity; ping /health on load so the
// server is warm by the time the user clicks the button.
(function pingServer() {
  const badge = document.getElementById("server-status");
  if (badge) { badge.textContent = "⏳ Server waking up…"; badge.className = "server-badge waking"; }
  const t0 = Date.now();
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 90000);
  fetch(API_BASE + "/health", { signal: ctrl.signal })
    .then(r => r.ok ? r.json() : Promise.reject(r.status))
    .then(() => {
      if (badge) { badge.textContent = "✓ Server ready"; badge.className = "server-badge ready"; }
      setTimeout(() => { if (badge) badge.classList.add("fade-out"); }, 3000);
    })
    .catch(() => {
      if (badge) { badge.textContent = "✗ Server unreachable"; badge.className = "server-badge error"; }
    })
    .finally(() => clearTimeout(tid));
})();

/* ── State ───────────────────────────────────────────────────────── */
let currentPlayerTime = 0;    // relayed by content.js
let videoPaused       = true;
let videoTitle        = "";
let chunks            = [];   // [{start, end, text}]

let chunkResults   = {};       // chunkIdx -> {status:'pending'|'done'|'error', claims:[]}
let currentChunkIdx = -1;
let inFlight       = new Set();// chunk indices currently being fetched

/* ── DOM refs ────────────────────────────────────────────────────── */
const loadBtn        = document.getElementById("load-btn");
const loadBtnText    = document.getElementById("load-btn-text");
const loadSpinner    = document.getElementById("load-spinner");
const ytUrlInput     = document.getElementById("yt-url");
const apiKeyInput    = document.getElementById("api-key");
const toggleKeyBtn   = document.getElementById("toggle-key");
const setupError     = document.getElementById("setup-error");
const workspace      = document.getElementById("workspace");
const titleDisplay   = document.getElementById("video-title-display");
const chunkStatus    = document.getElementById("chunk-status");
const timeDisplay    = document.getElementById("time-display");
const resultsBody    = document.getElementById("results-body");
const fcLoading      = document.getElementById("fc-loading");
const archiveGroups  = document.getElementById("archive-groups");
const archiveEmpty   = document.getElementById("archive-empty");
const clearArchiveBtn = document.getElementById("clear-archive-btn");

/* ── Persist API key across sessions ─────────────────────────────── */
(function restoreKey() {
  const saved = localStorage.getItem("factcheck_api_key");
  if (saved) apiKeyInput.value = saved;
})();

apiKeyInput.addEventListener("change", () => {
  localStorage.setItem("factcheck_api_key", apiKeyInput.value.trim());
});

toggleKeyBtn.addEventListener("click", () => {
  apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
});

/* ── Chrome extension: auto-detect tab URL + content script bridge ─── */
function autoDetectUrl() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab) return;
    const url = tab.url || "";
    const isYT = /youtube\.com\/watch/.test(url);
    ytUrlInput.value = url;
    document.getElementById("not-youtube-msg").classList.toggle("hidden", isYT);
    document.getElementById("url-detected-badge").classList.toggle("hidden", !isYT);
  });
}
autoDetectUrl();

function seekInVideo(time) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { type: "seekTo", time });
    }
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "timeUpdate") {
    currentPlayerTime = msg.time || 0;
    videoPaused = msg.paused || false;
    if (chunks.length > 0) {
      timeDisplay.textContent = formatTime(currentPlayerTime);
      pollTick(); // always tick on time update, paused or not
    }
  }
  if (msg.type === "urlChange") {
    const isYT = /youtube\.com\/watch/.test(msg.url);
    ytUrlInput.value = msg.url;
    document.getElementById("not-youtube-msg").classList.toggle("hidden", isYT);
    document.getElementById("url-detected-badge").classList.toggle("hidden", !isYT);
    if (chunks.length > 0) {
      stopFallbackPolling();
      chunks = []; chunkResults = {}; currentChunkIdx = -1; currentPlayerTime = 0;
      workspace.classList.add("hidden");
      showSetupError("New video detected! Click \u2018Start Fact Check\u2019 to analyze it.");
    }
  }
});

/* ── Load Button ─────────────────────────────────────────────────── */
loadBtn.addEventListener("click", handleLoad);
ytUrlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") handleLoad(); });

async function handleLoad() {
  const url    = ytUrlInput.value.trim();
  const apiKey = apiKeyInput.value.trim();

  // Basic validation
  if (!url) { showSetupError("Please enter a YouTube URL."); return; }
  if (!apiKey) { showSetupError("Please enter your OpenAI API key."); return; }

  hideSetupError();
  setLoadBtnLoading(true, "Contacting server…");

  // Render free tier can take 30–60 s to wake from sleep
  const wakeTimer = setTimeout(() => {
    setLoadBtnLoading(true, "Server is waking up (free tier)…");
  }, 8000);

  try {
    const data = await fetchJSON("/api/load", { url });
    clearTimeout(wakeTimer);
    videoTitle = data.title;
    chunks     = data.chunks;
    chunkResults = {};
    inFlight.clear();
    currentChunkIdx = -1;
    currentPlayerTime = 0;
    videoPaused = false;

    localStorage.setItem("factcheck_api_key", apiKey);

    // Show workspace
    workspace.classList.remove("hidden");
    titleDisplay.textContent = videoTitle;

    renderArchive();

    // Reset fact-check display for new video
    resultsBody.innerHTML = "";
    resultsBody.appendChild(makePlaceholder("Play the video to start fact checking…"));
    currentChunkIdx = -1;
    chunkStatus.textContent = "";
    timeDisplay.textContent = "0:00";

    // Start fallback polling in case content script messages are delayed
    startFallbackPolling();

    // Immediately run a poll tick so chunk 0 group is created and fetching starts
    pollTick();

    // Scroll workspace into view
    workspace.scrollIntoView({ behavior: "smooth" });

  } catch (err) {
    clearTimeout(wakeTimer);
    showSetupError(err.message || "Failed to load video. Check the URL and try again.");
  } finally {
    setLoadBtnLoading(false, "");
  }
}

/* ── Polling (driven by content.js timeUpdate messages + fallback interval) ── */
let fallbackTimer = null;

function startFallbackPolling() {
  if (fallbackTimer) return;
  fallbackTimer = setInterval(() => {
    if (chunks.length > 0) pollTick();
  }, 1000);
}

function stopFallbackPolling() {
  clearInterval(fallbackTimer);
  fallbackTimer = null;
}

function pollTick() {
  if (!chunks.length) return;
  const t = currentPlayerTime;

  // Update clock
  timeDisplay.textContent = formatTime(t);

  // Find current chunk
  const idx = chunkIndexAt(t);
  if (idx === -1) return;

  // Fetch current + pre-fetch ahead
  fetchChunk(idx);
  if (idx + 1 < chunks.length) fetchChunk(idx + 1);
  if (idx + 2 < chunks.length) fetchChunk(idx + 2);

  if (idx === currentChunkIdx) return;  // same chunk – nothing new

  currentChunkIdx = idx;
  chunkStatus.textContent = `Segment ${idx + 1} / ${chunks.length}`;
  ensureChunkGroup(idx);   // create DOM group when video reaches this timestamp
  renderChunkGroup(idx);   // fill it immediately if results already arrived
  activateChunkGroup(idx);
}

/* ── Chunk fetching ──────────────────────────────────────────────── */
async function fetchChunk(idx) {
  if (idx < 0 || idx >= chunks.length) return;
  // Allow retrying errored chunks; block only on in-flight or successful results
  if (inFlight.has(idx)) return;
  if (chunkResults[idx] && chunkResults[idx].status === "done") return;

  inFlight.add(idx);

  const apiKey = apiKeyInput.value.trim();

  try {
    const data = await fetchJSON("/api/factcheck", {
      text:        chunks[idx].text,
      api_key:     apiKey,
      video_title: videoTitle
    });
    chunkResults[idx] = { status: "done", claims: data.claims || [] };

    // Save sources to archive
    saveSourcesToArchive(data.claims || [], chunks[idx].start);

    // Update this chunk's group in the results panel
    renderChunkGroup(idx);
  } catch (err) {
    const isRateLimit = err.status === 429 || /rate limit|429/i.test(err.message);
    chunkResults[idx] = { status: "error", error: err.message, rateLimit: isRateLimit };
    renderChunkGroup(idx);

    // Auto-retry rate-limit errors after a delay
    if (isRateLimit) {
      scheduleRetry(idx, 30);
    }
  } finally {
    inFlight.delete(idx);
  }
}

/* ── Rate-limit auto-retry with countdown ─────────────────────────── */
const retryTimers = {}; // idx -> intervalId

function scheduleRetry(idx, seconds) {
  // Cancel any existing timer for this chunk
  if (retryTimers[idx]) { clearInterval(retryTimers[idx]); delete retryTimers[idx]; }

  let remaining = seconds;
  chunkResults[idx] = { status: "error", error: `Rate limited – retrying in ${remaining}s…`, rateLimit: true, countdown: remaining };
  renderChunkGroup(idx);

  retryTimers[idx] = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(retryTimers[idx]);
      delete retryTimers[idx];
      delete chunkResults[idx];
      fetchChunk(idx);
      renderChunkGroup(idx);
    } else {
      if (chunkResults[idx]) {
        chunkResults[idx].error = `Rate limited – retrying in ${remaining}s…`;
        chunkResults[idx].countdown = remaining;
        renderChunkGroup(idx);
      }
    }
  }, 1000);
}

/* ── Results Panel – cumulative grouped view ─────────────────────── */

// Ensure a group container exists for chunk idx (creates it if absent)
function ensureChunkGroup(idx) {
  const groupId = `fc-group-${idx}`;
  if (document.getElementById(groupId)) return;

  // Remove placeholder if present
  const placeholder = resultsBody.querySelector(".placeholder-msg");
  if (placeholder) placeholder.remove();

  const group = document.createElement("div");
  group.id = groupId;
  group.className = "fc-group";

  const header = document.createElement("button");
  header.className = "fc-group-header";
  header.textContent = formatTime(chunks[idx].start);
  header.title = "Jump to this segment";
  header.addEventListener("click", () => {
    seekInVideo(chunks[idx].start);
  });

  const body = document.createElement("div");
  body.className = "fc-group-body";
  body.innerHTML = `<div class="fc-group-analysing"><span class="dot-pulse"></span> Analysing…</div>`;

  group.appendChild(header);
  group.appendChild(body);

  // Insert in timestamp order
  const existing = Array.from(resultsBody.querySelectorAll(".fc-group"));
  const after = existing.find(el => {
    const elIdx = parseInt(el.id.replace("fc-group-", ""));
    return elIdx > idx;
  });
  if (after) resultsBody.insertBefore(group, after);
  else resultsBody.appendChild(group);
}

// Fill / refresh the body of an existing group (does NOT create the group)
function renderChunkGroup(idx) {
  const body = document.querySelector(`#fc-group-${idx} .fc-group-body`);
  if (!body) return;  // group not yet created — will render when video reaches this timestamp

  const result = chunkResults[idx];

  // Update the fc-loading spinner visibility based on in-flight state
  const anyInFlight = inFlight.size > 0 ||
    Object.values(chunkResults).some(r => r && r.status !== "done" && r.status !== "error");
  fcLoading.classList.toggle("hidden", !anyInFlight);

  if (!result || result.status !== "done") {
    // Error or still loading – show inline message
    if (result && result.status === "error") {
      const countdown = result.countdown;
      const countdownHtml = countdown
        ? `<span class="fc-retry-info">⏳ Auto-retrying in ${countdown}s</span>`
        : `<button class="ghost-btn fc-retry-btn" style="margin-top:.4rem">↺ Retry</button>`;
      body.innerHTML = `<div class="error-msg" style="margin:.25rem 0">${result.rateLimit ? "⏳" : "⚠"} ${escapeHtml(result.error || "Unknown error")}<br/>${countdownHtml}</div>`;
      if (!countdown) {
        body.querySelector(".fc-retry-btn").addEventListener("click", () => {
          delete chunkResults[idx];
          renderChunkGroup(idx);
          fetchChunk(idx);
        });
      }
    } else {
      body.innerHTML = `<div class="fc-group-analysing"><span class="dot-pulse"></span> Analysing…</div>`;
    }
    return;
  }

  if (result.claims.length === 0) {
    body.innerHTML = `<div class="fc-group-empty">No specific claims identified.</div>`;
    return;
  }

  body.innerHTML = "";
  result.claims.forEach(claim => {
    body.appendChild(buildClaimCard(claim, chunks[idx].start));
  });
}

// Mark the active group and scroll it into view
function activateChunkGroup(idx) {
  document.querySelectorAll(".fc-group-header").forEach(h => h.classList.remove("active"));
  const header = document.querySelector(`#fc-group-${idx} .fc-group-header`);
  if (header) {
    header.classList.add("active");
    header.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function buildClaimCard(claim, chunkStart) {
  const isFact = claim.type === "FACT";
  const card   = document.createElement("div");
  card.className = `claim-card ${isFact ? "fact" : "speculation"}`;

  const sources = (claim.sources || []).filter(Boolean);

  card.innerHTML = `
    <div class="claim-top">
      <span class="claim-badge">${isFact ? "✓ FACT" : "⚠ SPECULATION"}</span>
      <span class="claim-ts">${formatTime(chunkStart)}</span>
    </div>
    <div class="claim-text">${escapeHtml(claim.claim)}</div>
    <div class="claim-explain">${escapeHtml(claim.explanation || "")}</div>
    ${sources.length ? `
      <div class="claim-sources">
        ${sources.map(url =>
          `<a class="source-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`
        ).join("")}
      </div>` : ""}
  `;
  return card;
}

/* ── Chunk helpers ───────────────────────────────────────────────── */
function chunkIndexAt(t) {
  for (let i = 0; i < chunks.length; i++) {
    if (t >= chunks[i].start && t < chunks[i].end) return i;
  }
  if (chunks.length && t >= chunks[chunks.length - 1].start) return chunks.length - 1;
  // Before first chunk starts — still return 0 so pre-fetching begins immediately
  if (chunks.length && t < chunks[0].start) return 0;
  return -1;
}

/* ── Archive ─────────────────────────────────────────────────────── */
function loadArchive() {
  try { return JSON.parse(localStorage.getItem(ARCHIVE_KEY)) || {}; }
  catch { return {}; }
}

function saveArchive(data) {
  localStorage.setItem(ARCHIVE_KEY, JSON.stringify(data));
}

function saveSourcesToArchive(claims, chunkStart) {
  const archive = loadArchive();
  const group   = videoTitle || "Unknown Video";

  if (!archive[group]) archive[group] = [];

  claims.forEach(claim => {
    (claim.sources || []).filter(Boolean).forEach(url => {
      // Deduplicate
      const exists = archive[group].some(item => item.url === url);
      if (!exists) {
        archive[group].push({
          url,
          label:     claim.claim,
          type:      claim.type,
          timestamp: chunkStart,
          savedAt:   Date.now()
        });
      }
    });
  });

  saveArchive(archive);
  renderArchive();
}

function renderArchive() {
  const archive = loadArchive();
  const groups  = Object.keys(archive);

  if (groups.length === 0) {
    archiveGroups.innerHTML = "";
    archiveEmpty.classList.remove("hidden");
    return;
  }

  archiveEmpty.classList.add("hidden");
  archiveGroups.innerHTML = "";

  groups.forEach(groupName => {
    const items = archive[groupName];
    if (!items || items.length === 0) return;

    const groupEl = document.createElement("div");
    groupEl.className = "archive-group";

    const titleEl = document.createElement("div");
    titleEl.className = "archive-group-title";
    titleEl.innerHTML = `
      <span>📽 ${escapeHtml(groupName)}</span>
      <span class="source-count">(${items.length})</span>
      <span class="toggle-icon">▾</span>`;
    titleEl.addEventListener("click", () => {
      titleEl.classList.toggle("collapsed");
      listEl.style.maxHeight = titleEl.classList.contains("collapsed")
        ? "0"
        : listEl.scrollHeight + "px";
    });

    const listEl = document.createElement("div");
    listEl.className = "archive-source-list";
    listEl.style.maxHeight = items.scrollHeight + "px";

    items.forEach(item => {
      const row = document.createElement("div");
      row.className = "archive-source-item";
      row.innerHTML = `
        <button class="arch-ts arch-ts-btn" title="Jump to ${formatTime(item.timestamp)} in video">${formatTime(item.timestamp)} ↩</button>
        <div>
          <a class="arch-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">
            ${escapeHtml(truncate(item.url, 55))}
          </a>
          <div class="arch-label">${escapeHtml(truncate(item.label, 80))}</div>
        </div>`;
      row.querySelector(".arch-ts-btn").addEventListener("click", () => {
        seekInVideo(item.timestamp);
        workspace.scrollIntoView({ behavior: "smooth" });
      });
      listEl.appendChild(row);
    });

    groupEl.appendChild(titleEl);
    groupEl.appendChild(listEl);
    archiveGroups.appendChild(groupEl);

    // Set correct max-height after add to DOM
    requestAnimationFrame(() => {
      listEl.style.maxHeight = listEl.scrollHeight + "px";
    });
  });
}

clearArchiveBtn.addEventListener("click", () => {
  if (confirm("Clear all saved sources?")) {
    localStorage.removeItem(ARCHIVE_KEY);
    renderArchive();
  }
});

/* ── Utility helpers ─────────────────────────────────────────────── */
function formatTime(secs) {
  const s = Math.floor(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${m}:${pad(sec)}`;
}
function pad(n) { return String(n).padStart(2, "0"); }

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + "…" : str;
}

function makePlaceholder(msg) {
  const el = document.createElement("div");
  el.className = "placeholder-msg";
  el.textContent = msg;
  return el;
}

async function fetchJSON(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000); // 90 s
  try {
    const res = await fetch(API_BASE + path, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      signal:  controller.signal
    });
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error("Request timed out. The server may be starting up — please try again.");
    }
    if (e instanceof TypeError) {
      throw new Error(`Network error: could not reach ${API_BASE}. Check your internet connection.`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function showSetupError(msg) {
  setupError.textContent = msg;
  setupError.classList.remove("hidden");
}
function hideSetupError() { setupError.classList.add("hidden"); }

function setLoadBtnLoading(on, msg) {
  loadBtn.disabled = on;
  loadBtnText.textContent = on ? (msg || "Loading…") : "Load Video & Start Fact Check";
  loadSpinner.classList.toggle("hidden", !on);
}

/* ── Init archive on page load ───────────────────────────────────── */
renderArchive();
