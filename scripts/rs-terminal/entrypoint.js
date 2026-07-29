// rs-terminal/entrypoint.js — server-side entry for the Refined Storage Terminal (multi-file Path B).
// A storage-terminal-style dashboard for an RS network reached over the Silica network: browse/search the
// whole network's items, request autocrafts, and watch/cancel live crafting tasks.
//
// ALL capability access is here on the server. The page holds NO authority — it only *requests* things via
// mc.send (poll / selectNetwork / search / craft / cancelTask / cancelAll), and this script re-validates
// every request (client messages are untrusted input): a craft/cancel only fires against the currently
// selected network, re-resolved live each time. The refresh runs on the SERVER's clock (see "Sweep
// discipline" below), so every viewer sees the same numbers and the cost does not scale with how many
// people are looking. Any RS call that throws is caught and surfaced back to the page as a status line.
//
// Capability doors: network (needs a NIC) + web (needs web-display). RS is reached as an ordinary network
// device via a Silica Port mounted on the network's Controller; no extra door (E4-D26 — the cable is the
// gate).
//
// Set up: a smart computer (SilicaOS ROM + GPU + web-display) with a NIC; mount a Silica Port on (or
// beside) your RS Controller and wire it to the computer (adjacent, or via a Switch/Router/Receiver). Run
// this from the Runner and stream it to a named screen, or open the pad/pocket view.
//
// Sweep discipline (the E4-P1 freeze lesson — a peripheral device.call runs on the server tick thread).
// A snapshot() costs FOUR device calls against the selected network (getStatus / listItems / getPatterns /
// getTasks), and listItems is the heavy one on a big network. This script used to rebuild one on every
// message it received, so N viewers each pinging once a second cost 4N calls per second on the tick
// thread. It now keeps its own clock instead, exactly like `detector`:
//
//   * exactly ONE authoritative sweep per SWEEP_MS, whether one viewer is watching or twenty;
//   * a bare {action:"poll"} heartbeat is answered from the CACHED snapshot — zero device calls, so
//     viewer count cannot move the device-call rate at all;
//   * an operator action (switch network / search / craft / cancel) sweeps IMMEDIATELY and re-arms the
//     clock, so intent never waits for the next tick and never double-sweeps behind it.
//
// Search is an operator action for exactly that reason — a new filter must re-read listItems at once, not
// show stale rows until the tick. The page still debounces keystrokes (~350ms) so a burst of typing (or a
// burst of keypad taps on a wall screen) collapses into one sweep.

// --- kind (frozen contract, docs/phases/epic4-phase-4.md "Adapter + verb table") ---
var K_RS = "refinedstorage_network";

// --- the server clock (see markSwept / sweepDue / waitSeconds at the foot of this file) ---
var SWEEP_MS = 1000;          // one authoritative device sweep per second, viewer or no viewer
var NOCLOCK_SWEEP_EVERY = 2;  // no Date.now() at all (see HAS_CLOCK): sweep every 2nd message instead
var HAS_CLOCK = (typeof Date !== "undefined" && typeof Date.now === "function");

// The page-side item list is capped independently of whatever server-side cap the adapter itself applies
// (RS-D27 risk note: listItems is size-capped there too) — this just keeps the DOM light.
var ITEM_DISPLAY_CAP = 300;

// --- coerce host-proxy values into plain JSON-able primitives (web.setState needs plain objects) ---
function num(v) { return (typeof v === "number" && isFinite(v)) ? v : null; }
function str(v, dflt) { return (typeof v === "string" && v.length) ? v : dflt; }
function pos3(p) { return p ? { x: num(p.x), y: num(p.y), z: num(p.z) } : null; }

// "minecraft:iron_ingot" -> "Iron Ingot" (the Collector/Detector seed-app convention — RS's verb table
// returns bare registry ids, no friendly name, so we prettify it ourselves for display).
function prettify(id) {
  var s = String(id || "").replace(/^[^:]*:/, "").replace(/_/g, " ").trim();
  if (!s) { return "?"; }
  return s.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function safeCall(dev, verb, args, tag) {
  try { return dev.call(verb, args || {}); }
  catch (e) { print("rs-terminal: " + verb + " failed for " + (dev.label || dev.id) + " (" + tag + ") - " + e); return null; }
}

function resultText(result) {
  if (result === "created") { return "Craft started"; }
  if (result === "already_running") { return "Already crafting"; }
  if (result === "missing_resources") { return "Missing resources"; }
  return String(result);
}

// --- session state (server-authoritative; the page only ever reflects this back) ---
var selectedId = null;   // the RS network device currently shown in the terminal
var filter = "";         // current search text, forwarded to listItems(filter)
var lastAction = null;   // { action, ok, text } — surfaced to the page as a sticky status line

var lastSnapshot = null; // cached authoritative state, re-pushed for bare polls (zero device calls)
var nextSweepMs = 0;     // the server clock's deadline (see markSwept)
var msgsSinceSweep = 0;  // no-clock fallback counter

function findNetworks() {
  var all = network.devices();
  var out = [];
  for (var i = 0; i < all.length; i++) { if (all[i].kind === K_RS) { out.push(all[i]); } }
  return out;
}

function resolveSelected(nets) {
  if (!selectedId) { return null; }
  for (var i = 0; i < nets.length; i++) {
    if (nets[i].id === selectedId && nets[i].online) { return nets[i]; }
  }
  return null;
}

// --- the authoritative state the page renders from ---
function snapshot() {
  var nets = findNetworks();
  if (nets.length === 0) {
    selectedId = null;
    return {
      ok: false,
      reason: "No Refined Storage network found. Mount a Silica Port on your RS Controller and install a NIC.",
      last: lastAction
    };
  }

  // Auto-(re)select if nothing is chosen yet, or the previous selection dropped off the network.
  var stillValid = false;
  for (var i = 0; i < nets.length; i++) { if (nets[i].id === selectedId) { stillValid = true; break; } }
  if (!stillValid) { selectedId = nets[0].id; }

  var networksOut = [];
  for (var j = 0; j < nets.length; j++) {
    var d = nets[j];
    networksOut.push({ id: d.id, label: str(d.label, d.id), online: !!d.online });
  }

  var sel = resolveSelected(nets);
  if (!sel) {
    // Selected controller exists in the roster but is offline (chunk unloaded / block removed).
    return {
      ok: true, networks: networksOut, selected: selectedId,
      status: null, items: [], itemsTruncated: false, patterns: [], tasks: [], filter: filter,
      reason: "Selected network is offline (chunk unloaded or removed).", last: lastAction
    };
  }

  var status = safeCall(sel, "getStatus", {}, "status");
  // getStatus already carries energy:{stored,capacity} (frozen table) — reuse it rather than spend a
  // second game-thread device.call on getEnergy each poll (the E4-P1 freeze lesson: fewer network
  // re-resolves per poll; every RS verb re-walks the network).
  var energy = (status && status.energy) ? status.energy : null;
  var itemsRaw = safeCall(sel, "listItems", filter ? { filter: filter } : {}, "listItems") || [];
  var patternsRaw = safeCall(sel, "getPatterns", {}, "getPatterns") || [];
  var tasksRaw = safeCall(sel, "getTasks", {}, "getTasks") || [];

  var items = [];
  for (var m = 0; m < itemsRaw.length; m++) {
    var ri = itemsRaw[m];
    items.push({ id: ri.id, name: prettify(ri.id), count: num(ri.count) || 0 });
  }
  items.sort(function (a, b) { return b.count - a.count; });
  var itemsTruncated = items.length > ITEM_DISPLAY_CAP;
  if (itemsTruncated) { items = items.slice(0, ITEM_DISPLAY_CAP); }

  var tasks = [];
  for (var t = 0; t < tasksRaw.length; t++) {
    var rt = tasksRaw[t];
    tasks.push({
      id: rt.id, resource: rt.resource, name: prettify(rt.resource),
      quantity: num(rt.quantity), percent: num(rt.percent), state: str(rt.state, "?")
    });
  }
  var craftingIds = {};
  for (var c = 0; c < tasks.length; c++) { craftingIds[tasks[c].resource] = true; }

  var patterns = [];
  for (var p = 0; p < patternsRaw.length; p++) {
    var pid = patternsRaw[p];
    patterns.push({ id: pid, name: prettify(pid), crafting: !!craftingIds[pid] });
  }
  patterns.sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });

  return {
    ok: true,
    networks: networksOut,
    selected: selectedId,
    status: status ? {
      connected: !!status.connected,
      itemTypes: num(status.itemTypes), fluidTypes: num(status.fluidTypes),
      craftingTasks: num(status.craftingTasks), patterns: num(status.patterns),
      pos: pos3(status.pos), dimension: str(status.dimension, null)
    } : null,
    energy: energy ? { stored: num(energy.stored), capacity: num(energy.capacity) } : null,
    items: items, itemsTruncated: itemsTruncated,
    patterns: patterns,
    tasks: tasks,
    filter: filter,
    last: lastAction
  };
}

// The ONLY thing that spends device calls. Everything else replays lastSnapshot.
function push() { lastSnapshot = snapshot(); web.setState(lastSnapshot); }

// --- control (server holds all authority; every request is re-validated against the live network) ---
function handle(msg) {
  if (!msg || !msg.action) { return; }
  var a = msg.action;

  if (a === "selectNetwork") {
    // Untrusted input: only ever point at an id that is actually on the RS roster right now. An OFFLINE
    // controller is still a legal choice — the page shows it as a dead chip, and picking it is how you
    // find out which of your networks has gone dark — but a made-up id is refused rather than left for
    // the next sweep to quietly heal.
    var wanted = str(msg.id, null);
    if (!wanted) { return; }
    var roster = findNetworks();
    for (var r = 0; r < roster.length; r++) {
      if (roster[r].id === wanted) { selectedId = wanted; return; }
    }
    lastAction = { action: a, ok: false, text: "That network is no longer on the Silica network." };
    return;
  }
  if (a === "search") {
    filter = (typeof msg.filter === "string") ? msg.filter.slice(0, 100) : "";
    return;
  }

  // Everything below acts on the CURRENTLY SELECTED network — re-resolved live, never cached.
  var nets = findNetworks();
  var dev = resolveSelected(nets);

  if (a === "craft") {
    if (!dev) { lastAction = { action: a, ok: false, text: "No network selected." }; return; }
    var id = str(msg.id, null);
    if (!id) { lastAction = { action: a, ok: false, text: "No item chosen." }; return; }
    var count = (typeof msg.count === "number" && msg.count > 0) ? Math.floor(msg.count) : 1;
    try {
      var ack = dev.call("craftItem", { id: id, count: count });
      var result = str(ack && ack.result, "?");
      lastAction = {
        action: a, ok: (result === "created" || result === "already_running"),
        text: prettify(id) + " ×" + count + " — " + resultText(result)
      };
      print("rs-terminal: craftItem " + id + " x" + count + " -> " + result);
    } catch (e) {
      lastAction = { action: a, ok: false, text: prettify(id) + ": craft failed — " + e };
      print("rs-terminal: craftItem failed for " + id + " - " + e);
    }
  } else if (a === "cancelTask") {
    if (!dev) { lastAction = { action: a, ok: false, text: "No network selected." }; return; }
    var taskId = str(msg.taskId, null);
    if (!taskId) { lastAction = { action: a, ok: false, text: "No task chosen." }; return; }
    try {
      dev.call("cancelTask", { taskId: taskId });
      lastAction = { action: a, ok: true, text: "Task cancelled." };
      print("rs-terminal: cancelTask " + taskId);
    } catch (e) {
      lastAction = { action: a, ok: false, text: "Cancel failed — " + e };
      print("rs-terminal: cancelTask failed for " + taskId + " - " + e);
    }
  } else if (a === "cancelAll") {
    if (!dev) { lastAction = { action: a, ok: false, text: "No network selected." }; return; }
    try {
      dev.call("cancelAll", {});
      lastAction = { action: a, ok: true, text: "All tasks cancelled." };
      print("rs-terminal: cancelAll");
    } catch (e) {
      lastAction = { action: a, ok: false, text: "Cancel all failed — " + e };
      print("rs-terminal: cancelAll failed - " + e);
    }
  }
  // "poll" and anything unrecognised: no-op here; the run loop still rebuilds + pushes fresh state.
}

// --- the server clock (see "Sweep discipline" in the file header) ---

// Re-arm the deadline from NOW — never `nextSweepMs += SWEEP_MS`. After a lag spike or a slow listItems
// the next cycle is simply late; it never queues a catch-up BURST of sweeps into an already struggling
// tick thread, which is the failure mode this whole discipline exists to avoid.
function markSwept() {
  nextSweepMs = HAS_CLOCK ? (Date.now() + SWEEP_MS) : 0;
  msgsSinceSweep = 0;
}

// Is the authoritative sweep due? With a clock: the deadline has passed. Without one (defensive only —
// Date.now is a plain ECMAScript intrinsic and DOES work in this sandbox): fall back to a message-counted
// debounce, so even then a poll stream cannot multiply the sweep rate without bound.
function sweepDue() {
  if (HAS_CLOCK) { return Date.now() >= nextSweepMs; }
  return msgsSinceSweep >= NOCLOCK_SWEEP_EVERY;
}

// How long to park in the next pullEvent: whatever is LEFT on the deadline, so an arriving message does
// not restart the clock (that is what would let a steady poll stream starve the sweep forever — the
// timeout is an absolute deadline armed once per call, not a per-message idle timer). Capped at SWEEP_MS
// so a backwards clock jump can't park us for hours; floored at 0, and pullEvent itself rounds any value
// up to one whole game tick, so this loop can never busy-spin.
function waitSeconds() {
  if (!HAS_CLOCK) { return SWEEP_MS / 1000; }
  var left = nextSweepMs - Date.now();
  if (left > SWEEP_MS) { left = SWEEP_MS; }
  if (left < 0) { left = 0; }
  return left / 1000;
}

// --- run ---
web.openFile("ui/index.html");   // resolves relative to this app's own folder
push();                          // initial render
markSwept();

while (true) {
  // null on timeout. NOT a plain pullEvent: this terminal is a monitor, so nothing would break if it
  // only refreshed while somebody watched — but the timed form is what lets a bare poll be answered
  // from cache instead of re-reading the network once per viewer per second.
  var ev = os.pullEvent("web_message", waitSeconds());

  if (ev) {
    msgsSinceSweep++;
    var msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { msg = null; }
    var action = msg && msg.action;

    if (action && action !== "poll") {
      // Operator action — immediate, never served from the cache: handle() re-resolves the target live,
      // then we rebuild + publish at once. Re-arming the clock here is what stops a button press and the
      // tick behind it from sweeping the network twice. A "search" lands here too, which is the point:
      // a new filter re-reads listItems now rather than showing the old rows until the next tick.
      handle(msg);
      push();
      markSwept();
      continue;
    }

    // Bare poll / heartbeat / unparsable frame — re-publish what the clock already built. ZERO device
    // calls, so the number of viewers cannot change the device-call rate at all.
    if (lastSnapshot) { web.setState(lastSnapshot); }
  }

  // The clock tick: one authoritative sweep per SWEEP_MS. `!ev` = the timeout fired; sweepDue() = a
  // message woke us early but the deadline has since passed.
  if (!ev || sweepDue()) {
    push();
    markSwept();
  }
}
