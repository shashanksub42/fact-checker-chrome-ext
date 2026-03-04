# FactCheckAI — Chrome Extension

A Chrome side-panel extension that performs real-time AI fact-checking on any YouTube video you're watching. As the video plays, the extension automatically analyses the transcript in segments and classifies each claim as a **FACT** (with sources) or **SPECULATION**, synced to the current video position — without leaving the YouTube tab.

---

## Architecture

```
┌─────────────────────────┐        HTTPS        ┌──────────────────────┐
│   Chrome Extension      │ ──────────────────▶  │  Flask API (Render)  │
│                         │                      │                      │
│  index.html  (side      │  POST /api/load      │  Fetch transcript    │
│  panel UI)              │  POST /api/factcheck │  via youtube-        │
│                         │                      │  transcript-api      │
│  app.js  (polling,      │◀──────────────────── │  + OpenAI GPT-4o-mini│
│  fetch, render)         │   JSON responses     └──────────────────────┘
│                         │
│  content.js  (injected  │  relays currentTime
│  into YouTube tab)  ───▶│  via chrome.runtime.sendMessage
│                         │
│  background.js          │  opens side panel on icon click
└─────────────────────────┘
```

**Key design decisions:**
- The extension uses Chrome's **Side Panel API** so the fact-check results appear beside the YouTube video without covering it
- `content.js` is injected into YouTube pages to relay the `<video>` element's `currentTime` every 500 ms — no embedded player needed
- The YouTube IFrame API is not used; the extension reads the video already playing in the tab
- The Flask backend proxies transcript requests through **Webshare** to work around YouTube's cloud-IP blocks on Render

---

## Features

- Opens as a **side panel** next to any YouTube video — no separate tab or popup
- **Auto-detects** the YouTube URL from the active tab
- Real-time fact checking via GPT-4o-mini — synced to the video's current playback position
- Claims labelled as **✓ FACT** (green, with source links) or **⚠ SPECULATION** (amber, with explanation)
- Segments pre-fetched ahead of playback to minimise wait time
- Automatic retry with countdown on OpenAI rate limits
- Persistent source archive grouped by video title with jump-to-timestamp buttons
- Server wake-up ping with status badge (handles Render free-tier cold starts)

---

## Project Structure

```
fact-checker-chrome-ext/
├── manifest.json      # MV3 manifest — side panel, content script, permissions
├── background.js      # Service worker — opens side panel on icon click
├── content.js         # Injected into YouTube — relays video time & handles seeks
├── index.html         # Side panel UI shell
├── app.js             # Core logic: polling, fetch, rendering, archive
├── style.css          # Dark-theme UI styles
├── server.py          # Flask backend — transcript fetch + OpenAI fact-check
└── requirements.txt   # Python dependencies
```

---

## Backend Setup (Render)

The Flask backend is deployed on Render and handles:
- `GET  /health` — wake-up ping (returns `{"status": "ok"}`)
- `POST /api/load` — fetches video title + transcript, returns chunked segments
- `POST /api/factcheck` — runs GPT-4o-mini fact-check on a transcript chunk

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
3. The YouTube URL is auto-filled; enter your OpenAI API key (stored locally, never sent to third parties)
4. Click **Load Video & Start Fact Check**
5. Wait for the server status badge to show **✓ Server ready** (first open may take ~60 s on free tier)
6. Fact-check results appear automatically as the video plays — or immediately for the current segment

---

## Notes

- Transcript is split into ~90-second segments; each is fact-checked independently as playback reaches it
- Two segments are pre-fetched ahead of the current position to reduce visible latency
- If you hit OpenAI rate limits, the segment auto-retries after 30 seconds with a countdown
- Sources are saved to `localStorage` and persist across sessions
- The extension requires the `activeTab`, `tabs`, `sidePanel`, and `storage` permissions
