# FactCheckAI — Chrome Extension

A Chrome side-panel extension that performs real-time AI fact-checking on any YouTube video you're watching. As the video plays, the extension automatically analyses the transcript in segments and classifies each claim as a **FACT** (with sources) or **SPECULATION**, synced to the current video position — without leaving the YouTube tab.

---

## Architecture

```
┌──────────────────────────┐        HTTPS        ┌──────────────────────┐
│   Chrome Extension       │ ──────────────────▶  │  Flask API (Render)  │
│                          │                      │                      │
│  index.html  (side       │  POST /api/load      │  Fetch transcript    │
│  panel UI)               │                      │  via youtube-        │
│                          │◀──────────────────── │  transcript-api      │
│  app.js  (polling,       │   JSON (chunks only) └──────────────────────┘
│  fetch, render, cache)   │
│                          │        HTTPS        ┌──────────────────────┐
│                          │ ──────────────────▶  │  OpenAI API          │
│                          │  POST /v1/chat/      │  GPT-4o-mini         │
│                          │  completions         │  (direct, no proxy)  │
│                          │◀──────────────────── └──────────────────────┘
│                          │
│  content.js  (injected   │  relays currentTime
│  into YouTube tab)   ───▶│  via chrome.runtime.sendMessage
│                          │
│  background.js           │  opens side panel + fires /health wake-up ping
└──────────────────────────┘
```

**Key design decisions:**
- The extension uses Chrome's **Side Panel API** so the fact-check results appear beside the YouTube video without covering it
- `content.js` is injected into YouTube pages to relay the `<video>` element's `currentTime` every 500 ms — no embedded player needed
- The YouTube IFrame API is not used; the extension reads the video already playing in the tab
- The Flask backend proxies transcript requests through **Webshare** to work around YouTube's cloud-IP blocks on Render
- **OpenAI is called directly from the extension client** — the API key never leaves the browser or touches the server

---

## Features

- Opens as a **side panel** next to any YouTube video — no separate tab or popup
- **Auto-detects** the YouTube URL from the active tab
- Real-time fact checking via GPT-4o-mini — synced to the video's current playback position
- Claims labelled as **✓ FACT** (green, with source links) or **⚠ SPECULATION** (amber, with explanation)
- **OpenAI called directly from the extension** — your API key never touches the backend server
- API key stored in `chrome.storage.local` (sandboxed to the extension, not exposed via `localStorage`)
- **Transcript cached locally** (24-hour TTL via `chrome.storage.local`) — repeat loads of the same video skip the server entirely
- **Fact-check results cached per segment** — re-watching a video renders all results instantly with no API calls
- Segments pre-fetched ahead of playback (while playing) to minimise wait time
- Automatic retry with countdown on OpenAI rate limits
- Persistent source archive grouped by video title with jump-to-timestamp buttons
- Server wake-up ping fired by `background.js` at extension load — server is warm before the side panel ever opens

---

## Project Structure

```
fact-checker-chrome-ext/
├── manifest.json      # MV3 manifest — side panel, content script, permissions
├── background.js      # Service worker — opens side panel + fires /health ping on load
├── content.js         # Injected into YouTube — relays video time & handles seeks
├── index.html         # Side panel UI shell
├── app.js             # Core logic: polling, fetch, caching, rendering, archive
├── style.css          # Dark-theme UI styles
├── server.py          # Flask backend — transcript fetch only (no API key handling)
└── requirements.txt   # Python dependencies
```

---

## Backend Setup (Render)

The Flask backend is deployed on Render and handles:
- `GET  /health` — wake-up ping (returns `{"status": "ok"}`)
- `POST /api/load` — fetches video title + transcript, returns chunked segments (rate-limited to 20 req/min per IP)

> **Note:** `/api/factcheck` was removed in v1.2. OpenAI is now called directly from the extension client — the server never sees the API key.

### Security
- CORS is restricted to the deployed Render domain and `chrome-extension://` origins only
- Static file routes use an explicit allowlist — `server.py` and other internal files cannot be fetched
- Rate limiting via `flask-limiter` protects `/api/load` from abuse

### Required Environment Variables (set in Render dashboard)

| Variable | Description |
|---|---|
| `WEBSHARE_USERNAME` | Webshare proxy username (to bypass YouTube's cloud-IP blocks) |
| `WEBSHARE_PASSWORD` | Webshare proxy password |

### Deploy your own

1. Fork this repo
2. Create a new **Web Service** on [render.com](https://render.com) pointed at your fork
3. Set the build command: `pip install -r requirements.txt`
4. Set the start command: `gunicorn -w 2 -b 0.0.0.0:$PORT server:app`
5. Add the `WEBSHARE_USERNAME` and `WEBSHARE_PASSWORD` env vars
6. Update `API_BASE` in `app.js` to your Render service URL

---

## Installing the Extension

1. Clone or download this repo
2. Update `API_BASE` in `app.js` to your deployed Render URL
3. Open Chrome → go to `chrome://extensions`
4. Enable **Developer mode** (top-right toggle)
5. Click **Load unpacked** → select this folder
6. Pin the **FactCheckAI** icon from the puzzle-piece menu

---

## Usage

1. Navigate to any YouTube video in Chrome
2. Click the **FactCheckAI** icon — the side panel opens to the right of the page
3. The YouTube URL is auto-filled; enter your OpenAI API key (stored in `chrome.storage.local` — sandboxed to the extension, never sent to the backend)
4. Click **Load Video & Start Fact Check**
5. If the server is cold (Render free tier), the status badge shows **⏳ Server waking up…** — this takes up to ~60 s on first open; subsequent opens are faster because `background.js` pings the server as soon as the extension loads
6. Fact-check results appear automatically as the video plays — or immediately for segments loaded from cache

---

## Notes

- Transcript is split into ~90-second segments; each is fact-checked independently as playback reaches it
- Two segments are pre-fetched ahead of the current position while the video is playing (pre-fetch is paused when the video is paused, to avoid wasting API quota)
- If you hit OpenAI rate limits, the segment auto-retries after 30 seconds with a countdown
- Transcripts are cached per video ID in `chrome.storage.local` for 24 hours — reloading the same video is instant
- Fact-check results are also cached per segment — re-watching any previously checked video requires zero OpenAI calls
- Sources are saved to `chrome.storage.local` and persist across sessions
- The extension requires the `activeTab`, `tabs`, `sidePanel`, and `storage` permissions

---

## Changelog

### v1.2 — Security hardening
- **OpenAI calls moved to the client** — `factCheckWithOpenAI()` in `app.js` calls `api.openai.com` directly; the API key never touches the server
- **API key storage** migrated from `localStorage` to `chrome.storage.local` (sandboxed to the extension)
- `manifest.json`: added `https://api.openai.com/*` to `host_permissions`
- **`/api/factcheck` endpoint removed** from the server entirely
- **CORS** restricted to the Render domain and `chrome-extension://` origins
- **Static file whitelist** — prevents `server.py`, `.env`, and other internal files from being served
- **Rate limiting** via `flask-limiter` — `/api/load` capped at 20 requests/minute per IP
- **Bug fix** — `inFlight` guard moved before first `await` in `fetchChunk()` to prevent concurrent duplicate requests that were rate-limiting chunks 1+ and causing only the first chunk to show results

### v1.1 — Faster load times
- **Transcript cache** — title and chunks stored in `chrome.storage.local` with 24-hour TTL; repeat loads of the same video skip the server entirely
- **Chunk-result cache** — fact-check results persisted per `videoId + chunkIndex`; re-watching renders everything instantly
- **Background wake-up ping** — `background.js` pings `/health` on install, startup, and service-worker activation so the server is warm before the side panel opens
- **Pre-fetch gating** — `idx+1` and `idx+2` are only pre-fetched while the video is playing, not while paused
- `index.html`: `<link rel="preload">` added for `style.css` to eliminate a render-blocking request
- `server.py`: removed unused `transcript` field from `/api/load` response (~50–80% payload reduction on long videos)
