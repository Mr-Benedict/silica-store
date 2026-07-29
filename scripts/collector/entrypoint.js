// collector/entrypoint.js — server-side entry for the Collector monitor (multi-file Path B).
// Live-watches a networked Silica Collector: shows what's in its 27-slot buffer (item + count) as a clean
// list, so you can eyeball a vacuum's haul from a screen/pad/pocket without opening the block's own GUI.
//
// ALL capability access is here on the server. The page holds no authority — it only *requests* a refresh
// via mc.send, and this script answers with an authoritative snapshot (client messages are untrusted
// input). Display only — retune the filter/range from the block's own config GUI, not from here.
//
// Read this file for: discovering a peripheral on the network, reading it *safely*, and publishing it as
// state a page can render. Its sibling `ejector` adds the other half — asking the server to *act*.
//
// Capability doors: network (needs a NIC installed) + web (needs web-display). The collector adds no door
// of its own (E3-D4: item movement under network).
//
// Set up: a smart computer (SilicaOS ROM + GPU + web-display) with a NIC; place a Collector adjacent to it
// or wire the two together; run this from the Runner and stream it to a screen (or open the pad/pocket
// view). With several collectors, screwdriver-label the one you want "collector"; otherwise it uses the
// first it finds.

const CAPACITY = 27;   // the collector's fixed 27-slot buffer (E3P2-D2 — not a config knob)

// --- the server clock: WHY THIS APP DOES NOT WAIT ON THE PAGE ---
// A device.call runs on the server TICK THREAD, and this app reads the collector twice per refresh. With
// the untimed os.pullEvent("web_message") the loop advances once per *viewer poll*, so five people looking
// at the same screen cost five times the device calls — the viewer count, not the app, sets the load.
// os.pullEvent(filter, seconds) returns null on timeout, which lets the loop keep a clock of its own:
//
//   * exactly ONE device sweep per SWEEP_MS, however many people are watching;
//   * a bare poll only re-publishes the CACHED snapshot — zero device calls;
//   * (this app has no control actions at all; see `ejector` for the third branch.)
const SWEEP_MS = 1000;          // one authoritative buffer read per second
const NOCLOCK_SWEEP_EVERY = 2;  // no Date.now() at all (see HAS_CLOCK): sweep every 2nd message instead

// Date.now() is a plain ECMAScript intrinsic (no host access) and DOES work in the Silica GraalJS sandbox.
// Guarded anyway: without it the clock degrades to a message-counted debounce rather than throwing.
const HAS_CLOCK = (typeof Date !== "undefined" && typeof Date.now === "function");

let nextSweepMs = 0;      // the server clock's deadline (see markSwept)
let msgsSinceSweep = 0;   // no-clock fallback counter
let lastSnapshot = null;  // cached authoritative state, re-pushed for bare polls

// The collector to watch: prefer one labelled "collector", else the first collector on the network.
// Re-resolved every snapshot so it recovers if the block is replaced or a chunk reloads.
function findCollector() {
  const all = network.devices();
  let first = null;
  for (let i = 0; i < all.length; i++) {
    if (all[i].kind === "collector") {
      if (all[i].label === "collector") return all[i];   // an explicit label wins
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

// The state object the page renders from: the collector's live buffer + a little header context.
function snapshot() {
  const dev = findCollector();
  if (!dev) {
    return { ok: false, reason: "No collector found. Wire a Collector to this computer (and install a NIC)." };
  }
  if (!dev.online) {
    return { ok: false, reason: "Collector '" + (dev.label || dev.id) + "' is offline (chunk unloaded or removed)." };
  }

  // GUARD THE READ. `dev` was online a moment ago, which is not a promise it still is: the chunk can
  // unload between resolving it and the call landing, and a welded capability door throws here too. An
  // unguarded dev.call would kill the whole app — page and all — over something the next sweep would
  // have recovered from by itself. Report it as a card the viewer can read instead.
  let items, cfg;
  try {
    items = plainItems(dev.call("contents"));   // [{id, name, count}] over the filled slots
    cfg = dev.call("config", {});               // {range, mode, filter} — reads current without changing it
  } catch (e) {
    return { ok: false, reason: "Collector '" + (dev.label || dev.id) + "' stopped answering: " + e };
  }

  return {
    ok: true,
    name: dev.label || dev.id,
    items: items,
    usedSlots: items.length,
    capacity: CAPACITY,
    mode: cfg && cfg.mode,      // "whitelist" / "blacklist" (header context; omit if the verb ever changes)
    range: cfg && cfg.range
  };
}

function push() { lastSnapshot = snapshot(); web.setState(lastSnapshot); }

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
    // Display-only app: the page sends nothing but {action:"poll"} heartbeats, so every message is
    // answered from the cache — ZERO device calls, and the viewer count cannot move the call rate.
    if (lastSnapshot) { web.setState(lastSnapshot); }
  }

  // The clock tick: the fresh device read. `!ev` = the timeout fired; sweepDue() = a message woke us
  // early but the deadline has since passed.
  if (!ev || sweepDue()) {
    push();
    markSwept();
  }
}
