// keycard/entrypoint.js — server-side entry for the Access Control room (multi-file Path B).
// Watches every Keycard Reader on the network, groups them by the Secure Door they drive, drives those
// doors (lock/unlock/auto-lock/auto-open/revoke), and keeps a LIVE ACCESS LOG fed by the card_swipe event.
//
// ALL capability access is here on the server. The page holds no authority — it only *requests* actions
// via mc.send, and this script validates every request (client messages are untrusted input: the target
// must be a reader that is actually on the network right now, every number is range-checked, every card
// id must actually be on that door's roster). Every viewer sees the same authoritative state.
//
// ONE event loop, deliberately: the loop pulls with NO FILTER — os.pullEvent(null, seconds) — and branches
// on ev.type. There is a single event queue per script, so a second loop would be a second consumer of it:
// the client's "poll" messages and the reader's card_swipe pushes have to be serviced by the same loop.
// The unfiltered form is the point. card_swipe is SERVER-produced, so the access log below stays live with
// nobody watching the page; a filtered wait on "web_message" would only ever log a swipe while somebody
// happened to be looking. The `seconds` argument is what makes the same loop keep a clock as well —
// see SWEEP_MS.
//
// Capability doors: network (needs a NIC installed) + security (default-open) + web (needs web-display).
//
// Set up: a smart computer (SilicaOS ROM + GPU + web-display) with a NIC; at least one Keycard Reader in
// its network reach (adjacent, wired, or inside a Router's radius) bound to a Secure Door. The reader
// answers only the computer it is bound to, or one owned by the same player (E3P7-D12) — a reader owned by
// somebody else shows up in the roster as REFUSED rather than vanishing.

var LOG_CAP = 60;          // access-log ring: bounded, oldest dropped (nothing unbounded rides the state)
var AUTO_LOCK_STEPS = [0, 5, 10, 30, 60, 300];   // KeycardLogic.AUTO_LOCK_STEPS
var MAX_AUTO_LOCK = 3600;  // KeycardLogic.clampAutoLock

// --- the server clock ---
// snapshot() re-reads `status` on EVERY reader, and a device.call runs on the server TICK THREAD. Paced by
// viewer polls that cost one full sweep per viewer per second; paced by this clock it costs exactly one,
// however many people have the board open. A bare poll is answered from the cached snapshot instead.
// Nothing here acts on its own — the one duty that must survive an empty world (the access log) is
// event-driven off card_swipe, which is why the loop keeps its UNFILTERED pull.
var SWEEP_MS = 1000;          // one authoritative reader sweep per second, viewer or no viewer
var NOCLOCK_SWEEP_EVERY = 2;  // no Date.now() at all (see HAS_CLOCK): sweep every 2nd message instead

var log = [];              // newest LAST; the page renders it newest-first
var seq = 0;               // monotonic id so the page can rebuild only when the log really changed
var counts = { accepted: 0, denied: 0 };
var last = null;           // last operator action, for the annunciator foot
var welded = false;        // the `security` capability door is welded shut
var lastSnapshot = null;   // cached authoritative state, re-pushed for bare polls
var nextSweepMs = 0;       // the server clock's deadline (see markSwept)
var msgsSinceSweep = 0;    // no-clock fallback counter

// Date.now() is a plain ECMAScript intrinsic (no host access) and DOES work in the Silica GraalJS sandbox
// — clockOf() below already depends on it for every log timestamp, so this app cannot run without it at
// all. Guarded regardless, purely so the clock block reads identically to the other server-clocked apps.
var HAS_CLOCK = (typeof Date !== "undefined" && typeof Date.now === "function");

// ---------------------------------------------------------------- helpers

function pad2(n) { return n < 10 ? "0" + n : "" + n; }

// Date.now() and Date work in the sandbox (the contrary comment in mek-plant is wrong).
function clockOf(ms) {
  var d = new Date(ms);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function shortId(id) {
  return id ? String(id).substring(0, 8) : null;
}

function note(ok, action, target, text) {
  last = { ok: !!ok, action: action || "", target: target || "", text: text || "", at: clockOf(Date.now()) };
}

// A thrown peripheral call tells us WHY in its message: a welded capability door, the E3P7-D12 caller gate,
// or an ordinary error ("drives no reachable door", an offline device...). We classify rather than dump.
function classify(err) {
  var msg = String(err && err.message ? err.message : err);
  if (msg.indexOf("capability 'security'") >= 0) { welded = true; return { kind: "welded", text: msg }; }
  if (msg.indexOf("answers only the computer") >= 0) { return { kind: "refused", text: msg }; }
  return { kind: "error", text: msg };
}

// ---------------------------------------------------------------- discovery

// Every keycard_reader the network can see right now. Re-resolved every snapshot, so it recovers when a
// reader is placed, mined, or its chunk reloads.
function findReaders() {
  var out = [];
  var all;
  try {
    all = network.devices();
  } catch (e) {
    return null;   // no NIC, or the `network` door is welded — reported as a banner
  }
  for (var i = 0; i < all.length; i++) {
    if (all[i].kind === "keycard_reader") { out.push(all[i]); }
  }
  return out;
}

function readerByTarget(id) {
  var all = findReaders();
  if (!all) { return null; }
  for (var i = 0; i < all.length; i++) {
    if (all[i].id === id) { return all[i]; }
  }
  return null;
}

// ---------------------------------------------------------------- snapshot

// The door a reader drives, as one string — the authoritative group key (E3P7-D10 as amended: `status`
// reports the door's `pos` + `dimension`). Two readers on ONE door produce the same string; two readers on
// two doors never do, even with identical rosters, identical settings, or no cards at all. Null when the
// reader drives no reachable door, which is not a door to group by.
function doorKeyOf(door) {
  if (!door || !door.bound || !door.pos) { return null; }
  return "d|" + door.dimension + "|" + door.pos.x + "," + door.pos.y + "," + door.pos.z;
}

// Read one reader's `status`, flattened into plain JS so web.setState serializes it cleanly.
function readStatus(dev) {
  var row = {
    id: dev.id,
    name: dev.label || dev.id,
    labelled: !!dev.label,
    online: !!dev.online,
    ok: false,
    state: "offline",
    error: null,
    armed: false,
    door: null,
    doorKey: null,
    cards: []
  };
  if (!dev.online) {
    row.error = "offline (chunk unloaded or removed)";
    return row;
  }
  var st;
  try {
    st = dev.call("status");
  } catch (e) {
    var c = classify(e);
    row.state = c.kind;
    row.error = c.text;
    return row;
  }
  row.ok = true;
  row.armed = !!st.armed;
  if (st.label) { row.name = st.label; row.labelled = true; }
  var d = st.door;
  row.door = {
    bound: !!d.bound,
    pos: d.pos ? { x: d.pos.x, y: d.pos.y, z: d.pos.z } : null,
    dimension: d.dimension || null,
    locked: !!d.locked,
    open: !!d.open,
    autoLockSeconds: d.autoLockSeconds | 0,
    autoOpenOnUnlock: !!d.autoOpenOnUnlock
  };
  row.doorKey = doorKeyOf(row.door);
  for (var i = 0; i < st.cards.length; i++) {
    var card = st.cards[i];
    // enrolledBy is the name of the player who enrolled the card, or null on a card enrolled before the
    // server recorded it. A card id is a random UUID with no player in it, so this is the only human label
    // there is — the page falls back to a short code rather than showing a raw UUID.
    row.cards.push({ id: card.id, short: shortId(card.id), tier: card.tier, by: card.enrolledBy || null });
  }
  row.state = !row.door.bound ? "unpaired" : (row.armed ? "armed" : (row.door.locked ? "locked" : "unlocked"));
  return row;
}

// Group readers by the door they drive (E3P7-D18: several readers share ONE door, and the roster lives on
// the door). The grouping is AUTHORITATIVE: `status` reports the door's own `pos` + `dimension`, so two
// readers on one door are recognised as such whatever their roster looks like — including an empty one,
// which no fingerprint could ever match. A reader that drives no reachable door has no door to group by and
// gets a group of its own.
function groupByDoor(rows) {
  var groups = [];
  var byKey = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var key = r.ok ? r.doorKey : null;
    if (!key) {
      key = "r|" + r.id;   // unbound or unreadable: it is one reader with a problem, not a door
    }
    var g = byKey[key];
    if (!g) {
      g = {
        key: key,
        bound: !!(r.ok && r.door.bound),
        locked: r.ok && r.door.bound ? r.door.locked : true,
        open: r.ok && r.door.bound ? r.door.open : false,
        autoLockSeconds: r.ok && r.door.bound ? r.door.autoLockSeconds : 0,
        autoOpenOnUnlock: r.ok && r.door.bound ? r.door.autoOpenOnUnlock : false,
        cards: r.ok ? r.cards : [],
        readers: [],
        target: null,          // the reader the page addresses this door through
        armed: false,
        live: false            // at least one reader can actually drive it
      };
      byKey[key] = g;
      groups.push(g);
    }
    g.readers.push({ id: r.id, name: r.name, labelled: r.labelled, online: r.online,
                     ok: r.ok, state: r.state, armed: r.armed, error: r.error });
    if (r.armed) { g.armed = true; }
    if (r.ok && r.door.bound && !g.target) { g.target = r.id; g.live = true; }
  }
  // Name the groups in a stable order (readers arrive in graph-walk order, stable per topology). A group
  // that drives no door is not a door at all — it is one reader with a problem, so it is named and flagged
  // after that reader rather than pretending to be "Door D".
  var doorN = 0;
  for (var n = 0; n < groups.length; n++) {
    var gr = groups[n];
    var named = null;
    for (var k = 0; k < gr.readers.length; k++) {
      if (gr.readers[k].labelled) { named = gr.readers[k].name; break; }
    }
    if (gr.bound) {
      gr.name = named ? named : ("Door " + String.fromCharCode(65 + (doorN++ % 26)));
    } else {
      gr.name = gr.readers.length ? gr.readers[0].name : "?";
      gr.issue = gr.readers.length ? gr.readers[0].state : "error";   // refused | unpaired | offline | error
    }
    if (!gr.target && gr.readers.length) { gr.target = gr.readers[0].id; }
  }
  return groups;
}

function countsOut() {
  return { accepted: counts.accepted, denied: counts.denied, total: counts.accepted + counts.denied };
}

function snapshot() {
  var devs = findReaders();
  if (devs === null) {
    return { ok: false, welded: false, log: log.slice(), logSeq: seq, counts: countsOut(),
             reason: "No network. Install a NIC in this computer (and check the `network` capability "
                   + "door isn't welded shut)." };
  }
  welded = false;                              // re-derived every snapshot from the live calls below
  var rows = [];
  for (var i = 0; i < devs.length; i++) { rows.push(readStatus(devs[i])); }

  if (rows.length === 0) {
    return { ok: false, welded: false, log: log.slice(), logSeq: seq, counts: countsOut(),
             reason: "No Keycard Reader on the network. Place one within a Router's radius of this "
                   + "computer (or wire/park it adjacent), and bind it to a Secure Door." };
  }
  if (welded) {
    return { ok: false, welded: true, log: log.slice(), logSeq: seq, counts: countsOut(),
             reason: "The `security` capability door is welded shut, so the reader verbs are refused. "
                   + "The physical card → reader → door path still works, and swipes below are "
                   + "still logged — only script control is disabled." };
  }

  var groups = groupByDoor(rows);
  var online = 0, refused = 0, unpaired = 0, locked = 0, unlocked = 0;
  for (var r = 0; r < rows.length; r++) {
    if (rows[r].online) { online++; }
    if (rows[r].state === "refused") { refused++; }
    if (rows[r].state === "unpaired") { unpaired++; }
  }
  for (var g = 0; g < groups.length; g++) {
    if (!groups[g].bound) { continue; }
    if (groups[g].locked) { locked++; } else { unlocked++; }
  }
  return {
    ok: true,
    welded: false,
    now: clockOf(Date.now()),
    doors: groups,
    fleet: { readers: rows.length, online: online, refused: refused, unpaired: unpaired,
             doors: groups.length, locked: locked, unlocked: unlocked },
    counts: countsOut(),
    log: log.slice(),
    logSeq: seq,
    last: last
  };
}

// Fresh sweep: read every reader, cache the result, publish it. The ONLY thing that calls a device.
function push() {
  try {
    lastSnapshot = snapshot();
    web.setState(lastSnapshot);
  } catch (e) { print("keycard app: setState failed - " + e); }
}

// Re-publish what the clock already built — zero device calls. Falls back to a real sweep only if the
// clock has not produced a snapshot yet (it always has by the time the loop runs).
function repush() {
  if (!lastSnapshot) { push(); return; }
  try { web.setState(lastSnapshot); } catch (e) { print("keycard app: setState failed - " + e); }
}

// ---------------------------------------------------------------- operator actions (all validated)

// Resolve the reader a client message addressed, or null (and say so). The page can only ever name a
// reader that the server itself published, and the server re-resolves it against the live network anyway.
function resolveTarget(msg, action) {
  if (!msg || typeof msg.target !== "string") {
    note(false, action, "", "no reader named");
    return null;
  }
  var dev = readerByTarget(msg.target);
  if (!dev) {
    note(false, action, msg.target, "that reader is no longer on the network");
    return null;
  }
  if (!dev.online) {
    note(false, action, msg.target, "that reader is offline (chunk unloaded)");
    return null;
  }
  return dev;
}

function doorNameOf(dev) { return dev.label || dev.id; }

function actLock(msg, lock) {
  var action = lock ? "lock" : "unlock";
  var dev = resolveTarget(msg, action);
  if (!dev) { return; }
  try {
    dev.call(action);
    note(true, action, doorNameOf(dev), lock ? "door locked" : "door unlocked");
  } catch (e) {
    note(false, action, doorNameOf(dev), classify(e).text);
  }
}

function actConfig(msg) {
  var dev = resolveTarget(msg, "config");
  if (!dev) { return; }
  var patch = {};
  if (typeof msg.autoLockSeconds === "number" && isFinite(msg.autoLockSeconds)) {
    patch.autoLockSeconds = Math.max(0, Math.min(MAX_AUTO_LOCK, Math.round(msg.autoLockSeconds)));
  }
  if (typeof msg.autoOpenOnUnlock === "boolean") {
    patch.autoOpenOnUnlock = msg.autoOpenOnUnlock;
  }
  if (patch.autoLockSeconds === undefined && patch.autoOpenOnUnlock === undefined) {
    note(false, "config", doorNameOf(dev), "nothing to set");
    return;
  }
  try {
    var out = dev.call("config", patch);
    note(true, "config", doorNameOf(dev), "auto-lock " + (out.autoLockSeconds ? out.autoLockSeconds + "s" : "never")
         + " · auto-open " + (out.autoOpenOnUnlock ? "on" : "off"));
  } catch (e) {
    note(false, "config", doorNameOf(dev), classify(e).text);
  }
}

function actRevoke(msg) {
  var dev = resolveTarget(msg, "revoke");
  if (!dev) { return; }
  if (typeof msg.card !== "string" || !msg.card) {
    note(false, "revoke", doorNameOf(dev), "no card named");
    return;
  }
  // The card must be on THIS door's roster right now — the page's list can be a snapshot old.
  var st;
  try { st = dev.call("status"); } catch (e) { note(false, "revoke", doorNameOf(dev), classify(e).text); return; }
  var found = false;
  for (var i = 0; i < st.cards.length; i++) { if (st.cards[i].id === msg.card) { found = true; break; } }
  if (!found) {
    note(false, "revoke", doorNameOf(dev), "card " + shortId(msg.card) + " is not on this door's roster");
    return;
  }
  try {
    var res = dev.call("revoke", { card: msg.card });
    // KeycardLogic.RevokeResult: revoked | not_paired | last_owner (the last owner card can't be revoked).
    var ok = res.result === "revoked";
    note(ok, "revoke", doorNameOf(dev), ok
        ? ("card " + shortId(msg.card) + " revoked · " + res.cards + " left")
        : (res.result === "last_owner"
            ? "refused: that is the last OWNER card — revoking it would orphan the door"
            : "card was not on the roster"));
  } catch (e) {
    note(false, "revoke", doorNameOf(dev), classify(e).text);
  }
}

// Lock every door we can drive, from one button. No confirm: a lockdown that needs two clicks is not one.
function actLockAll() {
  var devs = findReaders();
  if (!devs) { return; }
  var done = 0, failed = 0, seen = {};
  for (var i = 0; i < devs.length; i++) {
    if (!devs[i].online) { continue; }
    try {
      var st = devs[i].call("status");
      if (!st.door.bound) { continue; }
      // Several readers can share a door; locking it twice is harmless but the count would lie. The door's
      // own identity settles that exactly — no roster fingerprint, so an empty-rostered door is counted once.
      var key = doorKeyOf(st.door);
      if (key && seen[key]) { continue; }
      if (key) { seen[key] = true; }
      devs[i].call("lock");
      done++;
    } catch (e) {
      failed++;
    }
  }
  note(failed === 0, "lockdown", "", done + " door(s) locked" + (failed ? ", " + failed + " refused" : ""));
}

// ---------------------------------------------------------------- the access log (card_swipe)

// card_swipe fires on EVERY swipe — accepted, rejected, and at an UNBOUND reader (accepted:false) — at
// every computer that can reach the reader. It is an event, not a poll: this is the only place the log
// grows. Enrolment (armed) swipes deliberately fire nothing, so they never appear here (E3P7-D10).
function onSwipe(data) {
  var accepted = !!data.accepted;
  var entry = {
    n: ++seq,
    t: Date.now(),
    time: clockOf(Date.now()),
    reader: data.reader || "?",
    card: data.card || null,
    short: data.card ? shortId(data.card) : "blank",
    tier: data.tier || null,
    accepted: accepted
  };
  log.push(entry);
  while (log.length > LOG_CAP) { log.shift(); }   // bounded ring, oldest dropped
  if (accepted) { counts.accepted++; } else { counts.denied++; }
}

// ---------------------------------------------------------------- the server clock (see SWEEP_MS)

// Re-arm the deadline from NOW — never `nextSweepMs += SWEEP_MS`. After a lag spike or a slow reader sweep
// the next cycle is simply late; it never queues a catch-up BURST of sweeps into an already struggling
// tick thread.
function markSwept() {
  nextSweepMs = HAS_CLOCK ? (Date.now() + SWEEP_MS) : 0;
  msgsSinceSweep = 0;
}

// Is the authoritative sweep due? With a clock: the deadline has passed. Without one (see HAS_CLOCK): fall
// back to a message-counted debounce, so even then a poll stream cannot multiply the sweep rate.
function sweepDue() {
  if (HAS_CLOCK) { return Date.now() >= nextSweepMs; }
  return msgsSinceSweep >= NOCLOCK_SWEEP_EVERY;
}

// How long to park in the next pullEvent: whatever is LEFT on the deadline, so an arriving message does
// not restart the clock (the timeout is an absolute deadline armed once per call, not a per-message idle
// timer). Capped at SWEEP_MS so a backwards clock jump can't park us for hours; floored at 0, and
// pullEvent itself rounds any value up to one whole game tick, so this loop can never busy-spin.
function waitSeconds() {
  if (!HAS_CLOCK) { return SWEEP_MS / 1000; }
  var left = nextSweepMs - Date.now();
  if (left > SWEEP_MS) { left = SWEEP_MS; }
  if (left < 0) { left = 0; }
  return left / 1000;
}

// ---------------------------------------------------------------- main

web.openFile("ui/index.html");   // resolves relative to this app's own folder
push();                          // initial render (fresh sweep)
markSwept();

while (true) {
  // ONE queue, one loop: card_swipe arrives here alongside the page's poll/action messages. The null
  // filter means "any event" and the second argument makes it TIMED — null is returned on timeout, which
  // is what gives this loop its clock. A plain unfiltered wait would still log swipes in an empty world,
  // but it would leave the reader sweep paced by whoever happens to be watching.
  var ev = os.pullEvent(null, waitSeconds());

  if (ev && ev.type === "card_swipe") {
    // A swipe genuinely changed the world (a door may have just unlocked), so it takes the immediate
    // path: fresh sweep, published at once, clock re-armed behind it.
    onSwipe(ev.data);
    push();
    markSwept();
    continue;
  }

  if (ev && ev.type === "web_message") {
    msgsSinceSweep++;
    var msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { msg = null; }
    var action = (msg && typeof msg.action === "string") ? msg.action : null;

    if (action && action !== "poll") {
      // Operator action — immediate, never served from the cache: every one of these re-resolves its
      // target against the live network, acts, then rebuilds and publishes. Re-arming the clock here is
      // what stops a button press and the tick behind it from sweeping every reader twice.
      if (action === "lock") { actLock(msg, true); }
      else if (action === "unlock") { actLock(msg, false); }
      else if (action === "config") { actConfig(msg); }
      else if (action === "revoke") { actRevoke(msg); }
      else if (action === "lockAll") { actLockAll(); }
      else if (action === "clearLog") { log = []; seq++; note(true, "log", "", "access log cleared"); }
      push();
      markSwept();
      continue;
    }

    // Bare poll / heartbeat / unparsable frame — re-publish what the clock already built. ZERO device
    // calls, so the number of viewers cannot change the device-call rate at all.
    repush();
  }

  // The clock tick: the fresh reader sweep. `!ev` = the timeout fired; sweepDue() = something woke us
  // early (a poll, or any other event on the queue) but the deadline has since passed.
  if (!ev || sweepDue()) {
    push();
    markSwept();
  }
}
