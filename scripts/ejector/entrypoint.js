// ejector/entrypoint.js — server-side entry for the Ejector monitor (multi-file Path B).
// Live-watches a networked Silica Ejector: shows what's queued in its 27-slot buffer, the output-face
// filter (whitelist/blacklist) + facing, and the optional liquid tank — plus two showcase controls (force
// an eject cycle now, flip the filter mode) that message this script, which is the only thing that ever
// touches the verbs.
//
// ALL capability access is here on the server. The page holds no authority — it only *requests* actions
// via mc.send, and this script re-resolves the device and validates the request before acting (client
// messages are untrusted input). Retune the filter's whitelist/blacklist *entries* from the block's own
// config GUI — this app only flips the mode, as a showcase control.
//
// Read this file for: reading a peripheral safely, letting a page ASK for an action the server validates
// and performs, and REPORTING THE OUTCOME BACK ONTO THE SHEET rather than into a terminal the player
// isn't looking at. Its sibling `collector` is the read-only half of the same shape. This is also the one
// app in the suite that shows `tank()`.
//
// Capability doors: network (needs a NIC installed) + ejector (default-open) + web (needs web-display).
//
// Set up: a smart computer (SilicaOS ROM + GPU + web-display) with a NIC; place an Ejector adjacent to it
// or wire the two together; run this from the Runner and stream it to a screen (or open the pad/pocket
// view). With several ejectors, screwdriver-label the one you want "ejector"; otherwise it uses the
// first it finds.

const CAPACITY = 27;   // the ejector's fixed 27-slot buffer (E3P3-D2 — not a config knob)

// --- the server clock: WHY THIS APP DOES NOT WAIT ON THE PAGE ---
// A device.call runs on the server TICK THREAD, and this app reads the ejector three times per refresh.
// With the untimed os.pullEvent("web_message") the loop advances once per *viewer poll*, so five people
// looking at the same screen cost five times the device calls — the viewer count, not the app, sets the
// load. os.pullEvent(filter, seconds) returns null on timeout, which lets the loop keep a clock of its own:
//
//   * exactly ONE device sweep per SWEEP_MS, however many people are watching;
//   * a bare poll only re-publishes the CACHED snapshot — zero device calls;
//   * a control action is still handled IMMEDIATELY against freshly-read state, then re-arms the clock,
//     so a button press never waits for the next tick and never sweeps the device twice.
const SWEEP_MS = 1000;          // one authoritative device sweep per second
const NOCLOCK_SWEEP_EVERY = 2;  // no Date.now() at all (see HAS_CLOCK): sweep every 2nd message instead

// Date.now() is a plain ECMAScript intrinsic (no host access) and DOES work in the Silica GraalJS sandbox.
// Guarded anyway: without it the clock degrades to a message-counted debounce rather than throwing.
const HAS_CLOCK = (typeof Date !== "undefined" && typeof Date.now === "function");

let nextSweepMs = 0;      // the server clock's deadline (see markSwept)
let msgsSinceSweep = 0;   // no-clock fallback counter
let lastSnapshot = null;  // cached authoritative state, re-pushed for bare polls

// --- the on-sheet status line ---------------------------------------------------------------
// { action, target, ok, text } — the same shape the `detector` app publishes, rendered by the same
// st-lamp/st-txt card, so the two apps read as one product. WHY IT EXISTS: the terminal log is a
// different screen from the panel the player just tapped. A refused eject or a device that went offline
// mid-action used to be a print() nobody was looking at, so "Force eject" simply appeared to do nothing.
// Every control path below ends in record(); print() is kept as well — the log is still worth having.
let lastAction = null;

function record(action, target, ok, text) {
  lastAction = { action: action || "?", target: target || "", ok: !!ok, text: text };
}

// eject() answers {ejected, reason, item, action, contents}. `reason` is one of the block's named
// blockers (silica.runtime.EjectorLogic) — map it to a sentence a player can act on, and fall back to
// the raw reason so a future blocker still says something true rather than nothing.
const REASONS = {
  "unloaded": "the target chunk is unloaded — nothing to eject into.",
  "buffer empty": "the buffer is empty.",
  "filtered out": "the filter excludes everything in the buffer.",
  "face blocked": "the output face is blocked by a solid block.",
  "destination full": "the container on the output face is full.",
  "placement refused": "the block could not be placed on the output face.",
  "toss refused": "the item could not be thrown out of the output face."
};
const ACTIONS = { insert: "inserted", place: "placed", toss: "tossed" };

// The ejector to watch: prefer one labelled "ejector", else the first ejector on the network.
// Re-resolved every snapshot so it recovers if the block is replaced or a chunk reloads.
function findEjector() {
  const all = network.devices();
  let first = null;
  for (let i = 0; i < all.length; i++) {
    if (all[i].kind === "ejector") {
      if (all[i].label === "ejector") return all[i];   // an explicit label wins
      if (!first) first = all[i];
    }
  }
  return first;
}

// "minecraft:cobblestone" -> "Cobblestone": strip the namespace, spell out underscores, title-case.
function prettify(id) {
  const s = String(id || "").replace(/^[^:]*:/, "").replace(/_/g, " ").trim();
  if (!s) return "?";
  return s.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

// Copy the faculty's contents() records into plain JS values so web.setState serializes cleanly.
// contents() returns [{item, count}] over the non-empty buffer slots; we add a readable name here.
function plainItems(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    out.push({ id: r.item, name: prettify(r.item), count: r.count });
  }
  return out;
}

// The state object the page renders from: the ejector's live buffer + filter + tank + header context.
// Every snapshot carries `last` so the status card survives an offline card taking over the sheet — the
// reason the last button press failed is exactly what you want to still be able to read.
function snapshot() {
  const dev = findEjector();
  if (!dev) {
    return { ok: false, last: lastAction,
      reason: "No ejector found. Wire an Ejector to this computer (and install a NIC)." };
  }
  if (!dev.online) {
    return { ok: false, last: lastAction,
      reason: "Ejector '" + (dev.label || dev.id) + "' is offline (chunk unloaded or removed)." };
  }

  // GUARD THE READ. `dev` was online a moment ago, which is not a promise it still is: the chunk can
  // unload between resolving it and any of the three calls landing, and a welded capability door throws
  // here too. An unguarded dev.call would kill the whole app — page and all — over something the next
  // sweep would have recovered from by itself. Report it as a card the viewer can read instead.
  let items, cfg, tank;
  try {
    items = plainItems(dev.call("contents"));   // [{id, name, count}] over the filled slots
    cfg = dev.call("config", {});               // {mode, filter, facing} — reads current without changing it
    // tank() always answers (fill from an external pump is NOT chip-gated — only source-block placement is,
    // E3P3-D8), so this app shows the tank regardless of whether a Liquid Chip is installed; see the app's
    // README for why "installed" can't be detected over this verb.
    tank = dev.call("tank");                    // {fluid, amount, capacity}
  } catch (e) {
    return { ok: false, last: lastAction,
      reason: "Ejector '" + (dev.label || dev.id) + "' stopped answering: " + e };
  }

  return {
    ok: true,
    last: lastAction,
    name: dev.label || dev.id,
    items: items,
    usedSlots: items.length,
    capacity: CAPACITY,
    mode: cfg && cfg.mode,          // "whitelist" / "blacklist"
    filter: (cfg && cfg.filter) || [],
    facing: cfg && cfg.facing,      // the output face, e.g. "north"
    tank: {
      fluid: tank && tank.fluid && tank.fluid !== "minecraft:empty" ? prettify(tank.fluid) : null,
      amount: tank ? tank.amount : 0,
      capacity: tank ? tank.capacity : 0
    }
  };
}

function push() { lastSnapshot = snapshot(); web.setState(lastSnapshot); }

// ---- the two showcase controls ---------------------------------------------------------------
// The page only ever *asks*. Both actions re-resolve the device live and re-validate the message before
// touching a verb, and both stay try/caught: a refused verb is a status line, never the end of the app.
// Every outcome — refused, offline, thrown, or fine — lands in record() so it shows up on the sheet the
// player is actually looking at, and in print() so the terminal log keeps its history.
function handle(msg) {
  const act = msg.action;
  const dev = findEjector();
  if (!dev || !dev.online) {
    // Covers both "never found one" and "it went offline between the sweep and this press".
    record(act, dev ? (dev.label || dev.id) : "", false, "No online ejector to act on.");
    print("ejector app: no online ejector to act on.");
    return;
  }
  const name = dev.label || dev.id;

  if (act === "eject") {
    // "Force eject": bypasses the interval timer + the redstone-disable gate (the world logic — a blocked
    // face, a full cap — still applies), same as the block's own faculty verb. The verb now says WHICH.
    try {
      const r = dev.call("eject");
      if (r && r.ejected) {
        const how = ACTIONS[r.action] || String(r.action);
        record(act, name, true, how.charAt(0).toUpperCase() + how.slice(1) + " " + prettify(r.item) + ".");
        print("ejector app: ejected " + r.item + " (" + r.action + ")");
      } else {
        const why = (r && REASONS[r.reason]) || ("refused: " + (r ? r.reason : "no answer"));
        record(act, name, false, "Nothing ejected — " + why);
        print("ejector app: eject refused - " + (r ? r.reason : "no answer"));
      }
    } catch (e) {
      record(act, name, false, "Eject failed: " + e);
      print("ejector app: eject failed - " + e);
    }
  } else if (act === "config" && (msg.mode === "whitelist" || msg.mode === "blacklist")) {
    // The filter-mode flip. The whitelist/blacklist *entries* stay whatever the block's own config GUI
    // set — this app only toggles which list they mean.
    try {
      const cfg = dev.call("config", { mode: msg.mode });
      record(act, name, true, "Filter mode is now " + ((cfg && cfg.mode) || msg.mode) + ".");
      print("ejector app: mode -> " + ((cfg && cfg.mode) || msg.mode));
    } catch (e) {
      record(act, name, false, "Mode change failed: " + e);
      print("ejector app: config failed - " + e);
    }
  }
  // Any unrecognised action is a no-op; the caller still publishes fresh state.
}

// ---- the server clock ------------------------------------------------------------------------

// Re-arm the deadline from NOW — never `nextSweepMs += SWEEP_MS`. After a lag spike the next cycle is
// simply late; it never queues a catch-up burst of sweeps into an already struggling tick thread.
function markSwept() {
  nextSweepMs = HAS_CLOCK ? (Date.now() + SWEEP_MS) : 0;
  msgsSinceSweep = 0;
}

// Is the authoritative sweep due? With a clock: the deadline has passed. Without one: fall back to a
// message-counted debounce, so even then a poll stream cannot multiply the sweep rate without bound.
function sweepDue() {
  if (HAS_CLOCK) { return Date.now() >= nextSweepMs; }
  return msgsSinceSweep >= NOCLOCK_SWEEP_EVERY;
}

// How long to park in the next pullEvent: whatever is LEFT on the deadline, so an arriving message does
// not restart the clock. Capped at SWEEP_MS so a backwards clock jump can't park us for hours; floored at
// 0, and pullEvent itself rounds any value up to one whole game tick, so this loop can never busy-spin.
function waitSeconds() {
  if (!HAS_CLOCK) { return SWEEP_MS / 1000; }
  let left = nextSweepMs - Date.now();
  if (left > SWEEP_MS) { left = SWEEP_MS; }
  if (left < 0) { left = 0; }
  return left / 1000;
}

// ---- run -------------------------------------------------------------------------------------

web.openFile("ui/index.html");   // resolves relative to this app's own folder
push();                          // initial render
markSwept();

while (true) {
  // null on timeout. NOT a plain pullEvent: with nobody watching, no web_message is ever produced.
  const ev = os.pullEvent("web_message", waitSeconds());

  if (ev) {
    msgsSinceSweep++;
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { msg = null; }
    const action = msg && msg.action;

    if (action && action !== "poll") {
      // Control action — immediate, never debounced and never served from the cache: handle() re-resolves
      // and re-validates live, then we re-read and publish at once. Re-arming the clock here is what stops
      // a button press and the tick behind it from sweeping the device twice.
      handle(msg);
      push();
      markSwept();
      continue;
    }

    // Bare poll / heartbeat / unparsable frame — re-publish what the clock already built. ZERO device
    // calls, so the number of viewers cannot change the device-call rate at all.
    if (lastSnapshot) { web.setState(lastSnapshot); }
  }

  // The clock tick: the fresh device sweep. `!ev` = the timeout fired; sweepDue() = a message woke us
  // early but the deadline has since passed.
  if (!ev || sweepDue()) {
    push();
    markSwept();
  }
}
