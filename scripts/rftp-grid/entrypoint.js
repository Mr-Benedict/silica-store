// rftp-grid/entrypoint.js — server-side entry for the RFTools Power grid monitor (multi-file Path B).
// Live-watches every RFTools Power block reachable on this computer's network — PowerCell + Dimensional
// Cell networks, plus Endergenic / Coal / Blazing generators — and renders a read-only grid dashboard:
// one card per deduped cell network (total stored/capacity + live in/out) and one card per generator.
//
// ALL capability access is here on the server. The page holds NO authority and sends nothing but a
// {action:"poll"} heartbeat — this phase is READ-ONLY (E4-D16: the RFTools Power adapters expose only
// getStatus, no control verbs). The live refresh is SERVER-paced (see SWEEP_MS): the server sweeps on its
// own clock and a heartbeat is answered from the cached snapshot, so every viewer sees the same numbers
// and the number of viewers cannot change what those numbers are.
//
// Capability doors: network (needs a NIC installed) + web (needs web-display). RFTools Power blocks are
// reached as ordinary network devices (a Silica Port mounted on each cell / generator controller); no
// extra door (E4-D19 — the cable is the gate).
//
// Set up: a smart computer (SilicaOS ROM + GPU + web-display) with a NIC; mount a Silica Port on each
// PowerCell / Dimensional Cell / Endergenic / Coal Generator / Blazing Generator and wire it to the
// computer (directly, or via a switch/router/receiver). Run this from the Runner and stream it to a
// screen, or open the pad/pocket view.
//
// Sweep discipline (the E4-P1 freeze lesson — a peripheral device.call runs on the server TICK THREAD):
// exactly ONE getStatus per discovered device per SWEEP_MS, on the server's own clock. No per-device
// timers, no bursts, and no multiplication by viewer count.

// --- kinds (frozen contract, docs/phases/epic4-phase-3.md "Adapters + verb tables") ---
var K_POWERCELL = "rftools_powercell";
var K_DIMCELL = "rftools_dimensionalcell";
var K_ENDERGENIC = "rftools_endergenic";
var K_COAL = "rftools_coal_generator";
var K_BLAZING = "rftools_blazing_generator";

function isRftp(dev) { return dev && typeof dev.kind === "string" && dev.kind.indexOf("rftools_") === 0; }
function isGenerator(kind) { return kind === K_ENDERGENIC || kind === K_COAL || kind === K_BLAZING; }
function genType(kind) {
  if (kind === K_ENDERGENIC) { return "endergenic"; }
  if (kind === K_COAL) { return "coal"; }
  if (kind === K_BLAZING) { return "blazing"; }
  return "unknown";
}

// --- coerce host-proxy values into plain JSON-able primitives (web.setState needs plain objects) ---
function num(v) { return (typeof v === "number" && isFinite(v)) ? v : null; }
function str(v, dflt) { return (typeof v === "string" && v.length) ? v : dflt; }
function pos3(p) { return p ? { x: num(p.x), y: num(p.y), z: num(p.z) } : null; }

function safeStatus(dev, tag) {
  try { return dev.call("getStatus", {}); }
  catch (e) { print("rftp-grid: getStatus failed for " + (dev.label || dev.id) + " (" + tag + ") - " + e); return null; }
}

// --- the server clock ---
// The run loop advances on the SERVER's own clock, not on viewer polls. os.pullEvent(filter, seconds)
// returns null on timeout, which is what lets this loop keep a clock of its own.
//
// The resulting shape (see the run loop at the bottom of the file):
//   * exactly ONE getStatus per device per SWEEP_MS — with one viewer, four viewers, or none;
//   * a heartbeat only re-publishes the CACHED snapshot: zero device calls.
// Nothing on this sheet acts, so the clock is not about autonomy. It is about cost — and about the
// measured FE/t below being TRUE. deriveFlow differences a cumulative counter over elapsed wall time, so
// its sample interval used to be "however often a message happened to arrive": a second viewer halved it,
// RATE_FLOOR_MS started dropping samples, and the published flow changed with how many people were
// watching. On a fixed clock the interval is SWEEP_MS whatever the audience does — and it keeps ticking
// with nobody watching, so the EMA stays warm instead of re-baselining across every gap in attention.
var SWEEP_MS = 1000;          // one authoritative device sweep per second, viewer or no viewer
var NOCLOCK_SWEEP_EVERY = 2;  // no Date.now() at all (see HAS_CLOCK): sweep every 2nd message instead

// Date.now() is a plain ECMAScript intrinsic (no host access) and DOES work in the Silica GraalJS sandbox
// — reactor-control and detector both rely on it. Guarded anyway: without it the clock degrades to the
// message-counted fallback and the measured flow to null, rather than throwing.
var HAS_CLOCK = (typeof Date !== "undefined" && typeof Date.now === "function");

var lastSnapshot = null;      // cached authoritative state, re-pushed for bare heartbeats
var nextSweepMs = 0;          // the server clock's deadline (see markSwept)
var msgsSinceSweep = 0;       // no-clock fallback counter

// --- PowerCell live flow: cumulative network.extracted/inserted differenced over real time
// (Date.now(), a plain ECMAScript intrinsic — no host access; the rg-dashboard technique). Called ONLY
// from the clock tick, so the sample window is SWEEP_MS; the floor below is what is left of that guard
// once the cadence is fixed — a short sweep after a lag spike still contributes no sample. EMA-smoothed
// so integer-RF granularity and tick jitter don't make the readout dance. Keyed by network id (NOT device
// id — every cell in a network reports the same cumulative totals, so the rate is the same regardless of
// which cell we read it from). History drops when a network becomes unreadable so it re-baselines cleanly
// on return.
var TICKS_PER_SEC = 20;
var RATE_FLOOR_MS = 500;
var RATE_EMA = 0.3;
var flowHist = {};   // "pc:<networkId>" -> { extracted, inserted, t, inRate, outRate }

function deriveFlow(key, extracted, inserted) {
  if (!HAS_CLOCK) { return { inRate: null, outRate: null }; }
  if (extracted == null || inserted == null) { delete flowHist[key]; return { inRate: null, outRate: null }; }
  var now = Date.now();
  var h = flowHist[key];
  if (!h) { flowHist[key] = { extracted: extracted, inserted: inserted, t: now, inRate: null, outRate: null }; return { inRate: null, outRate: null }; }

  if (extracted < h.extracted || inserted < h.inserted) {
    // Cumulative counters went backwards (network re-formed/split) — rebase without a rate sample.
    h.extracted = extracted; h.inserted = inserted; h.t = now;
    return { inRate: h.inRate, outRate: h.outRate };
  }
  var dt = now - h.t;
  if (dt >= RATE_FLOOR_MS) {
    var dtSec = dt / 1000;
    var outSample = (extracted - h.extracted) / dtSec / TICKS_PER_SEC;   // + = network is being drawn from
    var inSample = (inserted - h.inserted) / dtSec / TICKS_PER_SEC;      // + = network is being fed
    h.outRate = (h.outRate == null) ? outSample : (h.outRate + RATE_EMA * (outSample - h.outRate));
    h.inRate = (h.inRate == null) ? inSample : (h.inRate + RATE_EMA * (inSample - h.inRate));
    h.extracted = extracted; h.inserted = inserted; h.t = now;
  }
  return { inRate: h.inRate, outRate: h.outRate };
}

// --- cell networks: dedupe by network.id, one card per network (PowerCell + DimensionalCell) ---

// PowerCell: network.{stored,capacity,extracted,inserted,cells} are already network-aggregate (read from
// whichever cell answers first); live in/out is DIFFERENCED (no rate getter exists — E4P3 doc).
function addPowerCellNetworks(devices, out, seen) {
  for (var i = 0; i < devices.length; i++) {
    var dev = devices[i];
    if (dev.kind !== K_POWERCELL || !dev.online) { continue; }
    var s = safeStatus(dev, "powercell");
    if (!s || !s.network) { continue; }   // no BE, or cell not yet joined to a network
    var key = "pc:" + s.network.id;
    if (seen[key]) { continue; }
    seen[key] = true;
    var flow = deriveFlow(key, num(s.network.extracted), num(s.network.inserted));
    out.push({
      key: key, kind: "powercell", networkId: s.network.id,
      dimension: str(s.dimension, null),
      stored: num(s.network.stored), capacity: num(s.network.capacity),
      cells: num(s.network.cells),
      blocks: null, simpleBlocks: null, advancedBlocks: null, costFactor: null,
      flowIn: flow.inRate, flowOut: flow.outRate
    });
  }
}

// DimensionalCell: network.{stored,capacity,blocks,simpleBlocks,advancedBlocks} are already
// network-aggregate; live in/out has real per-block getters (getLastRfPerTickIn/Out), so we SUM
// local.ratePerTickIn/Out across every reachable member of the network — no differencing needed, and
// this reflects the network's true instantaneous flow as far as the ports we can see attest to it.
function addDimensionalCellNetworks(devices, out, seen) {
  var groups = {};   // networkId -> { network, dimension, sumIn, sumOut, costFactor }
  for (var i = 0; i < devices.length; i++) {
    var dev = devices[i];
    if (dev.kind !== K_DIMCELL || !dev.online) { continue; }
    var s = safeStatus(dev, "dimensionalcell");
    if (!s || !s.network) { continue; }
    var g = groups[s.network.id];
    if (!g) { g = groups[s.network.id] = { network: s.network, dimension: str(s.dimension, null), sumIn: 0, sumOut: 0, costFactor: num(s.costFactor) }; }
    if (s.local) {
      g.sumIn += (typeof s.local.ratePerTickIn === "number") ? s.local.ratePerTickIn : 0;
      g.sumOut += (typeof s.local.ratePerTickOut === "number") ? s.local.ratePerTickOut : 0;
    }
  }
  for (var id in groups) {
    if (!groups.hasOwnProperty(id)) { continue; }
    var gg = groups[id];
    var key = "dc:" + id;
    if (seen[key]) { continue; }
    seen[key] = true;
    out.push({
      key: key, kind: "dimensional", networkId: Number(id),
      dimension: gg.dimension,
      stored: num(gg.network.stored), capacity: num(gg.network.capacity),
      cells: null,
      blocks: num(gg.network.blocks), simpleBlocks: num(gg.network.simpleBlocks), advancedBlocks: num(gg.network.advancedBlocks),
      costFactor: gg.costFactor,
      flowIn: gg.sumIn, flowOut: gg.sumOut
    });
  }
}

// --- generators: one card per device (not deduped — each generator is its own machine) ---

function generatorSnapshot(dev) {
  var m = { id: dev.id, label: str(dev.label, dev.id), online: !!dev.online, kind: genType(dev.kind), error: false };
  if (!dev.online) { return m; }   // loaded-only invariant: unloaded == offline, faculty calls would throw

  var s = safeStatus(dev, m.kind);
  if (!s) { m.error = true; return m; }

  m.pos = pos3(s.pos);
  m.dimension = str(s.dimension, null);
  m.stored = num(s.stored);
  m.capacity = num(s.capacity);
  m.rfPerTick = num(s.rfPerTick);
  m.working = !!s.working;

  if (m.kind === "endergenic") {
    m.lastGained = num(s.lastGained);
    m.lastLost = num(s.lastLost);
    m.chargingMode = str(s.chargingMode, "idle");
    m.holding = !!s.holding;
    m.charge = num(s.charge);
    m.distanceTicks = num(s.distanceTicks);
    m.pearlsLaunched = num(s.pearlsLaunched);
    m.pearlsLost = num(s.pearlsLost);
    m.lostReason = str(s.lostReason, null);
    m.good = num(s.good);
    m.bad = num(s.bad);
    m.destination = pos3(s.destination);
  } else if (m.kind === "coal") {
    m.burnRemaining = num(s.burnRemaining);
  } else if (m.kind === "blazing") {
    m.slots = num(s.slots);
  }
  return m;
}

// --- the authoritative state the page renders from ---

var TYPE_ORDER = { endergenic: 0, coal: 1, blazing: 2 };

function snapshot() {
  var all = network.devices();
  var rftp = [];
  for (var i = 0; i < all.length; i++) { if (isRftp(all[i])) { rftp.push(all[i]); } }

  if (rftp.length === 0) {
    return {
      ok: false,
      reason: "No RFTools Power blocks on the network. Mount a Silica Port on a PowerCell / Dimensional " +
        "Cell / Endergenic / Coal / Blazing generator and install a NIC."
    };
  }

  var networks = [];
  var seen = {};
  addPowerCellNetworks(rftp, networks, seen);
  addDimensionalCellNetworks(rftp, networks, seen);
  networks.sort(function (a, b) {
    if (a.kind !== b.kind) { return a.kind === "powercell" ? -1 : 1; }
    return a.networkId - b.networkId;
  });

  var generators = [];
  for (var j = 0; j < rftp.length; j++) {
    var dev = rftp[j];
    if (isGenerator(dev.kind)) { generators.push(generatorSnapshot(dev)); }
  }
  generators.sort(function (a, b) {
    var oa = TYPE_ORDER[a.kind] == null ? 9 : TYPE_ORDER[a.kind];
    var ob = TYPE_ORDER[b.kind] == null ? 9 : TYPE_ORDER[b.kind];
    if (oa !== ob) { return oa - ob; }
    return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0);
  });

  return { ok: true, networks: networks, generators: generators };
}

// Fresh sweep: read every device, cache the result, publish it. The ONLY thing that calls a device.
function push() { lastSnapshot = snapshot(); web.setState(lastSnapshot); }

// --- the server clock (see SWEEP_MS) ---

// Re-arm the deadline from NOW — never `nextSweepMs += SWEEP_MS`. After a lag spike or a slow sweep the
// next cycle is simply late; it never queues a catch-up BURST of sweeps into an already struggling tick
// thread.
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
// not restart the clock (that is exactly what would let a steady poll stream stretch the flow samples out
// of shape — the timeout is an absolute deadline armed once per call, not a per-message idle timer).
// Capped at SWEEP_MS so a backwards clock jump can't park us for hours; floored at 0, and pullEvent itself
// rounds any value up to one whole game tick, so this loop can never busy-spin.
function waitSeconds() {
  if (!HAS_CLOCK) { return SWEEP_MS / 1000; }
  var left = nextSweepMs - Date.now();
  if (left > SWEEP_MS) { left = SWEEP_MS; }
  if (left < 0) { left = 0; }
  return left / 1000;
}

// --- run ---
web.openFile("ui/index.html");   // resolves relative to this app's own folder
push();                          // initial render (fresh sweep)
markSwept();

while (true) {
  // null on timeout. NOT a plain pullEvent: with nobody watching, no web_message is ever produced, and
  // the differenced FE/t would then stop advancing and re-baseline off a stale sample on the next viewer.
  var ev = os.pullEvent("web_message", waitSeconds());

  if (ev) {
    // Read-only phase (E4-D16): there is no control verb to validate or act on, so EVERY message is a
    // bare heartbeat — answered from the snapshot the clock already built, with zero device calls.
    msgsSinceSweep++;
    if (lastSnapshot) { web.setState(lastSnapshot); }
  }

  // The clock tick: the fresh device sweep, and the only place deriveFlow takes a sample. `!ev` = the
  // timeout fired; sweepDue() = a message woke us early but the deadline has since passed.
  if (!ev || sweepDue()) {
    push();
    markSwept();
  }
}
