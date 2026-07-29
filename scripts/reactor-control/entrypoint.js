// reactor-control/entrypoint.js — server-side entry for the Reactor Control Room (multi-file Path B).
//
// A fission-reactor control room that ALSO reads Refined Storage for fuel logistics. It watches every
// Mekanism fission reactor + industrial turbine reachable on this computer's Silica network, plus the
// first reachable Refined Storage network, and publishes one authoritative snapshot per rebuild:
//
//   * per-reactor telemetry + fuel / waste RUNWAY (how many seconds until the tank runs dry, and until
//     the waste tank backs up and stalls the reactor)
//   * per-turbine telemetry + a MEASURED FE/t buffer flow (charging / draining) with time-to-empty /
//     time-to-full, derived by differencing the buffer over real wall-clock time
//   * RS fuel logistics: how much fissile fuel the storage network is actually holding, read live as a
//     CHEMICAL (see FUEL_CHEMICAL below) — a real reading, not a precursor estimate
//   * a server-authoritative auto-scram safety interlock, alarms, and a rolling event log
//
// ALL capability access is here on the server. The page holds NO authority — it only *requests* actions
// via mc.send, and this script re-validates every request (client messages are untrusted input): a
// control only fires against a target that is a real, ONLINE device OF THE MATCHING KIND, re-resolved
// live each time. Any Mekanism / RS call that throws is caught and surfaced back as a status line.
//
// Capability doors: network (needs a NIC) + web (needs web-display). Mekanism blocks and the RS
// Controller are reached as ordinary network devices via mounted Silica Ports; no extra door.
//
// Set up: a smart computer (SilicaOS ROM + GPU + web-display) with a NIC; mount a Silica Port on each
// reactor Logic-Adapter / Casing / Port, each turbine Valve / Casing / Vent, and on (or beside) your RS
// Controller, and wire them all to the computer (adjacent, or via a Switch / Router → Receiver). Run
// this from the Runner and stream it to a named monitor, or open the pad / pocket view.

// ===========================================================================================
//  TUNABLE CONFIG — edit this block to match YOUR pack
// ===========================================================================================

// Fissile fuel is a Mekanism CHEMICAL. A Refined Storage network with chemical storage holds it
// directly, so the reserve is READ, not inferred: one filtered listChemicals per RS refresh, summing
// the rows whose registry id matches this exactly. Point it at whatever chemical your reactors burn.
// Needs a Silica RS integration jar new enough to expose `listChemicals` (see README).
var FUEL_CHEMICAL = "mekanism:fissile_fuel";

// --- auto-scram safety interlock (server-authoritative in BOTH state and cadence) ---
// Evaluated on every sweep — i.e. once a second on the server's own clock, whether or not a single player
// is watching the page or even loaded in this dimension (see SWEEP_MS). No extra device reads. Trip set:
// reactor coolant < coolantMinPct, reactor damage > damageMaxPct, reactor waste >= wasteMaxPct,
// turbine energy >= turbineEnergyMaxPct. On ANY trip we scram every currently-active reactor.
// Runtime-toggleable from the page via {action:"setSafety", enabled}.
var SAFETY_ENABLED = true;
var SAFETY = { coolantMinPct: 50, damageMaxPct: 10, wasteMaxPct: 90, turbineEnergyMaxPct: 99 };

// --- the server clock: WHY THIS APP DOES NOT WAIT ON THE PAGE ---
// The run loop advances on the SERVER's own clock, not on viewer polls. A `web_message` exists only while
// some player's browser is running this page, so a plain os.pullEvent("web_message") parks FOREVER in an
// empty world — and the auto-scram interlock below, which used to be evaluated only when a message came
// in, stopped running with it. That is not hypothetical: a fission reactor melted down while its operator
// was in the Nether. The interlock's STATE was server-authoritative; its CADENCE was borrowed from the
// client. os.pullEvent(filter, seconds) returns null on timeout, which lets this loop keep its own clock.
//
// The resulting shape (see the run loop at the bottom of the file):
//   * exactly ONE authoritative Mekanism sweep per SWEEP_MS — with a hundred viewers or with nobody in
//     the dimension. That single sweep is what the interlock runs on;
//   * a bare poll only re-publishes the CACHED snapshot: zero device.calls, so viewer count cannot move
//     the device-call rate at all (the E4-P1 lesson — a device.call runs on the server TICK THREAD, and a
//     flood of them froze a live server hard enough that no computer could be stopped);
//   * a control action still rebuilds immediately against freshly-read state, then re-arms the clock.
// The RS read is far cheaper to skip (fuel stock moves slowly), so it refreshes only every
// RS_REBUILD_EVERY *sweeps* and is cached in between.
var SWEEP_MS = 1000;          // one authoritative device sweep per second, viewer or no viewer
var RS_REBUILD_EVERY = 5;     // Refined Storage read: at most every 5th Mekanism sweep
var NOCLOCK_SWEEP_EVERY = 2;  // no Date.now() at all (see HAS_CLOCK): sweep every 2nd message instead

// --- turbine flow measurement (wall-clock differencing; see HAS_CLOCK below) ---
var RATE_FLOOR_MS = 500;          // ignore samples closer together than this (a control burst can bunch them)
var RATE_CEIL_MS = SWEEP_MS * 5;  // ...and DISCARD any sample spanning longer (see deriveTurbineFlow)
var RATE_EMA = 0.3;               // weight of the newest sample in the smoothed rate
var RATE_DEADBAND = 0.5;          // |FE/t| below this reads as 0 (integer-FE granularity + sweep jitter)

// --- display caps ---
var ALARM_CAP = 6;            // alarms[]
var LOG_CAP = 8;              // log[]

// ===========================================================================================
//  constants (do not edit)
// ===========================================================================================
// These are Silica PERIPHERAL KINDS, not Minecraft block ids. A kind is a label the integration
// jar reports in Java (RefinedStorageAdapter.kind(), MekFissionReactorAdapter.kind(), ...) and is
// what network.devices() puts in dev.kind. Changing these strings cannot make Silica find a
// different block -- it only stops it matching the block it already sees.

var K_REACTOR = "mekanism_fission_reactor";
var K_TURBINE = "mekanism_turbine";
var K_RS = "refinedstorage_network";

var DUMP_MODES = ["IDLE", "DUMPING_EXCESS", "DUMPING"];   // turbine dump-mode cycle order

var TICKS_PER_SEC = 20;
var MS_PER_TICK = 50;

// The RS adapter's listChemicals takes the same optional case-insensitive substring filter as
// listFluids, so the SERVER does the filtering: send the fuel's path (namespace stripped) and match the
// full id exactly on the way back.
var FUEL_FILTER = String(FUEL_CHEMICAL).replace(/^[^:]*:/, "");

// Date.now() is a plain ECMAScript intrinsic (no host access) and DOES work in the Silica GraalJS
// sandbox — docs/examples/rg-dashboard/entrypoint.js is the proven precedent. Guarded anyway: if it is
// ever unavailable, every measured turbine rate degrades to null instead of throwing.
var HAS_CLOCK = (typeof Date !== "undefined" && typeof Date.now === "function");

// ===========================================================================================
//  coercion helpers — web.setState needs PLAIN JSON-able values (a getStatus result is a host proxy)
// ===========================================================================================

function num(v) { return (typeof v === "number" && isFinite(v)) ? v : null; }
function str(v, dflt) { return (typeof v === "string" && v.length) ? v : dflt; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// A {stored,capacity} tank -> a plain always-present {stored,capacity} (both null when absent), so the
// page can read t.stored unconditionally.
function tank(t) {
  if (!t) { return { stored: null, capacity: null }; }
  return { stored: num(t.stored), capacity: num(t.capacity) };
}

// {stored,capacity} -> 0..100, or null when it can't be computed (missing tank / zero capacity).
function pctOf(t) {
  if (!t || t.capacity == null || !(t.capacity > 0) || t.stored == null) { return null; }
  return t.stored / t.capacity * 100;
}

function isReactorDev(dev) { return dev && dev.kind === K_REACTOR; }
function isTurbineDev(dev) { return dev && dev.kind === K_TURBINE; }

function byLabel(a, b) { return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0); }

// ===========================================================================================
//  session state (server-authoritative; the page only ever reflects this back)
// ===========================================================================================

var frame = 0;               // increments on every fresh rebuild; the safety "at" stamp + log prefix
var lastAction = null;       // { action, target, ok, text } — sticky status line
var lastSnapshot = null;     // cached authoritative state, re-published to bare polls (no device.calls)
var nextSweepMs = 0;         // wall-clock deadline for the next authoritative sweep (see markSwept)
var msgsSinceSweep = 0;      // clock-free fallback gate only (see sweepDue)
var rebuildsSinceRs = 0;     // fresh rebuilds since the last Refined Storage read
var rsCache = null;          // cached RS-derived half of the fuel block (see readRefinedStorage)
var selReactor = null;       // id of the reactor the detail panel + controls address
var selTurbine = null;       // id of the turbine the detail panel + controls address
var turbHist = {};           // id -> { lastStored, lastMs, ema }  (ema = smoothed net FE/tick)
var logEntries = [];         // [{ ok, text }] newest first, capped at LOG_CAP

// A short frame stamp keeps otherwise-identical repeated events distinguishable in the log.
function logPush(ok, text) {
  logEntries.unshift({ ok: !!ok, text: "[" + frame + "] " + text });
  if (logEntries.length > LOG_CAP) { logEntries.length = LOG_CAP; }
}

// ===========================================================================================
//  per-device snapshots — every field copied explicitly, one bad device can never sink the board
// ===========================================================================================

function newReactor(dev) {
  return {
    id: dev.id, label: str(dev.label, dev.id), online: !!dev.online, error: false, formed: false,
    active: false, burning: false,
    temperature: null, damage: null, burnRate: null, rateLimit: null, maxBurnRate: null,
    environmentalLoss: null, boilEfficiency: null,
    fuel: tank(null), coolant: tank(null), heatedCoolant: tank(null), waste: tank(null),
    fuelPct: null, coolantPct: null, heatedPct: null, wastePct: null,
    fuelSeconds: null, wasteSeconds: null
  };
}

function newTurbine(dev) {
  return {
    id: dev.id, label: str(dev.label, dev.id), online: !!dev.online, error: false, formed: false,
    active: false,
    production: null, maxProduction: null, flowRate: null, maxFlow: null,
    steam: tank(null), steamPct: null,
    dumping: "IDLE", blades: null, coils: null, condensers: null, vents: null, dispersers: null,
    energy: tank(null), energyPct: null,
    net: null, draw: null, secondsToEmpty: null, secondsToFull: null
  };
}

function reactorSnapshot(dev) {
  var m = newReactor(dev);
  if (!dev.online) { return m; }   // loaded-only invariant: unloaded == offline, a call would throw

  var s;
  try { s = dev.call("getStatus", {}); }
  catch (e) { print("reactor-control: getStatus failed for " + m.id + " - " + e); m.error = true; return m; }

  m.formed = !!s.formed;
  if (!m.formed) { return m; }
  m.active = !!s.active;
  m.burning = !!s.burning;
  m.temperature = num(s.temperature);
  m.damage = num(s.damage);
  m.burnRate = num(s.burnRate);
  m.rateLimit = num(s.rateLimit);
  m.maxBurnRate = num(s.maxBurnRate);
  m.environmentalLoss = num(s.environmentalLoss);
  m.boilEfficiency = num(s.boilEfficiency);
  m.fuel = tank(s.fuel);
  m.coolant = tank(s.coolant);
  m.heatedCoolant = tank(s.heatedCoolant);
  m.waste = tank(s.waste);

  m.fuelPct = pctOf(m.fuel);
  m.coolantPct = pctOf(m.coolant);
  m.heatedPct = pctOf(m.heatedCoolant);
  m.wastePct = pctOf(m.waste);

  // --- runway math (deterministic; burn rate is mB/TICK and Minecraft runs 20 ticks/s) ---
  // Only meaningful while the reactor is actually burning fuel down.
  var burning = m.active && m.burnRate != null && m.burnRate > 0;
  if (burning && m.fuel.stored != null) {
    m.fuelSeconds = m.fuel.stored / m.burnRate / TICKS_PER_SEC;
  }
  // A FULL waste tank stalls the reactor just as hard as an empty fuel tank — so the headroom runway is
  // a genuine operational number, not a curiosity. Surfaced per-reactor and MIN'd into runway.wasteSeconds.
  if (burning && m.waste.stored != null && m.waste.capacity != null) {
    var head = m.waste.capacity - m.waste.stored;
    if (head < 0) { head = 0; }
    m.wasteSeconds = head / m.burnRate / TICKS_PER_SEC;
  }
  return m;
}

// Measure the turbine's buffer flow by differencing stored FE over real wall-clock time (the
// rg-dashboard pattern). `net` > 0 = the buffer is filling, < 0 = the grid is pulling more out than the
// turbine makes. `draw` = production - net = what is actually LEAVING the turbine into the grid.
// Sampled on a floor interval (so a burst of control rebuilds can't collapse the window), DISCARDED above
// a ceiling interval (see below), and EMA-smoothed (so integer-FE granularity + sweep jitter don't make
// the readout dance).
function deriveTurbineFlow(m) {
  if (!HAS_CLOCK) { return; }                        // degrade to nulls, never throw
  var stored = m.energy ? m.energy.stored : null;
  if (stored == null || !m.online || !m.formed) { delete turbHist[m.id]; return; }

  var now = Date.now();
  var h = turbHist[m.id];
  if (!h) { turbHist[m.id] = { lastStored: stored, lastMs: now, ema: null }; return; }   // baseline

  var dt = now - h.lastMs;
  if (dt > RATE_CEIL_MS) {
    // STALE DIFF GUARD. Differencing assumes regular samples. Under the old viewer-driven loop the first
    // sample after an absence spanned the WHOLE absence, so the operator's first glance after an hour away
    // got an hour-wide average presented as a live FE/t — a garbage number at exactly the worst moment.
    // The server clock makes that mostly moot, but a lag spike, a long sweep, or a [logging] debug stall
    // can still stretch a window. Anything past 5x the sweep period is no longer a measurement of the
    // turbine, it is a measurement of the stall: re-baseline and publish nothing until the clock is honest
    // again (one cycle later). Failing to "—" is correct here; failing to a plausible-looking wrong number
    // is what we are preventing.
    h.lastStored = stored;
    h.lastMs = now;
    h.ema = null;
    return;
  }
  if (dt >= RATE_FLOOR_MS) {
    var sample = (stored - h.lastStored) / (dt / MS_PER_TICK);   // FE per tick, + = charging
    h.ema = (h.ema == null) ? sample : (h.ema + RATE_EMA * (sample - h.ema));
    h.lastStored = stored;
    h.lastMs = now;
  }
  if (h.ema == null) { return; }

  var net = h.ema;
  if (net > -RATE_DEADBAND && net < RATE_DEADBAND) { net = 0; }
  m.net = net;

  if (m.production != null) {
    var d = m.production - net;
    m.draw = (d > -RATE_DEADBAND && d < RATE_DEADBAND) ? 0 : d;
  }
  if (net < 0 && stored > 0) {
    m.secondsToEmpty = stored / (-net * TICKS_PER_SEC);
  } else if (net > 0 && m.energy.capacity != null && m.energy.capacity > stored) {
    m.secondsToFull = (m.energy.capacity - stored) / (net * TICKS_PER_SEC);
  }
}

function turbineSnapshot(dev) {
  var m = newTurbine(dev);
  if (!dev.online) { delete turbHist[m.id]; return m; }

  var s;
  try { s = dev.call("getStatus", {}); }
  catch (e) {
    print("reactor-control: getStatus failed for " + m.id + " - " + e);
    m.error = true; delete turbHist[m.id]; return m;
  }

  m.formed = !!s.formed;
  if (!m.formed) { delete turbHist[m.id]; return m; }
  m.active = !!s.active;
  m.production = num(s.production);
  m.maxProduction = num(s.maxProduction);
  m.flowRate = num(s.flowRate);
  m.maxFlow = num(s.maxFlow);
  m.steam = tank(s.steam);
  m.dumping = str(s.dumping, "IDLE");
  m.blades = num(s.blades);
  m.coils = num(s.coils);
  m.condensers = num(s.condensers);
  m.vents = num(s.vents);
  m.dispersers = num(s.dispersers);
  m.energy = tank(s.energy);

  m.steamPct = pctOf(m.steam);
  m.energyPct = pctOf(m.energy);
  deriveTurbineFlow(m);
  return m;
}

// Drop rate history for turbines that are no longer on the network, so a returning turbine re-baselines
// cleanly instead of reporting a bogus jump.
function pruneTurbineHistory(turbines) {
  var live = {};
  for (var i = 0; i < turbines.length; i++) { live[turbines[i].id] = true; }
  for (var k in turbHist) {
    if (Object.prototype.hasOwnProperty.call(turbHist, k) && !live[k]) { delete turbHist[k]; }
  }
}

// ===========================================================================================
//  Refined Storage — fuel logistics (cached; refreshed every RS_REBUILD_EVERY rebuilds)
// ===========================================================================================

function emptyRs(reason) {
  return {
    ok: false, reason: reason,
    networkId: null, networkLabel: null, connected: false,
    rsEnergy: null, reserveMb: 0
  };
}

// ONE getStatus + ONE filtered listChemicals per RS refresh. Never an unfiltered list (frozen rule).
function readRefinedStorage(all) {
  var found = null, anyRs = false;
  for (var i = 0; i < all.length; i++) {
    if (all[i] && all[i].kind === K_RS) {
      anyRs = true;
      if (all[i].online) { found = all[i]; break; }   // first ONLINE network wins
    }
  }
  if (!found) {
    return emptyRs(anyRs
      ? "Refined Storage network is offline (chunk unloaded or Controller removed)."
      : "No Refined Storage network reachable. Mount a Silica Port on your RS Controller and wire it in.");
  }

  var out = {
    ok: true, reason: null,
    networkId: found.id, networkLabel: str(found.label, found.id), connected: false,
    rsEnergy: null, reserveMb: 0
  };

  var status = null;
  try { status = found.call("getStatus", {}); }
  catch (e) {
    print("reactor-control: RS getStatus failed - " + e);
    out.ok = false; out.reason = "Refined Storage read failed — " + e;
    return out;
  }
  out.connected = !!(status && status.connected);
  var en = status ? status.energy : null;
  if (en) {
    var es = num(en.stored), ec = num(en.capacity);
    out.rsEnergy = { stored: es, capacity: ec, pct: pctOf({ stored: es, capacity: ec }) };
  }
  if (!out.connected) {
    out.ok = false;
    out.reason = "Refined Storage Controller is not connected to a network.";
    return out;
  }

  // The fissile-fuel reserve, read straight out of the network's chemical storage. `amount` is mB, so
  // it drops into the runway maths with no conversion at all.
  var rows = [];
  try { rows = found.call("listChemicals", { filter: FUEL_FILTER }) || []; }
  catch (e2) {
    print("reactor-control: RS listChemicals failed - " + e2);
    out.ok = false;
    out.reason = "Cannot read " + FUEL_CHEMICAL + " — needs an RS integration jar with listChemicals."
      + " (" + e2 + ")";
    return out;
  }

  var reserve = 0;
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    if (!row || row.id !== FUEL_CHEMICAL) { continue; }   // the filter is a substring; the id is exact
    reserve += num(row.amount) || 0;
  }
  out.reserveMb = reserve;
  return out;
}

// ===========================================================================================
//  auto-scram safety interlock (server-authoritative, zero extra device reads in the read path)
// ===========================================================================================

// Trips (evaluated against the just-built snapshots):
//   reactor (online + formed + active): coolant% < coolantMinPct, damage > damageMaxPct,
//                                       waste% >= wasteMaxPct
//   turbine (online + formed):          energy% >= turbineEnergyMaxPct
// On ANY trip we scram every currently-active reactor (each call re-resolved live + try/caught). Only
// active reactors are touched, so once they are down the interlock stops firing.
//
// DELIBERATELY NOT A TRIP: a reactor whose fuel tank has run empty while active. Mekanism simply idles
// the reactor when it has nothing to burn — it is not a hazard, it does not damage anything, and
// scramming would only force the operator to walk over and re-activate it once fuel arrives. That case
// raises a `warn` alarm instead (see buildAlarms).
function evaluateSafety(reactors, turbines) {
  var result = {
    enabled: SAFETY_ENABLED, tripped: false, reason: null, at: frame,
    limits: {
      coolantMinPct: SAFETY.coolantMinPct,
      damageMaxPct: SAFETY.damageMaxPct,
      wasteMaxPct: SAFETY.wasteMaxPct,
      turbineEnergyMaxPct: SAFETY.turbineEnergyMaxPct
    }
  };
  if (!SAFETY_ENABLED) { return result; }

  var reason = null;
  var i;
  for (i = 0; i < reactors.length && reason == null; i++) {
    var d = reactors[i];
    if (!d.online || !d.formed || !d.active) { continue; }
    if (d.coolantPct != null && d.coolantPct < SAFETY.coolantMinPct) {
      reason = "AUTO-SCRAM: " + d.label + " coolant " + Math.round(d.coolantPct) + "% < " + SAFETY.coolantMinPct + "%";
    } else if (d.damage != null && d.damage > SAFETY.damageMaxPct) {
      reason = "AUTO-SCRAM: " + d.label + " damage " + Math.round(d.damage) + "% > " + SAFETY.damageMaxPct + "%";
    } else if (d.wastePct != null && d.wastePct >= SAFETY.wasteMaxPct) {
      reason = "AUTO-SCRAM: " + d.label + " waste " + Math.round(d.wastePct) + "% >= " + SAFETY.wasteMaxPct + "%";
    }
  }
  for (i = 0; i < turbines.length && reason == null; i++) {
    var t = turbines[i];
    if (!t.online || !t.formed) { continue; }
    if (t.energyPct != null && t.energyPct >= SAFETY.turbineEnergyMaxPct) {
      reason = "AUTO-SCRAM: " + t.label + " turbine energy " + Math.round(t.energyPct) + "% >= " + SAFETY.turbineEnergyMaxPct + "%";
    }
  }
  if (reason == null) { return result; }   // all clear

  result.tripped = true;
  result.reason = reason;
  var scrammed = 0, failed = 0;
  for (i = 0; i < reactors.length; i++) {
    var rd = reactors[i];
    if (!rd.online || !rd.formed || !rd.active) { continue; }
    var live = network.find(rd.id);
    if (!live || !isReactorDev(live) || !live.online) { continue; }
    try {
      live.call("scram", {});
      scrammed++;
      print("reactor-control: " + reason + " -> scrammed " + rd.label);
    } catch (e) {
      failed++;
      print("reactor-control: AUTO-SCRAM failed to scram " + rd.label + " - " + e);
    }
  }
  lastAction = { action: "auto-scram", target: reason, ok: failed === 0, text: reason };
  logPush(failed === 0, reason + " (" + scrammed + " scrammed" + (failed ? ", " + failed + " FAILED" : "") + ")");
  return result;
}

// ===========================================================================================
//  alarms — derived fresh from the snapshot each rebuild (no extra device calls)
// ===========================================================================================

function buildAlarms(reactors, turbines, fuel, runway, safety) {
  var out = [];
  function add(level, text) { out.push({ level: level, text: text }); }
  var i, d;

  if (safety.tripped && safety.reason) { add("crit", safety.reason); }

  for (i = 0; i < reactors.length; i++) {
    d = reactors[i];
    if (!d.online || !d.formed) { continue; }
    if (d.coolantPct != null) {
      if (d.coolantPct < SAFETY.coolantMinPct) {
        add("crit", d.label + ": coolant " + Math.round(d.coolantPct) + "% (limit " + SAFETY.coolantMinPct + "%)");
      } else if (d.coolantPct < SAFETY.coolantMinPct + 15) {
        add("warn", d.label + ": coolant low, " + Math.round(d.coolantPct) + "%");
      }
    }
    if (d.damage != null) {
      if (d.damage > SAFETY.damageMaxPct) {
        add("crit", d.label + ": damage " + Math.round(d.damage) + "% (limit " + SAFETY.damageMaxPct + "%)");
      } else if (d.damage > SAFETY.damageMaxPct / 2) {
        add("warn", d.label + ": damage rising, " + Math.round(d.damage) + "%");
      }
    }
    if (d.wastePct != null) {
      if (d.wastePct >= SAFETY.wasteMaxPct) {
        add("crit", d.label + ": waste " + Math.round(d.wastePct) + "% (limit " + SAFETY.wasteMaxPct + "%)");
      } else if (d.wastePct > 75) {
        add("warn", d.label + ": waste backing up, " + Math.round(d.wastePct) + "%");
      }
    }
    // Fuel-starved: NOT a scram (see evaluateSafety) — the reactor simply idles until fuel arrives.
    if (d.active && d.fuel.stored != null && d.fuel.stored <= 0) {
      add("warn", d.label + ": fuel tank empty — reactor idling");
    }
  }

  for (i = 0; i < turbines.length; i++) {
    d = turbines[i];
    if (!d.online || !d.formed) { continue; }
    if (d.energyPct != null && d.energyPct >= SAFETY.turbineEnergyMaxPct) {
      add("crit", d.label + ": buffer " + Math.round(d.energyPct) + "% (limit " + SAFETY.turbineEnergyMaxPct + "%) — grid not drawing");
    }
  }

  if (runway.burnRate != null && runway.burnRate > 0 && runway.totalSeconds != null) {
    if (runway.totalSeconds < 60) {
      add("crit", "Fuel runway " + Math.round(runway.totalSeconds) + "s — reactors will starve");
    } else if (runway.totalSeconds < 300) {
      add("warn", "Fuel runway " + Math.round(runway.totalSeconds / 60) + " min");
    }
  }
  if (runway.wasteSeconds != null && runway.wasteSeconds < 60) {
    add("crit", "Waste tank full in " + Math.round(runway.wasteSeconds) + "s — reactor will stall");
  }

  if (!fuel.ok) { add("warn", "Fuel logistics: " + str(fuel.reason, "Refined Storage unavailable")); }
  else if (!fuel.connected) { add("warn", "Refined Storage network disconnected"); }

  var bad = 0;
  for (i = 0; i < reactors.length; i++) {
    d = reactors[i];
    if (!d.online || d.error || !d.formed) { bad++; }
  }
  for (i = 0; i < turbines.length; i++) {
    d = turbines[i];
    if (!d.online || d.error || !d.formed) { bad++; }
  }
  if (bad > 0) { add("warn", bad + " device" + (bad === 1 ? "" : "s") + " offline / unformed / erroring"); }

  // Crit first, insertion order preserved within a level, capped.
  var crit = [], warn = [];
  for (i = 0; i < out.length; i++) { (out[i].level === "crit" ? crit : warn).push(out[i]); }
  var merged = crit.concat(warn);
  return merged.length > ALARM_CAP ? merged.slice(0, ALARM_CAP) : merged;
}

// ===========================================================================================
//  the authoritative state the page renders from
// ===========================================================================================

function buildState() {
  frame++;

  var all = network.devices();
  var reactors = [], turbines = [];
  var i;
  for (i = 0; i < all.length; i++) {
    if (isReactorDev(all[i])) { reactors.push(reactorSnapshot(all[i])); }
    else if (isTurbineDev(all[i])) { turbines.push(turbineSnapshot(all[i])); }
  }
  reactors.sort(byLabel);
  turbines.sort(byLabel);
  pruneTurbineHistory(turbines);

  // --- selections auto-heal: a vanished selection falls back to the first device of that kind ---
  var okSel = false;
  for (i = 0; i < reactors.length; i++) { if (reactors[i].id === selReactor) { okSel = true; break; } }
  if (!okSel) { selReactor = reactors.length ? reactors[0].id : null; }
  okSel = false;
  for (i = 0; i < turbines.length; i++) { if (turbines[i].id === selTurbine) { okSel = true; break; } }
  if (!okSel) { selTurbine = turbines.length ? turbines[0].id : null; }

  // --- safety interlock: runs against the just-read snapshot, may auto-scram, before we publish ---
  var safety = evaluateSafety(reactors, turbines);

  // --- Refined Storage (cached; the RS read is far cheaper to skip than the Mekanism sweep) ---
  rebuildsSinceRs++;
  if (!rsCache || rebuildsSinceRs >= RS_REBUILD_EVERY) {
    rsCache = readRefinedStorage(all);   // reuse this rebuild's device roster (one graph walk per rebuild)
    rebuildsSinceRs = 0;
  }

  // --- in-reactor fuel + burn totals over ACTIVE reactors (recomputed every rebuild, never cached) ---
  var burnTotal = 0, tankMb = null, tankCap = null, anyActive = false;
  var wasteMin = null;
  for (i = 0; i < reactors.length; i++) {
    var r = reactors[i];
    if (!r.online || !r.formed || !r.active) { continue; }
    anyActive = true;
    if (r.burnRate != null && r.burnRate > 0) { burnTotal += r.burnRate; }
    if (r.fuel.stored != null) { tankMb = (tankMb || 0) + r.fuel.stored; }
    if (r.fuel.capacity != null) { tankCap = (tankCap || 0) + r.fuel.capacity; }
    if (r.wasteSeconds != null && (wasteMin == null || r.wasteSeconds < wasteMin)) { wasteMin = r.wasteSeconds; }
  }

  var fuel = {
    ok: rsCache.ok, reason: rsCache.reason,
    networkId: rsCache.networkId, networkLabel: rsCache.networkLabel, connected: rsCache.connected,
    rsEnergy: rsCache.rsEnergy, reserveMb: rsCache.reserveMb,
    tankMb: tankMb, tankCap: tankCap
  };

  // --- runway: mB ÷ (mB/tick) ÷ 20 ticks-per-second = seconds. Exact tick math, no clock needed. ---
  var runway = {
    burnRate: anyActive ? burnTotal : null,
    tankSeconds: null, reserveSeconds: null, totalSeconds: null,
    wasteSeconds: wasteMin
  };
  if (burnTotal > 0) {
    runway.tankSeconds = (tankMb || 0) / burnTotal / TICKS_PER_SEC;
    runway.reserveSeconds = (fuel.reserveMb || 0) / burnTotal / TICKS_PER_SEC;
    runway.totalSeconds = runway.tankSeconds + runway.reserveSeconds;
  }

  // --- grid: aggregate over ONLINE + FORMED turbines; `net` sums the per-turbine MEASURED nets ---
  var grid = {
    production: null, maxProduction: null, bufStored: null, bufCapacity: null, bufPct: null,
    net: null, draw: null, secondsToEmpty: null, secondsToFull: null
  };
  var prod = 0, maxProd = 0, bufS = 0, bufC = 0, netSum = 0;
  var anyTurb = false, anyNet = false;
  for (i = 0; i < turbines.length; i++) {
    var t = turbines[i];
    if (!t.online || !t.formed) { continue; }
    anyTurb = true;
    if (t.production != null) { prod += t.production; }
    if (t.maxProduction != null) { maxProd += t.maxProduction; }
    if (t.energy.stored != null) { bufS += t.energy.stored; }
    if (t.energy.capacity != null) { bufC += t.energy.capacity; }
    if (t.net != null) { netSum += t.net; anyNet = true; }
  }
  if (anyTurb) {
    grid.production = prod;
    grid.maxProduction = maxProd;
    grid.bufStored = bufS;
    grid.bufCapacity = bufC;
    grid.bufPct = pctOf({ stored: bufS, capacity: bufC });
    if (anyNet) {
      var gnet = (netSum > -RATE_DEADBAND && netSum < RATE_DEADBAND) ? 0 : netSum;
      grid.net = gnet;
      var gdraw = prod - gnet;
      grid.draw = (gdraw > -RATE_DEADBAND && gdraw < RATE_DEADBAND) ? 0 : gdraw;
      if (gnet < 0 && bufS > 0) {
        grid.secondsToEmpty = bufS / (-gnet * TICKS_PER_SEC);
      } else if (gnet > 0 && bufC > bufS) {
        grid.secondsToFull = (bufC - bufS) / (gnet * TICKS_PER_SEC);
      }
    }
  }

  var alarms = buildAlarms(reactors, turbines, fuel, runway, safety);

  var ok = (reactors.length + turbines.length) > 0;
  return {
    ok: ok,
    reason: ok ? null : "No fission reactor or industrial turbine on the network. Mount a Silica Port on a reactor Logic-Adapter / Casing / Port or a turbine Valve / Casing / Vent, wire it to this computer, and install a NIC.",
    frame: frame,
    reactors: reactors,
    turbines: turbines,
    selReactor: selReactor,
    selTurbine: selTurbine,
    grid: grid,
    fuel: fuel,
    runway: runway,
    safety: safety,
    alarms: alarms,
    log: logEntries.slice(0),
    last: lastAction
  };
}

// One authoritative sweep: device reads + safety interlock + (rate-limited) RS read, cached, published.
// The ONLY thing in this file that issues device.calls in the read path — so counting calls means counting
// how often this runs (once per SWEEP_MS, plus once per control action).
function push() { lastSnapshot = buildState(); web.setState(lastSnapshot); }

// ===========================================================================================
//  control (server holds ALL authority; every request is re-validated against a live device)
// ===========================================================================================

// Resolve a control target and confirm it is a real, ONLINE device of the required kind. Returns the
// Device, or null after recording a rejection into lastAction + the log.
function resolveTarget(id, kind, action) {
  var dev = (typeof id === "string" && id) ? network.find(id) : null;
  var want = (kind === K_REACTOR) ? "reactor" : "turbine";
  if (!dev || dev.kind !== kind || !dev.online) {
    lastAction = { action: action, target: str(id, "?"), ok: false, text: "Invalid or offline " + want + " target." };
    logPush(false, action + ": invalid or offline " + want + " target");
    print("reactor-control: ignored " + action + " for invalid/offline target " + id);
    return null;
  }
  return dev;
}

function nameOf(dev) { return str(dev.label, dev.id); }

function record(action, dev, ok, text) {
  lastAction = { action: action, target: dev ? nameOf(dev) : null, ok: !!ok, text: text };
  logPush(ok, text);
}

// setBurnRate writes the reactor's TARGET rate (Mekanism's rateLimit). `burnRate` in getStatus is the
// ACTUAL last-tick burn, which reads 0 whenever the reactor is idle/starved — adjusting from that would
// silently reset an operator's set point. So we adjust from rateLimit and only fall back to burnRate.
function currentSetPoint(st) {
  var rl = num(st.rateLimit);
  if (rl != null) { return rl; }
  return num(st.burnRate) || 0;
}

function applyBurn(action, dev, wanted) {
  try {
    var st = dev.call("getStatus", {});                  // authoritative live re-read, never the page's number
    if (!st.formed) { throw "reactor is not formed"; }
    var max = num(st.maxBurnRate);
    var next = clamp(wanted, 0, (max == null ? wanted : max));
    var ack = dev.call("setBurnRate", { rate: next });
    var got = num(ack && ack.burnRate);
    record(action, dev, true, nameOf(dev) + ": burn rate -> " + (got == null ? next : got) + " mB/t");
    print("reactor-control: setBurnRate " + next + " -> " + nameOf(dev));
  } catch (e) {
    record(action, dev, false, nameOf(dev) + ": burn rate refused — " + e);
    print("reactor-control: setBurnRate refused for " + nameOf(dev) + " - " + e);
  }
}

function handle(msg) {
  if (!msg || typeof msg.action !== "string") { return; }
  var a = msg.action;

  if (a === "poll") { return; }

  if (a === "setSafety") {
    SAFETY_ENABLED = !!msg.enabled;
    var txt = "Safety interlock " + (SAFETY_ENABLED ? "ARMED" : "DISARMED");
    lastAction = { action: a, target: null, ok: true, text: txt };
    logPush(true, txt);
    print("reactor-control: " + txt);
    return;
  }

  if (a === "selectReactor" || a === "selectTurbine") {
    var wantKind = (a === "selectReactor") ? K_REACTOR : K_TURBINE;
    var id = str(msg.id, null);
    var d = id ? network.find(id) : null;
    if (!d || d.kind !== wantKind) {
      lastAction = { action: a, target: str(id, "?"), ok: false, text: "Unknown device." };
      return;
    }
    if (wantKind === K_REACTOR) { selReactor = d.id; } else { selTurbine = d.id; }
    return;
  }

  if (a === "activate" || a === "scram") {
    var r = resolveTarget(msg.target, K_REACTOR, a);
    if (!r) { return; }
    try {
      var ack = r.call(a, {});
      record(a, r, true, nameOf(r) + ": " + a + " -> active=" + !!ack.active);
      print("reactor-control: " + a + " -> " + nameOf(r));
    } catch (e) {
      record(a, r, false, nameOf(r) + ": " + a + " refused — " + e);
      print("reactor-control: " + a + " refused for " + nameOf(r) + " - " + e);
    }
    return;
  }

  if (a === "scramAll") {
    var all = network.devices();
    var hit = 0, fail = 0, skipped = 0;
    for (var i = 0; i < all.length; i++) {
      var dev = all[i];
      if (!isReactorDev(dev) || !dev.online) { continue; }
      var st;
      try { st = dev.call("getStatus", {}); }
      catch (e2) { fail++; print("reactor-control: scramAll getStatus failed for " + nameOf(dev) + " - " + e2); continue; }
      if (!st.formed) { continue; }
      if (!st.active) { skipped++; continue; }
      try { dev.call("scram", {}); hit++; }
      catch (e3) { fail++; print("reactor-control: scramAll scram failed for " + nameOf(dev) + " - " + e3); }
    }
    var text = "SCRAM ALL: " + hit + " scrammed, " + skipped + " already down"
      + (fail ? ", " + fail + " FAILED" : "");
    lastAction = { action: a, target: null, ok: fail === 0, text: text };
    logPush(fail === 0, text);
    print("reactor-control: " + text);
    return;
  }

  if (a === "burnAdjust") {
    var rb = resolveTarget(msg.target, K_REACTOR, a);
    if (!rb) { return; }
    var delta = num(msg.delta) || 0;
    try {
      var st2 = rb.call("getStatus", {});
      if (!st2.formed) { throw "reactor is not formed"; }
      applyBurn(a, rb, currentSetPoint(st2) + delta);
    } catch (e4) {
      record(a, rb, false, nameOf(rb) + ": burn rate refused — " + e4);
      print("reactor-control: burnAdjust refused for " + nameOf(rb) + " - " + e4);
    }
    return;
  }

  if (a === "burnSet") {
    var rs = resolveTarget(msg.target, K_REACTOR, a);
    if (!rs) { return; }
    var rate = num(msg.rate);
    if (rate == null) {
      record(a, rs, false, nameOf(rs) + ": no burn rate given.");
      return;
    }
    applyBurn(a, rs, rate);
    return;
  }

  if (a === "dumpCycle") {
    var t = resolveTarget(msg.target, K_TURBINE, a);
    if (!t) { return; }
    try {
      var ts = t.call("getStatus", {});                   // server reads the current dump mode
      var curMode = str(ts.dumping, "IDLE");
      var idx = DUMP_MODES.indexOf(curMode);
      var nextMode = DUMP_MODES[(idx < 0 ? 0 : idx + 1) % DUMP_MODES.length];
      var ackt = t.call("setDumping", { mode: nextMode });
      record(a, t, true, nameOf(t) + ": dumping -> " + str(ackt && ackt.dumping, nextMode));
      print("reactor-control: setDumping " + nextMode + " -> " + nameOf(t));
    } catch (e5) {
      record(a, t, false, nameOf(t) + ": set dumping refused — " + e5);
      print("reactor-control: setDumping refused for " + nameOf(t) + " - " + e5);
    }
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
// Date.now is a plain ECMAScript intrinsic and DOES work in this sandbox): fall back to the old
// message-counted debounce, so even then a poll stream cannot multiply the sweep rate without bound.
function sweepDue() {
  if (HAS_CLOCK) { return Date.now() >= nextSweepMs; }
  return msgsSinceSweep >= NOCLOCK_SWEEP_EVERY;
}

// How long to park in the next pullEvent: whatever is LEFT on the deadline, so an arriving message does
// not restart the clock (that is what would let a steady poll stream starve the interlock forever — the
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
push();                          // initial render (fresh build + arms the safety interlock)
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
      // what stops a button press and the tick that follows it from sweeping the devices twice.
      handle(msg);
      push();
      markSwept();
      continue;
    }

    // Bare poll / heartbeat / unparsable frame — re-publish what the clock already built. ZERO
    // device.calls, so the number of viewers cannot change the device-call rate at all.
    if (lastSnapshot) { web.setState(lastSnapshot); }
  }

  // The clock tick. THIS is the half that has to run with nobody watching: fresh device sweep, safety
  // interlock (which may auto-scram), publish. `!ev` = the timeout fired; sweepDue() = a message woke us
  // early but the deadline has since passed.
  if (!ev || sweepDue()) {
    push();
    markSwept();
  }
}
