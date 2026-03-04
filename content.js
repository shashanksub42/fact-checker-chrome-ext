// Injected into YouTube pages.
// Relays the video's current time to the side panel and handles seek commands.

let lastSentTime = -1;

// Poll the <video> element and forward time updates to the side panel
setInterval(() => {
  const video = document.querySelector("video");
  if (!video) return;
  const t = video.currentTime;
  // Only send when time changed meaningfully (reduces noise while paused)
  if (Math.abs(t - lastSentTime) > 0.3 || !video.paused) {
    lastSentTime = t;
    chrome.runtime.sendMessage({
      type:   "timeUpdate",
      time:   t,
      paused: video.paused
    }).catch(() => {}); // side panel may not be open yet – ignore
  }
}, 500);

// Watch for YouTube's SPA navigation (new video loaded without full page reload)
let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    chrome.runtime.sendMessage({
      type: "urlChange",
      url:  location.href
    }).catch(() => {});
  }
}).observe(document, { subtree: true, childList: true });

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
