const API_BASE = "https://fact-checker-chrome-ext.onrender.com";

// Ping /health as soon as the service worker activates — well before the user
// opens the side panel — so Render's free-tier server is warm and ready.
function wakeServer() {
  fetch(API_BASE + "/health", { cache: "no-store" }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(wakeServer);
chrome.runtime.onStartup.addListener(wakeServer);
wakeServer(); // also runs when the service worker is first loaded mid-session

// Open the side panel when the extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});
