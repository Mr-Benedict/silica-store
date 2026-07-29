// detector/entrypoint.js — server-side entry for PERIMETER, the detector watch board (multi-file Path B).
//
// A perimeter watch board for Silica Entity Detectors, built as the sibling sheet of `builder-control` /
// `reactor-control`. It watches every `detector` reachable on this computer's Silica network and publishes
// one authoritative snapshot per sweep:
//
//   * per-unit contact telemetry — the filtered scan sorted nearest-first, counts by class (hostile /
//     friendly / player), nearest hostile and nearest anything, the unit's live filter + range, and the
//     redstone level the block is emitting (DERIVED, see deriveRedstone)
//   * a per-unit ARRIVAL / DEPARTURE diff, so the board says "+2 Zombie, -1 Creeper" instead of only
//     redrawing a list — a multiset diff by entity name, which is all the device's records support
//   * derived alarms + a rolling event log, including the cross-check that matters: an alert armed against
//     something the watched detector's own filter cannot see, so it could never fire
//   * a server-authoritative ALERT — a redstone face driven from the trip condition plus an optional
//     network broadcast, both evaluated on the SERVER's own clock, so the trap works with nobody watching
//
// Beyond the alert it decides nothing for you: it never retunes a detector on its own, and every control
// is operator-driven.
//
// ALL capability access is here on the server. The page holds NO authority — it only *requests* actions
// via mc.send, and this script re-validates every request (client messages are untrusted input): a config
// change only fires against a real, ONLINE device of kind `detector`, re-resolved live each time. Any
// device call that throws is caught and surfaced back as a status line.
//
// Capability doors: network (needs a NIC) + detector + web (needs web-display) — and redstone ONLY once
// you arm the alert, because the script never touches a face before then.
//
// Set up: a smart computer (SilicaOS ROM + GPU + web-display) with a NIC; wire every Detector to it
// (adjacent, or through a Switch / Router -> Receiver). Screwdriver-label each Detector and that label
// becomes its name on the board. Run this from the Runner and stream it to a named monitor, or open the
// pad / pocket view.

// ===========================================================================================
//  TUNABLE CONFIG — edit this block to match YOUR base
// ===========================================================================================

// DETECTORS: optionally pin specific Detectors by name — the screwdriver label you gave the block, or its
// auto device id. Leave EMPTY to auto-discover every `detector` on the network. When you DO list names,
// each one ALWAYS gets a card — as an OFFLINE placeholder when it isn't currently reachable — so a
// chunk-unloaded gate camera never silently vanishes off the board (and still raises an alarm).
//   e.g.:  var DETECTORS = ["north_gate", "mine_shaft"];
var DETECTORS = [];

// --- the server clock: WHY THIS APP DOES NOT WAIT ON THE PAGE ---
// The run loop advances on the SERVER's own clock, not on viewer polls. A `web_message` exists only while
// some player's browser is running this page, so a plain os.pullEvent("web_message") parks FOREVER in an
// empty world — and the alert below, which is the whole point of the rewrite, would then only ever fire
// while somebody happened to be looking at it. That is not hypothetical: a fission reactor melted down in
// this project because an interlock's STATE was server-authoritative while its CADENCE was borrowed from
// the client. os.pullEvent(filter, seconds) returns null on timeout, which lets this loop keep its clock.
//
// The resulting shape (see the run loop at the bottom of the file):
//   * exactly ONE authoritative device sweep per SWEEP_MS — with a hundred viewers or with nobody in the
//     dimension. That single sweep is what the alert runs on;
//   * a bare poll only re-publishes the CACHED snapshot: zero device calls, so viewer count cannot move
//     the device-call rate at all (a device.call runs on the server TICK THREAD, and a flood of them once
//     froze a live server hard enough that no computer could be stopped);
//   * a control action still rebuilds immediately against freshly-read state, then re-arms the clock.
// Note the detector block scans on ITS OWN clock (`detectorScanInterval`, 10 ticks by default) and
// `scan()` hands back that cache — sweeping faster than the block scans buys nothing but tick-thread load.
var SWEEP_MS = 1000;          // one authoritative device sweep per second, viewer or no viewer
var NOCLOCK_SWEEP_EVERY = 2;  // no Date.now() at all (see HAS_CLOCK): sweep every 2nd message instead

// --- the alert (the one thing on this sheet that ACTS) ---
// ALERT_ARMED      drive ALERT_SIDE to 15 while the trip is held. Off by default: an app that starts
//                  hot would surprise whatever is already wired to the computer.
// BROADCAST_ARMED  also network.broadcast the trip to every other computer on the network.
// ALERT_SIDE       which face of THIS COMPUTER carries the alert line.
// ALERT_TRIP       what counts as a contact: "hostile" | "player" | "any".
// ALERT_DIST       the ring, in blocks, measured from each detector. A contact must be inside it.
// ALERT_HOLD_SEC   how long the line stays hot after the last contact leaves the ring. Without this the
//                  output chatters on every sweep as a mob steps in and out of the boundary.
// BROADCAST_MIN_SEC while a trip is held, re-broadcast at most this often (the rising edge is always sent).
var ALERT_ARMED = false;
var BROADCAST_ARMED = false;
var ALERT_SIDE = "down";
var ALERT_TRIP = "hostile";
var ALERT_DIST = 8;
var ALERT_HOLD_SEC = 5;
var BROADCAST_MIN_SEC = 10;

// --- display caps ---
// Every entry here rides the state snapshot on EVERY push, and `appState` is bounded by the
// [display] appStateMaxChars knob — so the board publishes nearest-first and truncates rather than
// growing without limit. Counts and the trip are always computed from the FULL scan; only the rows you
// can actually read are trimmed, and the number dropped is published so the page can say "+17 more".
var ALARM_CAP = 8;            // alarms[]
var LOG_CAP = 14;             // log[]
var UNIT_ENTITY_CAP = 48;     // published contact rows from any ONE unit
var FLEET_ENTITY_CAP = 120;   // ...and across the whole board, shared evenly between units

// ===========================================================================================
//  constants (do not edit)
// ===========================================================================================
// KIND is a Silica PERIPHERAL KIND, not a Minecraft block id — the label the block reports in Java
// (DetectorBlockEntity.kind()) and what network.devices() puts in dev.kind. Changing this string cannot
// make Silica find a different block; it only stops it matching the block it already sees.

var KIND = "detector";

// The detector's four filter categories (silica.runtime.DetectorLogic.FILTER_KEYS). A player matches iff
// "player" is selected; a mob matches if "mob" is selected, else via its hostility bucket — "enemy" for a
// hostile mob, "friendly" for a peaceful one. "friendly"/"enemy" never apply to players.
var FILTER_KEYS = ["mob", "player", "friendly", "enemy"];

// detectorMaxRange is a server knob whose default IS its hard maximum, so 24 is both the shipped cap and
// the ceiling; the block clamps whatever we send. Published as maxRange so the page's stepper stops here.
var MAX_RANGE = 24;

var SIDES = ["north", "south", "east", "west", "up", "down"];
var TRIPS = ["hostile", "player", "any"];

// Date.now() is a plain ECMAScript intrinsic (no host access) and DOES work in the Silica GraalJS sandbox
// — reactor-control and geo-prospector both rely on it. Guarded anyway: without it the clock degrades to
// the message-counted fallback and the alert hold to a sweep countdown, rather than throwing.
var HAS_CLOCK = (typeof Date !== "undefined" && typeof Date.now === "function");

// ===========================================================================================
//  coercion helpers — web.setState needs PLAIN JSON-able values (a scan record is a host proxy)
// ===========================================================================================

function num(v) { return (typeof v === "number" && isFinite(v)) ? v : null; }
function str(v, dflt) { return (typeof v === "string" && v.length) ? v : dflt; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function rnd(v) { var n = num(v); return n == null ? null : Math.round(n); }
function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

function isDetector(dev) { return dev && dev.kind === KIND; }
function nameOf(dev) { return str(dev.label, dev.id); }
function byLabel(a, b) { return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0); }

// "minecraft:zombie" -> "Zombie"; a modded id keeps its namespace so two mods' Slimes stay distinct.
function shortName(id) {
  var s = String(id == null ? "?" : id);
  var i = s.indexOf(":");
  var ns = i >= 0 ? s.slice(0, i) : "";
  var path = i >= 0 ? s.slice(i + 1) : s;
  path = path.replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  return (ns && ns !== "minecraft") ? (ns + ":" + path) : path;
}

// Distances are 1 d.p. off the device; keep them that way in text so the sheet and the log agree.
function fmtDist(d) { return d == null ? "--" : (Math.round(d * 10) / 10) + "m"; }

// ===========================================================================================
//  session state (server-authoritative; the page only ever reflects this back)
// ===========================================================================================

var frame = 0;               // increments on every fresh sweep; the log prefix stamp
var lastAction = null;       // { action, target, ok, text } — sticky status line
var lastSnapshot = null;     // cached authoritative state, re-pushed for bare polls
var nextSweepMs = 0;         // the server clock's deadline (see markSwept)
var msgsSinceSweep = 0;      // no-clock fallback counter
var logEntries = [];         // [{ ok, text }] newest first, capped at LOG_CAP
var prevTally = {};          // unit id -> { entityName: count } from the PREVIOUS sweep (the diff basis)
var wasOnline = {};          // unit id -> was it reachable last sweep (offline/back events)

// --- alert working state ---
var heldSide = null;         // the face we have actually WRITTEN, or null if we hold none
var heldLevel = 0;           // ...and the level we wrote to it
var rsFault = null;          // last redstone.setOutput failure text (the door is shut / no such side)
var tripHeld = false;        // the trip INCLUDING its hold window — what the redstone line follows
var holdUntilMs = 0;         // wall-clock deadline of the hold (HAS_CLOCK)
var holdSweeps = 0;          // ...and the no-clock fallback: sweeps of hold left
var lastBroadcastMs = 0;     // rate limit for a held trip's repeat broadcasts
var lastBroadcastSweep = 0;  // ...same, counted in sweeps when there is no clock

// A short frame stamp keeps otherwise-identical repeated events distinguishable in the log.
function logPush(ok, text) {
  logEntries.unshift({ ok: !!ok, text: "[" + frame + "] " + text });
  if (logEntries.length > LOG_CAP) { logEntries.length = LOG_CAP; }
}

// ===========================================================================================
//  per-unit snapshots — every field copied explicitly, one bad device can never sink the board
// ===========================================================================================

// The full Unit shape with everything nulled out. An OFFLINE unit is published exactly like this, so the
// page can read u.filter.length / u.entities unconditionally without a single guard of its own.
function newUnit(id, label, online, notFound) {
  return {
    id: id, label: label, online: !!online, error: false, notFound: !!notFound,
    // --- the detector's own config ---
    range: null, filter: [], blind: false,
    // --- the scan ---
    total: 0, hostile: 0, friendly: 0, players: 0,
    nearestHostile: null, nearestAny: null, nearestName: null,
    redstone: 0,                       // DERIVED — see deriveRedstone
    entities: [], hidden: 0,
    arrivals: [], departures: [],
    state: "offline"
  };
}

// Copy the faculty's proxy records into plain JS values so web.setState serializes cleanly, and sort
// NEAREST FIRST — everything downstream (truncation, the nearest readouts, the radar) assumes that order.
function plainEntities(raw) {
  var out = [], i;
  for (i = 0; i < raw.length; i++) {
    var e = raw[i];
    var p = e.pos;
    out.push({
      kind: str(e.kind, "mob"),
      name: str(e.name, "?"),
      hostile: !!e.hostile,
      x: p ? rnd(p.x) : null, y: p ? rnd(p.y) : null, z: p ? rnd(p.z) : null,
      dx: num(e.dx), dz: num(e.dz),      // offset from the block — the radar plots these directly
      dist: num(e.dist)
    });
  }
  out.sort(function (a, b) {
    return (a.dist == null ? 1e9 : a.dist) - (b.dist == null ? 1e9 : b.dist);
  });
  return out;
}

// The block's own redstone output is NOT exposed by any verb, so the board derives it from the same rule
// the block uses: 15 while the FILTERED scan is non-empty, else 0 (DetectorBlockEntity). It is labelled
// "derived" everywhere it is shown, because a derived reading that looks measured is worse than none.
function deriveRedstone(u) { u.redstone = u.total > 0 ? 15 : 0; }

// Count by class and find the two "nearest" readouts in one pass over the sorted list. A player is never
// `hostile` (the classifier leaves it undefined by design), so players are counted first and mobs split
// off `hostile` — the same three-way split the filter keys use.
function deriveCounts(u, list) {
  var i;
  u.total = list.length;
  for (i = 0; i < list.length; i++) {
    var e = list[i];
    if (e.kind === "player") { u.players++; } else if (e.hostile) { u.hostile++; } else { u.friendly++; }
    if (u.nearestAny == null && e.dist != null) { u.nearestAny = e.dist; u.nearestName = e.name; }
    if (u.nearestHostile == null && e.hostile && e.dist != null) { u.nearestHostile = e.dist; }
  }
}

// The multiset diff. The device's records carry NO STABLE ID — two Zombies are indistinguishable between
// sweeps — so this deliberately does not pretend to track individuals: it diffs the COUNT PER NAME and
// reports "+2 Zombie" / "-1 Creeper". Anything that needs identity (dwell time, closing rate, "the same
// mob is still there") is not derivable from this device and is not faked here.
function tallyOf(list) {
  var t = {}, i;
  for (i = 0; i < list.length; i++) {
    var n = list[i].name;
    t[n] = (t[n] || 0) + 1;
  }
  return t;
}

function deriveDiff(u, list) {
  var now = tallyOf(list);
  var prev = prevTally[u.id];
  prevTally[u.id] = now;
  // No previous sweep for this unit (first sight, or it just came back from an unloaded chunk): baseline
  // only. Otherwise a returning detector would report its whole roster as fresh arrivals.
  if (!prev) { return; }
  var k;
  for (k in now) {
    if (has(now, k)) {
      var gained = now[k] - (prev[k] || 0);
      if (gained > 0) { u.arrivals.push({ name: k, n: gained }); }
    }
  }
  for (k in prev) {
    if (has(prev, k)) {
      var lost = prev[k] - (now[k] || 0);
      if (lost > 0) { u.departures.push({ name: k, n: lost }); }
    }
  }
}

// offline -> error -> blind (a filter that matches nothing) -> alert/contact/clear.
function deriveState(u) {
  if (!u.online) { return "offline"; }
  if (u.error) { return "error"; }
  if (u.blind) { return "blind"; }
  if (u.nearestHostile != null && u.nearestHostile <= ALERT_DIST) { return "alert"; }
  if (u.total > 0) { return "contact"; }
  return "clear";
}

// EXACTLY ONE config read + ONE scan per unit per sweep. Both are device.calls on the server tick thread;
// the whole cadence design above exists to keep that number flat regardless of how many people are looking.
function unitSnapshot(dev) {
  var u = newUnit(dev.id, str(dev.label, dev.id), !!dev.online, false);
  if (!dev.online) { return u; }

  var cfg, raw;
  try {
    cfg = dev.call("config", {});          // {filter:[...], range:N} — reads, changes nothing
    raw = dev.call("scan");                // the block's latest FILTERED cache
  } catch (e) {
    print("perimeter: read failed for " + u.id + " - " + e);
    u.error = true; u.state = "error";
    delete prevTally[u.id];
    return u;
  }

  var i;
  u.range = num(cfg && cfg.range);
  if (cfg && cfg.filter) {
    for (i = 0; i < cfg.filter.length; i++) { u.filter.push(String(cfg.filter[i])); }
  }
  u.blind = u.filter.length === 0;         // an empty filter matches nothing: the block is silently blind

  var list = plainEntities(raw);
  deriveCounts(u, list);
  deriveRedstone(u);
  deriveDiff(u, list);
  u.state = deriveState(u);
  u.entities = list;                       // FULL list for now; buildState truncates once the caps are known
  return u;
}

// The device sweep: either the pinned DETECTORS roster (each name ALWAYS emits a card, offline placeholder
// included) or every `detector` auto-discovered on the network.
function sweep() {
  var units = [], i;
  if (DETECTORS.length > 0) {
    for (i = 0; i < DETECTORS.length; i++) {
      var name = DETECTORS[i];
      var dev = network.find(name);
      if (dev && isDetector(dev) && dev.online) { units.push(unitSnapshot(dev)); }
      else { units.push(newUnit(name, name, false, !dev)); }
    }
  } else {
    var all = network.devices();
    for (i = 0; i < all.length; i++) { if (isDetector(all[i])) { units.push(unitSnapshot(all[i])); } }
  }
  units.sort(byLabel);
  return units;
}

// Drop diff history for units that are no longer on the board, so a returning detector re-baselines
// cleanly instead of reporting its whole roster as arrivals — and log the offline / came-back edges.
function reconcileRoster(units) {
  var live = {}, i, k;
  for (i = 0; i < units.length; i++) {
    var u = units[i];
    var reachable = u.online && !u.error;
    live[u.id] = true;
    if (reachable && wasOnline[u.id] === false) { logPush(true, u.label + ": back online"); }
    if (!reachable && wasOnline[u.id] === true) {
      logPush(false, u.label + ": went offline");
      delete prevTally[u.id];
    }
    wasOnline[u.id] = reachable;
  }
  for (k in prevTally) { if (has(prevTally, k) && !live[k]) { delete prevTally[k]; } }
  for (k in wasOnline) { if (has(wasOnline, k) && !live[k]) { delete wasOnline[k]; } }
}

// ===========================================================================================
//  the alert — evaluated from the snapshot just built, so it costs NO extra device calls
// ===========================================================================================

// Does this contact count under the current trip mode? A player is never flagged hostile, so "hostile"
// watches mobs only and "player" watches players only; "any" takes whatever the filter let through.
function watched(e) {
  if (ALERT_TRIP === "any") { return true; }
  if (ALERT_TRIP === "player") { return e.kind === "player"; }
  return !!e.hostile;
}

// The raw trip: every watched contact inside ALERT_DIST, across every online unit. Entities are already
// sorted nearest-first per unit, but the board's nearest is the min across units, so scan them all.
function evalTrip(units) {
  var t = { on: false, count: 0, unit: null, name: null, dist: null, hostile: false };
  var i, j;
  for (i = 0; i < units.length; i++) {
    var u = units[i];
    if (!u.online || u.error) { continue; }
    for (j = 0; j < u.entities.length; j++) {
      var e = u.entities[j];
      if (e.dist == null || e.dist > ALERT_DIST) { break; }   // sorted: the rest of this unit is farther
      if (!watched(e)) { continue; }
      t.count++;
      if (t.dist == null || e.dist < t.dist) {
        t.unit = u.label; t.name = e.name; t.dist = e.dist; t.hostile = !!e.hostile;
      }
    }
  }
  t.on = t.count > 0;
  return t;
}

// Write a face, remembering what we wrote so a steady state costs no host call at all. A failure is
// recorded rather than thrown: a welded-shut redstone door must degrade to an alarm, not kill the board.
function writeSide(side, level) {
  if (heldSide === side && heldLevel === level) { return true; }
  try {
    redstone.setOutput(side, level);
    heldSide = side; heldLevel = level; rsFault = null;
    return true;
  } catch (e) {
    rsFault = String(e);
    print("perimeter: redstone.setOutput(" + side + ", " + level + ") failed - " + e);
    return false;
  }
}

// Drive whatever face we currently hold back to 0. Called before the side changes and on disarm —
// without it a re-pointed alert leaves the OLD face hot forever with nothing left watching it.
function releaseSide() {
  if (heldSide != null && heldLevel !== 0) { writeSide(heldSide, 0); }
}

function armHold() {
  holdUntilMs = HAS_CLOCK ? (Date.now() + ALERT_HOLD_SEC * 1000) : 0;
  holdSweeps = Math.ceil(ALERT_HOLD_SEC * 1000 / SWEEP_MS);
}

function holdActive() {
  if (HAS_CLOCK) { return Date.now() < holdUntilMs; }
  return holdSweeps > 0;
}

// Rate limit for a HELD trip's repeat broadcasts. The rising and clearing edges always go out; this only
// bounds the "still tripped" reminders in between, so a mob camped in the ring cannot spam the network.
function broadcastDue() {
  if (HAS_CLOCK) { return (Date.now() - lastBroadcastMs) >= BROADCAST_MIN_SEC * 1000; }
  return (frame - lastBroadcastSweep) >= Math.ceil(BROADCAST_MIN_SEC * 1000 / SWEEP_MS);
}

function sendBroadcast(level, t) {
  lastBroadcastMs = HAS_CLOCK ? Date.now() : 0;
  lastBroadcastSweep = frame;
  try {
    network.broadcast({
      silica: "perimeter", level: level, unit: t.unit,
      count: t.count, nearest: t.dist
    });
  } catch (e) {
    logPush(false, "broadcast failed — " + e);
    print("perimeter: network.broadcast failed - " + e);
  }
}

// The alert action itself. Runs once per sweep on the server clock — this is the half that has to work
// with nobody watching. ARM drives the redstone face; BCAST drives the network message; the trip is
// evaluated either way so the sheet can be set up before it is armed.
function applyAlert(t) {
  if (!HAS_CLOCK && holdSweeps > 0) { holdSweeps--; }   // the no-clock hold ticks down once per sweep

  if (t.on) { armHold(); }
  var nowHeld = t.on || holdActive();

  if (nowHeld && !tripHeld) {
    logPush(false, "ALERT — " + shortName(t.name) + " at " + fmtDist(t.dist)
      + (t.unit ? " (" + t.unit + ")" : "") + ", " + t.count + " in ring");
    if (BROADCAST_ARMED) { sendBroadcast(t.hostile ? "crit" : "warn", t); }
  } else if (!nowHeld && tripHeld) {
    logPush(true, "alert cleared");
    if (BROADCAST_ARMED) { sendBroadcast("clear", t); }
  } else if (nowHeld && t.on && BROADCAST_ARMED && broadcastDue()) {
    sendBroadcast(t.hostile ? "crit" : "warn", t);
  }
  tripHeld = nowHeld;

  // The line follows the HELD trip, not the raw one: dropping it the instant a mob steps a block outside
  // the ring would chatter the output every sweep, which is what ALERT_HOLD_SEC exists to stop.
  if (!ALERT_ARMED) { releaseSide(); return; }
  writeSide(ALERT_SIDE, nowHeld ? 15 : 0);
}

// ===========================================================================================
//  alarms — derived fresh from the snapshot each sweep (no extra device calls)
// ===========================================================================================

// Would an armed alert watching hostiles / players ever see one, given what this detector's filter lets
// through? This is the cross-check the old app had no way to make: the two settings live on different
// blocks, so an alert can sit armed for weeks against a filter that can never feed it.
function filterCanFeedTrip(u) {
  var wantsMobs = (ALERT_TRIP === "hostile" || ALERT_TRIP === "any");
  var wantsPlayers = (ALERT_TRIP === "player" || ALERT_TRIP === "any");
  var seesMobs = u.filter.indexOf("mob") >= 0 || u.filter.indexOf("enemy") >= 0;
  var seesPlayers = u.filter.indexOf("player") >= 0;
  if (wantsMobs && seesMobs) { return true; }
  if (wantsPlayers && seesPlayers) { return true; }
  return false;
}

function buildAlarms(units, trip) {
  var out = [], i;
  function add(level, unit, text) { out.push({ level: level, unit: unit, text: text }); }
  var alertLive = ALERT_ARMED || BROADCAST_ARMED;

  if (units.length === 0) {
    add("warn", null, "No detector on the network — wire one to this computer");
  }

  for (i = 0; i < units.length; i++) {
    var u = units[i];

    if (!u.online) {
      add("warn", u.label, u.notFound
        ? "not found on the network — check the wiring"
        : "offline (chunk unloaded or block removed)");
      continue;                              // nothing else about an offline unit is knowable
    }
    if (u.error) { add("crit", u.label, "scan read failed"); continue; }

    if (u.blind) { add("warn", u.label, "filter is EMPTY — this detector matches nothing"); }

    if (u.nearestHostile != null && u.nearestHostile <= ALERT_DIST) {
      add("crit", u.label, "hostile inside " + ALERT_DIST + "m — nearest "
        + fmtDist(u.nearestHostile));
    }
    if (u.players > 0 && (ALERT_TRIP === "player" || ALERT_TRIP === "any")) {
      add("warn", u.label, u.players + " player" + (u.players === 1 ? "" : "s") + " in range");
    }

    // The interesting one: armed against something this unit's filter cannot see.
    if (alertLive && !u.blind && !filterCanFeedTrip(u)) {
      add("warn", u.label, "alert watches " + ALERT_TRIP + " but the filter ("
        + u.filter.join(", ") + ") can never report one");
    }
  }

  if (ALERT_ARMED && rsFault) {
    add("warn", null, "redstone " + ALERT_SIDE + " refused — " + rsFault);
  }

  // Crit first, insertion order preserved within a level, capped.
  var crit = [], warn = [], j;
  for (j = 0; j < out.length; j++) { (out[j].level === "crit" ? crit : warn).push(out[j]); }
  var merged = crit.concat(warn);
  if (merged.length === 0) {
    return [{ level: "none", unit: null, text: trip.on ? "Contact in ring — perimeter armed"
      : "No active alarms — perimeter clear" }];
  }
  return merged.length > ALARM_CAP ? merged.slice(0, ALARM_CAP) : merged;
}

// ===========================================================================================
//  the authoritative state the page renders from
// ===========================================================================================

// Publish nearest-first and truncate: at most UNIT_ENTITY_CAP rows from any one unit, and at most
// FLEET_ENTITY_CAP across the board, shared EVENLY so one busy unit cannot starve the rest of the sheet.
function rowBudget(unitCount) {
  var share = unitCount > 0 ? Math.floor(FLEET_ENTITY_CAP / unitCount) : FLEET_ENTITY_CAP;
  if (share < 1) { share = 1; }
  return share < UNIT_ENTITY_CAP ? share : UNIT_ENTITY_CAP;
}

function buildState() {
  frame++;

  var units = sweep();
  reconcileRoster(units);

  // Arrivals / departures go to the log BEFORE truncation, from the full diff.
  var i, j;
  for (i = 0; i < units.length; i++) {
    var u = units[i];
    for (j = 0; j < u.arrivals.length; j++) {
      logPush(true, u.label + ": +" + u.arrivals[j].n + " " + shortName(u.arrivals[j].name));
    }
    for (j = 0; j < u.departures.length; j++) {
      logPush(true, u.label + ": -" + u.departures[j].n + " " + shortName(u.departures[j].name));
    }
  }

  var trip = evalTrip(units);
  applyAlert(trip);
  var alarms = buildAlarms(units, trip);

  // --- fleet aggregate (from the FULL counts, before any row is dropped) ---
  var fleet = {
    count: units.length, online: 0, offline: 0,
    total: 0, hostile: 0, friendly: 0, players: 0,
    nearestHostile: null, nearestAny: null, hidden: 0, hot: 0
  };
  for (i = 0; i < units.length; i++) {
    var f = units[i];
    if (f.online && !f.error) { fleet.online++; } else { fleet.offline++; }
    fleet.total += f.total;
    fleet.hostile += f.hostile;
    fleet.friendly += f.friendly;
    fleet.players += f.players;
    if (f.redstone > 0) { fleet.hot++; }
    if (f.nearestHostile != null && (fleet.nearestHostile == null || f.nearestHostile < fleet.nearestHostile)) {
      fleet.nearestHostile = f.nearestHostile;
    }
    if (f.nearestAny != null && (fleet.nearestAny == null || f.nearestAny < fleet.nearestAny)) {
      fleet.nearestAny = f.nearestAny;
    }
  }

  // --- truncate the published rows (counts above are already banked) ---
  var cap = rowBudget(units.length);
  for (i = 0; i < units.length; i++) {
    var t = units[i];
    if (t.entities.length > cap) {
      t.hidden = t.entities.length - cap;
      fleet.hidden += t.hidden;
      t.entities = t.entities.slice(0, cap);
    }
  }

  var ok = units.length > 0;
  return {
    ok: ok,
    reason: ok ? null : "No Entity Detector on the network. Wire a Detector to this computer (a NIC adds"
      + " wireless) — or list names in DETECTORS at the top of entrypoint.js.",
    frame: frame,
    maxRange: MAX_RANGE,
    filterKeys: FILTER_KEYS,
    units: units,
    fleet: fleet,
    alert: {
      armed: ALERT_ARMED, broadcast: BROADCAST_ARMED,
      side: ALERT_SIDE, sides: SIDES,
      trip: ALERT_TRIP, trips: TRIPS,
      dist: ALERT_DIST, holdSec: ALERT_HOLD_SEC,
      tripped: trip.on, held: tripHeld,
      output: (ALERT_ARMED && tripHeld) ? 15 : 0,
      unit: trip.unit, name: trip.name, nearest: trip.dist, count: trip.count,
      fault: rsFault
    },
    alarms: alarms,
    log: logEntries.slice(0),
    last: lastAction
  };
}

// Fresh sweep: read the devices, run the alert, cache it, publish it.
function push() { lastSnapshot = buildState(); web.setState(lastSnapshot); }

// ===========================================================================================
//  control (server holds ALL authority; every request is re-validated against a live device)
// ===========================================================================================

// Resolve a control target and confirm it is a real, ONLINE detector. Returns the Device, or null after
// recording a rejection into lastAction + the log.
function resolveTarget(id, action) {
  var dev = (typeof id === "string" && id) ? network.find(id) : null;
  if (!dev || !isDetector(dev) || !dev.online) {
    lastAction = { action: action, target: str(id, "?"), ok: false, text: "Invalid or offline detector." };
    logPush(false, action + ": invalid or offline detector target");
    print("perimeter: ignored " + action + " for invalid/offline target " + id);
    return null;
  }
  return dev;
}

function record(action, target, ok, text) {
  lastAction = { action: action, target: target, ok: !!ok, text: text };
  logPush(ok, text);
}

function handle(msg) {
  if (!msg || typeof msg.action !== "string") { return; }
  var a = msg.action;

  if (a === "poll") { return; }

  // Retune ONE detector. Both fields are optional; whichever arrives is validated on its own, and the
  // block clamps the range again on its side (1..detectorMaxRange), so this is belt and braces.
  if (a === "config") {
    var dev = resolveTarget(msg.unit, a);
    if (!dev) { return; }
    var patch = {}, parts = [], i;
    if (Object.prototype.toString.call(msg.filter) === "[object Array]") {
      var keys = [];
      for (i = 0; i < msg.filter.length; i++) {
        var k = msg.filter[i];
        if (typeof k === "string" && FILTER_KEYS.indexOf(k) >= 0 && keys.indexOf(k) < 0) { keys.push(k); }
      }
      patch.filter = keys;
      parts.push("filter [" + (keys.length ? keys.join(", ") : "none") + "]");
    }
    var r = num(msg.range);
    if (r != null) {
      patch.range = clamp(Math.round(r), 1, MAX_RANGE);
      parts.push("range " + patch.range);
    }
    if (parts.length === 0) { record(a, nameOf(dev), false, nameOf(dev) + ": nothing to change."); return; }
    try {
      var ack = dev.call("config", patch);
      record(a, nameOf(dev), true, nameOf(dev) + ": " + parts.join(", ")
        + " -> range " + num(ack && ack.range));
      print("perimeter: config " + parts.join(", ") + " -> " + nameOf(dev));
    } catch (e) {
      record(a, nameOf(dev), false, nameOf(dev) + ": config refused — " + e);
      print("perimeter: config refused for " + nameOf(dev) + " - " + e);
    }
    return;
  }

  if (a === "arm") {
    var on = !!msg.enabled;
    if (on === ALERT_ARMED) { return; }
    ALERT_ARMED = on;
    if (!on) { releaseSide(); rsFault = null; }   // disarm drops the line before anything else happens
    record(a, null, true, "Alert " + (on ? "ARMED" : "disarmed") + " on " + ALERT_SIDE);
    return;
  }

  if (a === "armBroadcast") {
    var b = !!msg.enabled;
    if (b === BROADCAST_ARMED) { return; }
    BROADCAST_ARMED = b;
    record(a, null, true, "Broadcast " + (b ? "ARMED" : "disarmed"));
    return;
  }

  if (a === "alertSide") {
    var side = str(msg.side, null);
    if (SIDES.indexOf(side) < 0) {
      record(a, null, false, "Unknown side " + str(msg.side, "?"));
      return;
    }
    if (side === ALERT_SIDE) { return; }
    releaseSide();                 // the OLD face goes cold first, or it stays hot with nothing watching it
    ALERT_SIDE = side;
    rsFault = null;
    record(a, null, true, "Alert side -> " + side);
    return;
  }

  if (a === "alertTrip") {
    var mode = str(msg.mode, null);
    if (TRIPS.indexOf(mode) < 0) {
      record(a, null, false, "Unknown trip mode " + str(msg.mode, "?"));
      return;
    }
    ALERT_TRIP = mode;
    record(a, null, true, "Trip mode -> " + mode);
    return;
  }

  if (a === "alertDist") {
    var d = num(msg.dist);
    if (d == null) { record(a, null, false, "No alert distance given."); return; }
    ALERT_DIST = clamp(Math.round(d), 1, MAX_RANGE);
    record(a, null, true, "Alert ring -> " + ALERT_DIST + "m");
    return;
  }

  if (a === "clearLog") {
    logEntries.length = 0;
    lastAction = { action: a, target: null, ok: true, text: "Event log cleared." };
    return;
  }
  // Any unrecognised action is a no-op here; the run loop still publishes fresh state.
}

// ===========================================================================================
//  the server clock (see SWEEP_MS)
// ===========================================================================================

// Re-arm the deadline from NOW — never `nextSweepMs += SWEEP_MS`. After a lag spike or a slow device
// sweep the next cycle is simply late; it never queues a catch-up BURST of sweeps into an already
// struggling tick thread, which is the failure mode this whole file is shaped around.
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
// not restart the clock (that is what would let a steady poll stream starve the alert forever — the
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

// ===========================================================================================
//  run
// ===========================================================================================

web.openFile("ui/index.html");   // resolves relative to this app's own folder
push();                          // initial render (fresh sweep + first alert evaluation)
markSwept();

while (true) {
  // null on timeout. NOT a plain pullEvent: with nobody watching, no web_message is ever produced.
  var ev = os.pullEvent("web_message", waitSeconds());

  if (ev) {
    msgsSinceSweep++;
    var msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { msg = null; }
    var action = msg && msg.action;

    if (action && action !== "poll") {
      // Control action — immediate, never debounced and never served from the cache: handle() re-resolves
      // and re-reads every target live, then we rebuild + publish at once. Re-arming the clock here is
      // what stops a button press and the tick behind it from sweeping the devices twice.
      handle(msg);
      push();
      markSwept();
      continue;
    }

    // Bare poll / heartbeat / unparsable frame — re-publish what the clock already built. ZERO device
    // calls, so the number of viewers cannot change the device-call rate at all.
    if (lastSnapshot) { web.setState(lastSnapshot); }
  }

  // The clock tick. THIS is the half that has to run with nobody watching: fresh device sweep, alert
  // evaluation (which may drive redstone / broadcast), publish. `!ev` = the timeout fired; sweepDue() = a
  // message woke us early but the deadline has since passed.
  if (!ev || sweepDue()) {
    push();
    markSwept();
  }
}
