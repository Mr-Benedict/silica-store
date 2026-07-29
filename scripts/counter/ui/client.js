// counter/ui/client.js — the page side of the Counter app.
// Talks to the server through the injected window.mc bridge:
//   • mc.onState(state)  <- the server pushed new state (from web.setState on the server)
//   • mc.send(msg)       -> ask the server to do something; the server validates it and acts
//   • mc.display / mc.player  -> which display this is + who is looking
//
// The page holds NO authority: buttons only *request* changes, and the number only updates
// when authoritative state comes back down. That keeps one server-side count in charge of
// every viewer.

(function () {
  const mc = window.mc;               // provided by Silica before this script runs
  const countEl = document.getElementById("count");
  const whoEl = document.getElementById("who");

  // Render whatever the server says the count is.
  mc.onState = function (state) {
    if (state && typeof state.count === "number") {
      countEl.textContent = state.count;
    }
  };

  // Each button just fires a request up to the server.
  document.getElementById("inc").addEventListener("click", function () {
    mc.send({ action: "inc" });
  });
  document.getElementById("dec").addEventListener("click", function () {
    mc.send({ action: "dec" });
  });
  document.getElementById("reset").addEventListener("click", function () {
    mc.send({ action: "reset" });
  });

  // A small identity line, e.g. "screen · Steve". Both fields are filled in by the bridge, but a
  // surface that reports neither would otherwise render the literal string "undefined · undefined".
  whoEl.textContent = [mc.display, mc.player].filter(function (s) { return s; }).join(" · ");
})();
