from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import TranscriptsDisabled, NoTranscriptFound, CouldNotRetrieveTranscript
from youtube_transcript_api.proxies import WebshareProxyConfig, GenericProxyConfig
import re
import requests
import os

app = Flask(__name__)

# Only allow requests from the deployed frontend and from the Chrome extension.
# All other origins (random websites trying to abuse the endpoint) are rejected.
def _is_allowed_origin(origin: str) -> bool:
    if not origin:
        return True  # non-browser callers (curl, Render health checks, etc.)
    return (
        origin == "https://fact-checker-chrome-ext.onrender.com"
        or origin.startswith("chrome-extension://")
    )

CORS(app, origins=_is_allowed_origin)

# Rate-limit /api/load to prevent transcript-scraping abuse.
# Reads the real IP from X-Forwarded-For when behind Render's proxy.
def _get_real_ip():
    forwarded = request.headers.get("X-Forwarded-For", "")
    return forwarded.split(",")[0].strip() if forwarded else get_remote_address()

limiter = Limiter(key_func=_get_real_ip, app=app, default_limits=[])

# Static files served from this directory — explicit allowlist only.
# Never use send_from_directory(".", filename) with an open wildcard route;
# that would expose server.py, .env, and any other file in the working dir.
_ALLOWED_STATIC = frozenset(["index.html", "app.js", "style.css", "player.html", "player.js"])

@app.route("/health")
def health():
    return jsonify({"status": "ok"}), 200

# Serve frontend static files — only whitelisted filenames accepted.
@app.route("/")
def index():
    return send_from_directory(".", "index.html")

@app.route("/<path:filename>")
def static_files(filename):
    if filename not in _ALLOWED_STATIC:
        return jsonify({"error": "Not found"}), 404
    return send_from_directory(".", filename)

# Build proxy config from environment variables if available
def get_proxy_config():
    ws_user = os.environ.get("WEBSHARE_USERNAME")
    ws_pass = os.environ.get("WEBSHARE_PASSWORD")
    if ws_user and ws_pass:
        return WebshareProxyConfig(proxy_username=ws_user, proxy_password=ws_pass)
    generic_proxy = os.environ.get("HTTP_PROXY") or os.environ.get("HTTPS_PROXY")
    if generic_proxy:
        return GenericProxyConfig(http_url=generic_proxy, https_url=generic_proxy)
    return None


def extract_video_id(url):
    """Extract YouTube video ID from various URL formats."""
    patterns = [
        r'(?:v=)([0-9A-Za-z_-]{11})',
        r'(?:youtu\.be\/)([0-9A-Za-z_-]{11})',
        r'(?:embed\/)([0-9A-Za-z_-]{11})',
        r'(?:shorts\/)([0-9A-Za-z_-]{11})',
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None


def get_video_title(video_id):
    """Fetch video title using YouTube oEmbed API (no API key needed)."""
    try:
        response = requests.get(
            f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json",
            timeout=5
        )
        if response.status_code == 200:
            return response.json().get("title", "Unknown Video")
    except Exception:
        pass
    return "Unknown Video"


def chunk_transcript(transcript, chunk_duration=40):
    """Group transcript entries into chunks of ~chunk_duration seconds each."""
    chunks = []
    current_chunk = []
    chunk_start = 0.0

    for entry in transcript:
        if not current_chunk:
            chunk_start = entry["start"]
        current_chunk.append(entry)
        chunk_end = entry["start"] + entry.get("duration", 0)
        if chunk_end - chunk_start >= chunk_duration:
            chunks.append({
                "start": chunk_start,
                "end": chunk_end,
                "text": " ".join(e["text"] for e in current_chunk).replace("\n", " ")
            })
            current_chunk = []
            chunk_start = chunk_end

    if current_chunk:
        chunk_end = current_chunk[-1]["start"] + current_chunk[-1].get("duration", 0)
        chunks.append({
            "start": chunk_start,
            "end": chunk_end,
            "text": " ".join(e["text"] for e in current_chunk).replace("\n", " ")
        })

    return chunks


@app.route("/api/load", methods=["POST"])
@limiter.limit("20 per minute")
def load_video():
    """Load video: fetch title + transcript and return chunked segments."""
    data = request.json or {}
    url = data.get("url", "")

    video_id = extract_video_id(url)
    if not video_id:
        return jsonify({"error": "Invalid YouTube URL"}), 400

    title = get_video_title(video_id)

    proxy_config = get_proxy_config()
    ytt = YouTubeTranscriptApi(proxy_config=proxy_config) if proxy_config else YouTubeTranscriptApi()
    try:
        fetched = ytt.fetch(video_id)
        raw_entries = [
            {"start": s.start, "duration": s.duration, "text": s.text}
            for s in fetched
        ]
    except (TranscriptsDisabled, NoTranscriptFound, CouldNotRetrieveTranscript) as e:
        # Fall back: list all transcripts and pick a generated one in any language
        try:
            tlist = ytt.list(video_id)
            lang_codes = [t.language_code for t in tlist]
            fetched = tlist.find_generated_transcript(lang_codes).fetch()
            raw_entries = [
                {"start": s.start, "duration": s.duration, "text": s.text}
                for s in fetched
            ]
        except Exception as inner:
            return jsonify({"error": f"No transcript available: {inner}"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    chunks = chunk_transcript(raw_entries, chunk_duration=90)

    return jsonify({
        "video_id": video_id,
        "title": title,
        "chunks": chunks
    })


if __name__ == "__main__":
    print("=== Fact Checker backend running on http://localhost:5504 ===")
    app.run(port=5504, debug=False)
