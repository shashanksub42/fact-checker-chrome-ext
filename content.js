// Injected into YouTube pages.
// Relays the video's current time to the side panel and handles seek commands.

let lastSentTime = -1;

// Sends a message safely, swallowing both synchronous throws (invalidated
// extension context after a reload) and promise rejections (no listener).
function safeSend(msg) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch (_) {}
}

// Poll the <video> element and forward time updates to the side panel
const _interval = setInterval(() => {
  // Stop polling if the extension was reloaded/invalidated
  if (!chrome.runtime?.id) {
    clearInterval(_interval);
    _observer.disconnect();
    return;
  }
  const video = document.querySelector("video");
  if (!video) return;
  const t = video.currentTime;
  // Only send when time changed meaningfully (reduces noise while paused)
  if (Math.abs(t - lastSentTime) > 0.3 || !video.paused) {
    lastSentTime = t;
    safeSend({ type: "timeUpdate", time: t, paused: video.paused });
  }
}, 500);

// Watch for YouTube's SPA navigation (new video loaded without full page reload)
let lastUrl = location.href;
const _observer = new MutationObserver(() => {
  if (!chrome.runtime?.id) {
    _observer.disconnect();
    clearInterval(_interval);
    return;
  }
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    safeSend({ type: "urlChange", url: location.href });
  }
});
_observer.observe(document, { subtree: true, childList: true });

// Handle seek commands sent from the side panel
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "seekTo") {
    const video = document.querySelector("video");
    if (video) {
      video.currentTime = msg.time;
      video.play().catch(() => {});
    }
  }
});
