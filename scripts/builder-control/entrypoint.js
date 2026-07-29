// builder-control/entrypoint.js — server-side entry for the Excavation Control Room (multi-file Path B).
//
// An RFTools Builder control room: the functional superset of the old `rftb-builder-test` panel, built as
// the sibling sheet of `reactor-control`. It watches every `rftools_builder` reachable on this computer's
// Silica network and publishes one authoritative snapshot per rebuild:
//
//   * per-unit telemetry — the FULL getStatus surface (card, redstone mode, work region, scan cursor,
//     flags, energy, lastError, position + dimension)
//   * a MEASURED excavation rate: seconds-per-layer, derived by watching `currentLevel` fall over real
//     wall-clock time, and from it layersLeft / etaSec / etaText ("how long until this hole is finished")
//   * a MEASURED FE/t buffer flow per unit (charging / draining) with a power runway, derived by
//     differencing `energy.stored` over wall clock — the Builder adapter exposes no per-tick draw field
//   * derived alarms + a rolling event log — including STALL DETECTION (a scan cursor that has sat
//     still while the machine is enabled) and the power-vs-ETA cross-check
//
// It does NOT manage the fleet for you. Every control is operator-driven: this script never starts,
// stops or restarts a Builder on its own. Telemetry tells you what is wrong; you decide what to do.
//
// ALL capability access is here on the server. The page holds NO authority — it only *requests* actions
// via mc.send, and this script re-validates every request (client messages are untrusted input): a
// control only fires against a target that is a real, ONLINE device of kind `rftools_builder`, re-resolved
// live each time. Any adapter call that throws is caught and surfaced back as a status line.
//
// Capability doors: network (needs a NIC) + web (needs web-display). The Builder is reached as an ordinary
// network device via a mounted Silica Port; no extra door (E4-D14 — the cable is the gate).
//
// Set up: a smart computer (SilicaOS ROM + GPU + web-display) with a NIC; mount a Silica Port on each
// RFTools Builder and wire them all to the computer (adjacent, or via a Switch / Router -> Receiver). Run
// this from the Runner and stream it to a named monitor, or open the pad / pocket view.

// ===========================================================================================
//  TUNABLE CONFIG — edit this block to match YOUR base
// ===========================================================================================

// BUILDERS: optionally pin specific Builders by name — the screwdriver label you gave the Port, or the
// auto device id. Leave EMPTY to auto-discover every rftools_builder on the network. When you DO list
// names, each one ALWAYS gets a card — as an OFFLINE placeholder when it isn't currently reachable — so a
// chunk-unloaded quarry never silently vanishes off the board (and still raises an alarm).
//   e.g.:  var BUILDERS = ["quarry_overworld", "quarry_nether"];
var BUILDERS = [];

// --- alarm thresholds (DETECTION ONLY — nothing here ever touches a Builder) ---
// STALL_SEC   a unit that is enabled but whose scan cursor has not moved for this long reads as
//             `stalled` and raises a crit alarm. It is NOT restarted for you.
// LOW_BUF_PCT a buffer under this raises a crit alarm (a warn follows under 25%).
var STALL_SEC = 90;
var LOW_BUF_PCT = 5;

// --- the server clock: WHY THIS APP DOES NOT WAIT ON THE PAGE ---
// (the E4-P1 freeze lesson: a device.call runs on the server TICK THREAD, and a flood of them once froze a
// live server hard enough that no computer could be stopped.)
// The run loop advances on the SERVER's own clock, not on viewer polls. os.pullEvent(filter, seconds)
// returns null on timeout, which is what lets this loop keep a clock of its own.
//
// The resulting shape (see the run loop at the bottom of the file):
//   * exactly ONE authoritative Builder sweep per SWEEP_MS — with one viewer, four viewers, or none;
//   * a bare poll only re-publishes the CACHED snapshot: zero device calls, so viewer count cannot move
//     the device-call rate at all;
//   * a control action still rebuilds immediately against freshly-read state, then re-arms the clock.
// This app never acts on its own, so the clock is not about autonomy — it is about cost, and about the
// MEASURED rates below, which are only honest if their sample interval is fixed. The counter this
// replaced (`POLL_REBUILD_EVERY`, every 2nd bare poll) sampled them on a viewer-dependent cadence, so the
// published seconds-per-layer and FE/t genuinely changed with how many people were watching the board.
var SWEEP_MS = 1000;          // one authoritative Builder sweep per second, viewer or no viewer
var NOCLOCK_SWEEP_EVERY = 2;  // no Date.now() at all (see HAS_CLOCK): sweep every 2nd message instead

// --- rate measurement (wall-clock differencing; see HAS_CLOCK below) ---
// Shared by BOTH derived rates: the FE/t buffer flow and the seconds-per-layer excavation rate. Both now
// sample off the SWEEP_MS clock tick, never off message arrival.
var RATE_FLOOR_MS = 500;      // ignore samples closer together than this (a short sweep after a lag spike)
var RATE_EMA = 0.3;           // weight of the newest sample in the smoothed rate
var RATE_DEADBAND = 0.5;      // |FE/t| below this reads as 0 (integer-FE granularity + sweep jitter)

// --- display caps ---
// The page wraps + scrolls both lists, so these are no longer bounded by what fits on one screen —
// only by the document budget. Kept modest: every entry rides the state snapshot on every push.
var ALARM_CAP = 12;           // alarms[]
var LOG_CAP = 14;             // log[]

// ===========================================================================================
//  constants (do not edit)
// ===========================================================================================
// KIND is a Silica PERIPHERAL KIND, not a Minecraft block id. A kind is a label the integration jar
// reports in Java (RftbBuilderAdapter.kind()) and is what network.devices() puts in dev.kind. Changing
// this string cannot make Silica find a different block — it only stops it matching the block it sees.

var KIND = "rftools_builder";

var FLAG_KEYS = ["silent", "support", "entity", "loop", "wait", "hilight"];
var RS_MODES = ["ignored", "onRequired", "offRequired"];   // redstone-mode cycle order + the allow-list

var TICKS_PER_SEC = 20;
var MS_PER_TICK = 50;

// Date.now() is a plain ECMAScript intrinsic (no host access) and DOES work in the Silica GraalJS
// sandbox — reactor-control relies on it (the contrary comment in mek-plant is wrong). Guarded anyway:
// if it is ever unavailable, every measured rate degrades to null instead of throwing.
var HAS_CLOCK = (typeof Date !== "undefined" && typeof Date.now === "function");

// ===========================================================================================
//  coercion helpers — web.setState needs PLAIN JSON-able values (a getStatus result is a host proxy)
// ===========================================================================================

function num(v) { return (typeof v === "number" && isFinite(v)) ? v : null; }
function str(v, dflt) { return (typeof v === "string" && v.length) ? v : dflt; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// A {x,y,z} host proxy -> a plain {x,y,z} of numbers-or-nulls, or null when the position is absent.
function xyz(p) { return p ? { x: num(p.x), y: num(p.y), z: num(p.z) } : null; }

// A {stored,capacity} host proxy -> a plain {stored,capacity}, or null when the block exposes no cap
// (the Unit contract says energy is nullable, unlike reactor-control's always-present tanks).
function tank(t) { return t ? { stored: num(t.stored), capacity: num(t.capacity) } : null; }

// {stored,capacity} -> 0..100, or null when it can't be computed (missing tank / zero capacity).
function pctOf(t) {
  if (!t || t.capacity == null || !(t.capacity > 0) || t.stored == null) { return null; }
  return t.stored / t.capacity * 100;
}

// A flags host proxy -> a plain always-present 6-key boolean block, so the page can read f.loop blindly.
function flagsOf(f) {
  var o = {};
  for (var i = 0; i < FLAG_KEYS.length; i++) { o[FLAG_KEYS[i]] = f ? !!f[FLAG_KEYS[i]] : false; }
  return o;
}

function isBuilder(dev) { return dev && dev.kind === KIND; }

function byLabel(a, b) { return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0); }

// Seconds -> a short human duration for the sheet's ETA/runway readouts ("4h 12m", "7m 30s", "45s").
function fmtSec(s) {
  if (s == null || !isFinite(s) || s < 0) { return "--"; }
  var t = Math.round(s);
  if (t >= 3600) { return Math.floor(t / 3600) + "h " + Math.floor((t % 3600) / 60) + "m"; }
  if (t >= 60) { return Math.floor(t / 60) + "m " + (t % 60) + "s"; }
  return t + "s";
}

// ===========================================================================================
//  session state (server-authoritative; the page only ever reflects this back)
// ===========================================================================================

var frame = 0;               // increments on every fresh rebuild; the log prefix stamp
var lastAction = null;       // { action, target, ok, text } — sticky status line
var lastSnapshot = null;     // cached authoritative state, re-pushed for bare polls
var nextSweepMs = 0;         // the server clock's deadline (see markSwept)
var msgsSinceSweep = 0;      // no-clock fallback counter
var sel = null;              // id of the unit the detail panel + controls address
var hist = {};               // id -> measurement history (layer rate, stall clock, FE/t EMA)
var logEntries = [];         // [{ ok, text }] newest first, capped at LOG_CAP

// A short frame stamp keeps otherwise-identical repeated events distinguishable in the log.
function logPush(ok, text) {
  logEntries.unshift({ ok: !!ok, text: "[" + frame + "] " + text });
  if (logEntries.length > LOG_CAP) { logEntries.length = LOG_CAP; }
}

// One history record per unit id, holding BOTH measurements (they share the same wall clock):
//   level/levelMs/secPerLayer  the excavation rate — how long one Y layer takes
//   scanKey/moveMs             the stall clock — how long the scan cursor has sat still
//   lastStored/lastMs/ema      the FE/t buffer flow
function histFor(id) {
  var h = hist[id];
  if (!h) {
    h = hist[id] = {
      level: null, levelMs: 0, secPerLayer: null,
      scanKey: null, moveMs: 0,
      lastStored: null, lastMs: 0, ema: null
    };
  }
  return h;
}

// ===========================================================================================
//  per-unit snapshots — every field copied explicitly, one bad device can never sink the board
// ===========================================================================================

// The full Unit shape with everything nulled out. An OFFLINE unit is published exactly like this, so the
// page can read u.flags.loop / u.energy / u.scan unconditionally without a single guard of its own.
function newUnit(id, label, online, notFound) {
  return {
    id: id, label: label, online: !!online, error: false, notFound: !!notFound,
    // --- raw getStatus passthrough ---
    hasCard: false, card: "none", spaceMode: null, enabled: false, redstoneMode: "ignored",
    scan: null, min: null, max: null, currentLevel: null,
    lastError: "", pos: null, dimension: null,
    dimensions: null, offset: null,
    flags: flagsOf(null),
    energy: null, energyPct: null,
    // --- derived server-side ---
    state: "offline",
    progress: null, layersTotal: null, layersLeft: null,
    secPerLayer: null, etaSec: null, etaText: "--",
    netFe: null, powerRunwaySec: null, stalledSec: null
  };
}

// Measure the excavation rate by watching `currentLevel` fall over real wall-clock time. A quarry sweeps
// TOP-DOWN, so each downward step of currentLevel is one finished layer; the elapsed time between steps
// is one layer-duration sample, EMA-smoothed (RATE_EMA) so a fast layer over air and a slow one through
// deepslate don't make the ETA dance.
//   * the very first observation is a baseline only (no elapsed time to measure against yet)
//   * a sample under RATE_FLOOR_MS is ignored (two viewers polling at once can collapse the window)
//   * an UPWARD jump means the Builder was restarted / the card was re-placed — re-baseline, no sample
//   * a multi-layer step is divided by the layers crossed, so a skipped-over air pocket can't inflate it
function deriveLayerRate(m) {
  if (!HAS_CLOCK) { return; }
  var lvl = m.currentLevel;
  if (lvl == null || m.min == null || m.max == null) { return; }

  var now = Date.now();
  var h = histFor(m.id);
  if (h.level == null) { h.level = lvl; h.levelMs = now; return; }   // baseline
  if (lvl === h.level) { return; }

  var steps = h.level - lvl;          // + = sweeping DOWN, the normal quarry direction
  var dt = now - h.levelMs;
  h.level = lvl;
  h.levelMs = now;
  if (steps <= 0 || dt < RATE_FLOOR_MS) { return; }

  var sample = (dt / 1000) / steps;   // seconds per layer
  h.secPerLayer = (h.secPerLayer == null) ? sample : (h.secPerLayer + RATE_EMA * (sample - h.secPerLayer));
}

// The stall clock: how long the scan cursor has sat completely still while the machine is ENABLED. Any
// movement of the cursor (or of the Y level) ends the stall episode. A disabled unit is idle, not
// stalled, so its clock is held at zero. Pure detection — the operator decides whether to restart it.
function deriveStall(m) {
  if (!HAS_CLOCK) { return; }
  var h = histFor(m.id);
  var now = Date.now();
  var key = m.currentLevel + "/" + (m.scan ? (m.scan.x + "," + m.scan.y + "," + m.scan.z) : "-");

  if (h.scanKey !== key) { h.scanKey = key; h.moveMs = now; }
  if (!m.enabled) { h.moveMs = now; return; }   // idle != stalled
  m.stalledSec = (now - h.moveMs) / 1000;
}

// Measure the Builder's buffer flow by differencing stored FE over real wall-clock time (the
// rg-dashboard / reactor-control pattern — the adapter exposes no per-tick draw field, so this is the
// ONLY way to get one). netFe > 0 = the buffer is filling, < 0 = the Builder is eating more than it is
// fed. Sampled on a floor interval and EMA-smoothed, then deadbanded so integer-FE granularity + poll
// jitter don't make the readout twitch around zero.
function derivePowerFlow(m) {
  if (!HAS_CLOCK) { return; }
  var stored = m.energy ? m.energy.stored : null;
  if (stored == null) { return; }

  var now = Date.now();
  var h = histFor(m.id);
  if (h.lastStored == null) { h.lastStored = stored; h.lastMs = now; return; }   // baseline

  var dt = now - h.lastMs;
  if (dt >= RATE_FLOOR_MS) {
    var sample = (stored - h.lastStored) / (dt / MS_PER_TICK);   // FE per tick, + = charging
    h.ema = (h.ema == null) ? sample : (h.ema + RATE_EMA * (sample - h.ema));
    h.lastStored = stored;
    h.lastMs = now;
  }
  if (h.ema == null) { return; }

  var net = h.ema;
  if (net > -RATE_DEADBAND && net < RATE_DEADBAND) { net = 0; }
  m.netFe = net;

  // How long the buffer lasts at the measured drain — only meaningful while actually net-draining.
  if (net < 0 && stored > 0) { m.powerRunwaySec = stored / (-net * TICKS_PER_SEC); }
}

// The cursor's fraction of the way through the CURRENT layer, raster-estimated over the layer's XZ box
// (X-major: X runs fastest, then Z). APPROXIMATE and DISPLAY ONLY — it exists purely so the progress bar
// creeps smoothly between layer steps instead of jumping. It is NEVER fed into deriveLayerRate, which
// measures only whole, unambiguous layer transitions.
function withinLayer(m) {
  if (!m.scan || !m.min || !m.max) { return 0; }
  if (m.scan.x == null || m.scan.z == null) { return 0; }
  if (m.min.x == null || m.min.z == null || m.max.x == null || m.max.z == null) { return 0; }

  var x0 = Math.min(m.min.x, m.max.x), x1 = Math.max(m.min.x, m.max.x);
  var z0 = Math.min(m.min.z, m.max.z), z1 = Math.max(m.min.z, m.max.z);
  var w = x1 - x0 + 1, d = z1 - z0 + 1;
  if (!(w > 0) || !(d > 0)) { return 0; }

  var ix = clamp(m.scan.x - x0, 0, w - 1);
  var iz = clamp(m.scan.z - z0, 0, d - 1);
  return clamp((iz * w + ix) / (w * d), 0, 1);
}

// Layer accounting + the blended progress bar. layersTotal counts INCLUSIVE of both ends (a 1-block-tall
// region is one layer); layersLeft counts the current layer down to the region floor.
function deriveWork(m) {
  if (!m.hasCard || m.min == null || m.max == null || m.currentLevel == null) { return; }
  if (m.min.y == null || m.max.y == null) { return; }

  var minY = Math.min(m.min.y, m.max.y);
  var maxY = Math.max(m.min.y, m.max.y);
  m.layersTotal = maxY - minY + 1;         // pure region geometry — always safe to report

  // currentLevel only becomes MEANINGFUL once the Builder has actually started sweeping this region. A
  // Builder that has never run reports a stale / zero level, which the adapter's own clamped progress
  // would happily render as a confident "100% done" — so anything outside the region publishes NO
  // progress rather than a lie. minY-1 is the single legitimate out-of-range value: the sweep has run
  // off the bottom, i.e. the job is finished.
  if (m.currentLevel > maxY || m.currentLevel < minY - 1) { return; }
  if (m.currentLevel === minY - 1) { m.layersLeft = 0; m.progress = 1; return; }

  m.layersLeft = m.currentLevel - minY + 1;
  m.progress = clamp(((maxY - m.currentLevel) + withinLayer(m)) / m.layersTotal, 0, 1);
}

// Precedence, most-specific first: a unit that isn't reachable can't say anything about itself; a unit
// whose getStatus threw is an `error` even before we look at its fields; then the documented ladder
// nocard -> lastError -> idle -> stalled -> run.
function deriveState(m) {
  if (!m.online) { return "offline"; }
  if (m.error) { return "error"; }                                     // the read itself failed
  if (!m.hasCard) { return "nocard"; }
  if (m.lastError) { return "error"; }
  if (!m.enabled) { return "idle"; }
  if (m.stalledSec != null && m.stalledSec >= STALL_SEC) { return "stalled"; }
  return "run";
}

function builderSnapshot(dev) {
  var m = newUnit(dev.id, str(dev.label, dev.id), !!dev.online, false);
  if (!dev.online) { delete hist[m.id]; return m; }   // loaded-only invariant: unloaded == offline

  var s;
  try { s = dev.call("getStatus", {}); }
  catch (e) {
    print("builder-control: getStatus failed for " + m.id + " - " + e);
    m.error = true; m.state = "error"; delete hist[m.id]; return m;
  }

  // --- raw passthrough (every getStatus field, coerced to a plain JSON-able value) ---
  m.hasCard      = !!s.hasCard;
  m.card         = str(s.card, "none");
  m.spaceMode    = str(s.spaceMode, null);
  m.enabled      = !!s.enabled;
  m.redstoneMode = str(s.redstoneMode, "ignored");
  m.scan         = xyz(s.scan);
  m.min          = xyz(s.min);
  m.max          = xyz(s.max);
  m.currentLevel = num(s.currentLevel);
  m.lastError    = str(s.lastError, "");
  m.pos          = xyz(s.pos);            // the Builder block's own position (card title + plan-view origin)
  m.dimension    = str(s.dimension, null);
  m.dimensions   = xyz(s.dimensions);     // the shape card's extent…
  m.offset       = xyz(s.offset);         // …and its offset from the Builder
  m.flags        = flagsOf(s.flags);
  m.energy       = tank(s.energy);
  m.energyPct    = pctOf(m.energy);

  // NOTE: s.progress (the adapter's own layer ratio) is deliberately NOT copied — deriveWork recomputes
  // it inclusively and blends the within-layer cursor in, so the bar moves continuously.

  // --- derived (order matters: the rates feed the state, the state feeds the ETA wording) ---
  deriveLayerRate(m);
  deriveStall(m);
  derivePowerFlow(m);
  deriveWork(m);

  var h = hist[m.id];
  m.secPerLayer = h ? h.secPerLayer : null;
  if (m.secPerLayer != null && m.layersLeft != null) { m.etaSec = m.layersLeft * m.secPerLayer; }

  m.state = deriveState(m);
  if (m.state === "run" || m.state === "stalled") {
    m.etaText = (m.etaSec != null) ? fmtSec(m.etaSec) : "measuring...";
  } else {
    m.etaText = "--";                     // idle / offline / no card: an ETA would be a lie
  }
  return m;
}

// Drop measurement history for units that are no longer in the sweep, so a returning Builder re-baselines
// cleanly instead of reporting a bogus jump.
function pruneHistory(units) {
  var live = {};
  for (var i = 0; i < units.length; i++) { live[units[i].id] = true; }
  for (var k in hist) {
    if (Object.prototype.hasOwnProperty.call(hist, k) && !live[k]) { delete hist[k]; }
  }
}

// ===========================================================================================
//  alarms — derived fresh from the snapshot each rebuild (no extra device calls)
// ===========================================================================================

function buildAlarms(units) {
  var out = [];
  function add(level, text) { out.push({ level: level, text: text }); }

  for (var i = 0; i < units.length; i++) {
    var u = units[i];

    if (!u.online) {
      add("warn", u.label + ": " + (u.notFound
        ? "not found on the network — check the Port / wiring"
        : "offline (chunk unloaded or Port removed)"));
      continue;                              // nothing else about an offline unit is knowable
    }
    if (u.error) { add("crit", u.label + ": status read failed"); continue; }

    if (u.lastError) { add("crit", u.label + ": " + u.lastError); }
    if (u.state === "stalled") {
      add("crit", u.label + ": scan cursor stalled " + Math.round(u.stalledSec) + "s");
    }
    if (u.enabled && !u.hasCard) { add("warn", u.label + ": enabled with no shape card"); }

    if (u.energyPct != null) {
      if (u.energyPct < LOW_BUF_PCT) {
        add("crit", u.label + ": buffer " + Math.round(u.energyPct) + "% (floor "
          + LOW_BUF_PCT + "%)");
      } else if (u.energyPct < 25) {
        add("warn", u.label + ": buffer low, " + Math.round(u.energyPct) + "%");
      }
    }

    // The interesting one: the cross-check between the two measured rates. If the buffer empties before
    // the hole is finished, the quarry WILL stop part-way — which no single readout on the sheet says.
    if (u.powerRunwaySec != null && u.etaSec != null && u.powerRunwaySec < u.etaSec) {
      add("crit", u.label + ": power runs out in " + fmtSec(u.powerRunwaySec)
        + ", job needs " + fmtSec(u.etaSec));
    }
  }

  // Crit first, insertion order preserved within a level, capped.
  var crit = [], warn = [], j;
  for (j = 0; j < out.length; j++) { (out[j].level === "crit" ? crit : warn).push(out[j]); }
  var merged = crit.concat(warn);
  if (merged.length === 0) { return [{ level: "none", text: "No active alarms — excavation nominal" }]; }
  return merged.length > ALARM_CAP ? merged.slice(0, ALARM_CAP) : merged;
}

// ===========================================================================================
//  the authoritative state the page renders from
// ===========================================================================================

// The device sweep: either the pinned BUILDERS roster (each name ALWAYS emits a card, offline placeholder
// included) or every rftools_builder auto-discovered on the network.
function sweep() {
  var units = [], i;
  if (BUILDERS.length > 0) {
    for (i = 0; i < BUILDERS.length; i++) {
      var name = BUILDERS[i];
      var dev = network.find(name);
      if (dev && isBuilder(dev) && dev.online) { units.push(builderSnapshot(dev)); }
      else { units.push(newUnit(name, name, false, !dev)); }
    }
  } else {
    var all = network.devices();
    for (i = 0; i < all.length; i++) { if (isBuilder(all[i])) { units.push(builderSnapshot(all[i])); } }
  }
  units.sort(byLabel);
  return units;
}

function buildState() {
  frame++;

  var units = sweep();
  pruneHistory(units);

  // --- selection auto-heals: a vanished selection falls back to the first unit on the board ---
  var i, okSel = false;
  for (i = 0; i < units.length; i++) { if (units[i].id === sel) { okSel = true; break; } }
  if (!okSel) { sel = units.length ? units[0].id : null; }

  // --- fleet aggregate ---
  var fleet = {
    count: units.length, running: 0, stalled: 0, offline: 0,
    storedTotal: null, capacityTotal: null, bufPct: null,
    drawTotal: null, avgProgress: null, etaSec: null, etaText: "--"
  };
  var stored = 0, capacity = 0, anyEnergy = false;
  var draw = 0, anyDraw = false;
  var progSum = 0, progN = 0;
  var etaMax = null, anyWorking = false;

  for (i = 0; i < units.length; i++) {
    var u = units[i];
    if (!u.online) { fleet.offline++; }
    if (u.state === "run") { fleet.running++; }
    if (u.state === "stalled") { fleet.stalled++; }
    if (u.state === "run" || u.state === "stalled") { anyWorking = true; }

    if (u.energy) {
      if (u.energy.stored != null) { stored += u.energy.stored; anyEnergy = true; }
      if (u.energy.capacity != null) { capacity += u.energy.capacity; anyEnergy = true; }
    }
    if (u.netFe != null) { draw += u.netFe; anyDraw = true; }
    if (u.progress != null) { progSum += u.progress; progN++; }
    if (u.etaSec != null && (etaMax == null || u.etaSec > etaMax)) { etaMax = u.etaSec; }
  }
  if (anyEnergy) {
    fleet.storedTotal = stored;
    fleet.capacityTotal = capacity;
    fleet.bufPct = pctOf({ stored: stored, capacity: capacity });
  }
  if (anyDraw) { fleet.drawTotal = (draw > -RATE_DEADBAND && draw < RATE_DEADBAND) ? 0 : draw; }
  if (progN > 0) { fleet.avgProgress = progSum / progN; }

  // The fleet ETA is the SLOWEST unit — when the whole job is done, not the average.
  fleet.etaSec = etaMax;
  fleet.etaText = (etaMax != null) ? fmtSec(etaMax) : (anyWorking ? "measuring..." : "--");

  var alarms = buildAlarms(units);

  var ok = units.length > 0;
  return {
    ok: ok,
    reason: ok ? null : "No RFTools Builder on the network. Mount a Silica Port on a Builder and wire it to this computer (a NIC adds wireless) — or list names in BUILDERS at the top of entrypoint.js.",
    frame: frame,
    sel: sel,
    units: units,
    fleet: fleet,
    alarms: alarms,
    log: logEntries.slice(0),
    last: lastAction
  };
}

// Fresh build: device sweep, cache it, publish it.
function push() { lastSnapshot = buildState(); web.setState(lastSnapshot); }

// ===========================================================================================
//  control (server holds ALL authority; every request is re-validated against a live device)
// ===========================================================================================

// Resolve a control target and confirm it is a real, ONLINE rftools_builder. Returns the Device, or null
// after recording a rejection into lastAction + the log.
function resolveTarget(id, action) {
  var dev = (typeof id === "string" && id) ? network.find(id) : null;
  if (!dev || !isBuilder(dev) || !dev.online) {
    lastAction = { action: action, target: str(id, "?"), ok: false, text: "Invalid or offline Builder target." };
    logPush(false, action + ": invalid or offline Builder target");
    print("builder-control: ignored " + action + " for invalid/offline target " + id);
    return null;
  }
  return dev;
}

function nameOf(dev) { return str(dev.label, dev.id); }

function record(action, dev, ok, text) {
  lastAction = { action: action, target: dev ? nameOf(dev) : null, ok: !!ok, text: text };
  logPush(ok, text);
}

function ackText(dev, action, ack) {
  var label = nameOf(dev);
  switch (action) {
    case "start":           return label + ": start -> enabled=" + !!(ack && ack.enabled);
    case "stop":            return label + ": stop -> enabled=" + !!(ack && ack.enabled);
    case "restart":         return label + ": restart -> rescanning from the top";
    case "setRedstoneMode": return label + ": redstone -> " + str(ack && ack.redstoneMode, "?");
    case "setFlags":        return label + ": flags updated";
    default:                return label + ": " + action;
  }
}

// One unit verb: build the args, fire, translate the ack. `restart` answers {ok:false,error} instead of
// throwing (E4-D13), so it is normalised into the same failure path as a thrown call.
function callUnit(action, dev, args) {
  try {
    var ack = dev.call(action, args || {});
    if (action === "restart" && ack && ack.ok === false) {
      record(action, dev, false, nameOf(dev) + ": restart refused — " + str(ack.error, "?"));
      return;
    }
    record(action, dev, true, ackText(dev, action, ack));
    print("builder-control: " + action + " -> " + nameOf(dev));
  } catch (e) {
    record(action, dev, false, nameOf(dev) + ": " + action + " refused — " + e);
    print("builder-control: " + action + " refused for " + nameOf(dev) + " - " + e);
  }
}

// Master trip / master arm. Sweeps the live network itself (never the cached snapshot) so it can only
// ever touch devices that are genuinely there right now.
function bulk(action, verb) {
  var all = network.devices();
  var hit = 0, fail = 0;
  for (var i = 0; i < all.length; i++) {
    var dev = all[i];
    if (!isBuilder(dev) || !dev.online) { continue; }
    if (BUILDERS.length > 0 && !isPinned(dev)) { continue; }   // pinned board => pinned fleet
    try {
      dev.call(verb, {});
      hit++;
    } catch (e) {
      fail++;
      print("builder-control: " + action + " " + verb + " failed for " + nameOf(dev) + " - " + e);
    }
  }
  var text = (verb === "stop" ? "STOP ALL" : "START ALL") + ": " + hit + " unit"
    + (hit === 1 ? "" : "s") + " " + verb + "ped" + (fail ? ", " + fail + " FAILED" : "");
  lastAction = { action: action, target: null, ok: fail === 0, text: text };
  logPush(fail === 0, text);
  print("builder-control: " + text);
}

// Is this device on the pinned roster? (id OR label — BUILDERS holds whichever name the operator typed.)
function isPinned(dev) {
  for (var i = 0; i < BUILDERS.length; i++) {
    if (BUILDERS[i] === dev.id || BUILDERS[i] === dev.label) { return true; }
  }
  return false;
}

function handle(msg) {
  if (!msg || typeof msg.action !== "string") { return; }
  var a = msg.action;

  if (a === "poll") { return; }

  if (a === "select") {
    var id = str(msg.id, null);
    var d = id ? network.find(id) : null;
    if (!d || !isBuilder(d)) {
      // A pinned-but-offline unit has no Device at all, yet it still owns a card — let it be selected so
      // its offline placeholder can be inspected.
      if (id && BUILDERS.length > 0 && isPinnedName(id)) { sel = id; return; }
      lastAction = { action: a, target: str(id, "?"), ok: false, text: "Unknown Builder." };
      return;
    }
    sel = d.id;
    return;
  }

  if (a === "stopAll") { bulk(a, "stop"); return; }
  if (a === "startAll") { bulk(a, "start"); return; }

  if (a === "start" || a === "stop" || a === "restart") {
    var dev = resolveTarget(msg.target, a);
    if (!dev) { return; }
    callUnit(a, dev, {});
    return;
  }

  if (a === "setRedstoneMode") {
    var dr = resolveTarget(msg.target, a);
    if (!dr) { return; }
    var mode = str(msg.mode, null);
    if (RS_MODES.indexOf(mode) < 0) {   // the adapter would throw; reject it here with a clearer line
      record(a, dr, false, nameOf(dr) + ": unknown redstone mode " + str(msg.mode, "?"));
      return;
    }
    callUnit(a, dr, { mode: mode });
    return;
  }

  if (a === "setFlags") {
    var df = resolveTarget(msg.target, a);
    if (!df) { return; }
    var f = msg.flags || {};
    var args = {}, n = 0;
    for (var i = 0; i < FLAG_KEYS.length; i++) {
      var k = FLAG_KEYS[i];
      if (typeof f[k] === "boolean") { args[k] = f[k]; n++; }   // absent key == leave that flag alone
    }
    if (n === 0) { record(a, df, false, nameOf(df) + ": no flags given."); return; }
    callUnit(a, df, args);
    return;
  }
  // Any unrecognised action is a no-op here; the run loop still publishes fresh state.
}

// Bare-name membership test for the pinned roster (used before any Device exists).
function isPinnedName(name) {
  for (var i = 0; i < BUILDERS.length; i++) { if (BUILDERS[i] === name) { return true; } }
  return false;
}

// ===========================================================================================
//  the server clock (see SWEEP_MS)
// ===========================================================================================

// Re-arm the deadline from NOW — never `nextSweepMs += SWEEP_MS`. After a lag spike or a slow Builder
// sweep the next cycle is simply late; it never queues a catch-up BURST of sweeps into an already
// struggling tick thread.
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
// not restart the clock (that is what would let a steady poll stream stretch the rate samples out of
// shape — the timeout is an absolute deadline armed once per call, not a per-message idle timer). Capped
// at SWEEP_MS so a backwards clock jump can't park us for hours; floored at 0, and pullEvent itself
// rounds any value up to one whole game tick, so this loop can never busy-spin.
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
push();                          // initial render (fresh build)
markSwept();

while (true) {
  // null on timeout. NOT a plain pullEvent: with nobody watching, no web_message is ever produced, and
  // the measured rates would then stop advancing (and restart from a stale baseline on the next viewer).
  var ev = os.pullEvent("web_message", waitSeconds());

  if (ev) {
    msgsSinceSweep++;
    var msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { msg = null; }
    var action = msg && msg.action;

    if (action && action !== "poll") {
      // Control action — immediate, never debounced and never served from the cache: handle() re-resolves
      // and re-reads its target live, then we rebuild + publish at once. Re-arming the clock here is what
      // stops a button press and the tick behind it from sweeping the Builders twice.
      handle(msg);
      push();
      markSwept();
      continue;
    }

    // Bare poll / heartbeat / unparsable frame — re-publish what the clock already built. ZERO device
    // calls, so the number of viewers cannot change the device-call rate at all.
    if (lastSnapshot) { web.setState(lastSnapshot); }
  }

  // The clock tick: the fresh Builder sweep, and the only place the measured rates take a sample.
  // `!ev` = the timeout fired; sweepDue() = a message woke us early but the deadline has since passed.
  if (!ev || sweepDue()) {
    push();
    markSwept();
  }
}
