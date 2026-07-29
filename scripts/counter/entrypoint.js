// counter/entrypoint.js — server-side entry for the Counter app (multi-file Path B).
// Serves the app's own UI folder (ui/index.html, which pulls in its sibling style.css and
// client.js over the silica:// scheme) and keeps an AUTHORITATIVE count on the server.
//
// The page has NO capability access: it can only *ask* to change the count via mc.send.
// This script validates every request, because client messages are untrusted input — that's
// the whole reason capability-touching apps must have an author-written entrypoint.js.
//
// Capability doors: web (needs the web-display module installed).

let count = 0;

// Push the current server state down to the page. On the page, mc.onState receives this object.
function push() {
  web.setState({ count: count });
}

web.openFile("ui/index.html");   // resolves relative to this app's own folder
push();                          // send the initial state so the page renders immediately

while (true) {
  const ev = os.pullEvent("web_message");

  // ev.data is the raw JSON string the UI sent — parse and validate it. Never trust the client.
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch (e) {
    continue;                    // ignore anything that isn't valid JSON
  }

  switch (msg && msg.action) {
    case "inc":   count += 1; break;
    case "dec":   count -= 1; break;
    case "reset": count = 0;  break;
    default:      continue;        // unknown action -> ignore, don't bother re-pushing
  }

  push();                          // reflect the new count to every viewer
}
