var player;
var timerId;
var YT_PLAYING = 1;

window.onYouTubeIframeAPIReady = function () {
  window.parent.postMessage({ type: "ytApiReady" }, "*");
};

window.addEventListener("message", function (e) {
  var msg = e.data;
  if (!msg || !msg.type) return;

  if (msg.type === "createPlayer") {
    // Tear down existing player and timer
    clearInterval(timerId);
    if (player) { try { player.destroy(); } catch (x) {} player = null; }

    // Re-create the mount element (destroy() removes it from the DOM)
    var wrap = document.getElementById("yt-player");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "yt-player";
      document.body.appendChild(wrap);
    }

    player = new YT.Player("yt-player", {
      height: "100%",
      width: "100%",
      videoId: msg.videoId,
      playerVars: { rel: 0, modestbranding: 1, autoplay: 1 },
      events: {
        onReady: function (e) {
          e.target.playVideo();
          window.parent.postMessage({ type: "playerReady" }, "*");

          // Push time + state updates to the parent every 500 ms
          timerId = setInterval(function () {
            if (player && player.getCurrentTime) {
              window.parent.postMessage({
                type:  "timeUpdate",
                time:  player.getCurrentTime(),
                state: player.getPlayerState()
              }, "*");
            }
          }, 500);
        },
        onStateChange: function (e) {
          window.parent.postMessage({ type: "stateChange", state: e.data }, "*");
        }
      }
    });
  }

  if (msg.type === "seekTo" && player) { player.seekTo(msg.time, true); player.playVideo(); }
  if (msg.type === "play"   && player) { player.playVideo(); }
  if (msg.type === "pause"  && player) { player.pauseVideo(); }
});
