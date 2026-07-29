// geo-prospector/entrypoint.js — server-side entry for the Prospector's Survey Room (multi-file Path B).
//
// A survey sheet for the Silica **Geo Scanner**. The scanner fires ONE pulse on demand, sweeps a CUBE that
// hangs entirely BELOW the machine bottom-up, and hands the whole survey over the network. The cube's edge
// is `2*radius + 1` on all three axes and its top face is the layer at the scanner's own Y minus 1
// (E3P9-D21) — so `radius` is only the HORIZONTAL half-extent, the footprint is a square rather than a
// circle, and there is NO UPWARD REACH AT ALL: a scanner in a cave surveys the floor beneath it and nothing
// overhead. This app is the reading room for that survey:
//
//   * PULSE control + live sweep progress (the sweep's duration is the point — you watch it fill)
//   * PLAN (XZ) + SECTION (Y) survey plots of every clustered vein, scanner-centred
//   * a vein table sorted by DISTANCE or RARITY, each row carrying bearing / cardinal / depth so you can
//     walk to it with no map, and clickable to FOCUS it (the hologram highlights it and the prospector's
//     compass in the scanner points at it)
//   * an ONLY view filter — tap a block in the tally and the table AND both plots narrow to that one ore.
//     A big survey runs to thousands of veins, nearly all of it coal and copper, so "where is the diamond"
//     is unanswerable without it. Note what it is NOT: the scanner's own *scan filter* (the presets below)
//     decides what the sweep looks FOR and costs a pulse to change; ONLY narrows a survey already in hand,
//     costs nothing, and never touches the device.
//   * a SEARCH box beside it — free text, matched case-insensitively against each vein's block id AND its
//     displayed name, so `diamond`, `deepslate`, `xychorium` and a bare namespace like `mekanism:` all narrow
//     the table and both plots as you type. It COMPOSES with ONLY (a vein must pass both): ONLY is the
//     one-tap exact picker driven from the tally, SEARCH is what you type once the tally itself runs to
//     thirty rows and a tier-3 survey to a hundred and twenty pages. Typed characters only reach an MCEF page
//     from the SilicaOS desktop, a pad or a pocket computer — an in-world WALL SCREEN forwards clicks and
//     nothing else — so on a wall the box is a read-only display of the live query plus a tappable ✕.
//   * an ORE-PER-Y histogram and, from it, a RECOMMENDED SHAFT DEPTH — the one genuinely useful
//     computation here: not "where is the most ore" but "which Y band pays best per block dug"
//   * a SITE LOG built from the scanner's own `diff`: veins that vanished between pulses (mined out — by
//     you, a quarry, or someone else) and ore newly exposed
//   * FILTER PRESETS — ores by default, plus one-click spawner / budding amethyst / ancient debris / chest
//     hunts, because the scanner's filter takes any block id or #tag
//   * an optional DETECTOR OVERLAY — if an Entity Detector is on the network, its mobs are drawn over the
//     PLAN plot: what is living in the cave you are about to breach. Silently absent when there is none.
//
// It never pulses on its own. Every pulse is an operator's click (or the block's own redstone edge /
// GUI button) — the survey is information, not automation.
//
// ALL capability access is here on the server. The page holds NO authority — it only *requests* actions via
// mc.send, and this script re-validates every request (client messages are untrusted input): a control only
// ever fires against a real, ONLINE device of kind `geo_scanner`, re-resolved live each time, and a filter
// can only ever be one of the PRESETS below — never a raw string off the wire.
//
// Capability doors: network (needs a NIC) + geo (default-open; welded shut, the verbs throw and this app
// shows the refusal — the block's own hologram/GUI/compass keep working) + web (needs web-display). The
// optional detector overlay additionally needs the `detector` door; without it the overlay just stays off.
//
// Set up: a smart computer (SilicaOS ROM + GPU + web-display) with a NIC; place the Geo Scanner adjacent to
// the computer or wire it in (a pylon face works — the ring proxies the network to the controller). Run this
// from the Runner and stream it to a named monitor, or open the pad / pocket view.

// ===========================================================================================
//  TUNABLE CONFIG — edit this block to match YOUR base
// ===========================================================================================

// SCANNER: optionally pin one scanner by name — the screwdriver label you gave it, or its auto device id.
// Leave EMPTY to use every geo_scanner on the network (they appear as selector chips; only the SELECTED
// one is ever polled, so extra scanners cost nothing).
//   e.g.:  var SCANNER = "deep_survey";
var SCANNER = "";

// DETECTOR: same idea for the mob overlay. Empty = the first detector found on the network.
var DETECTOR = "";

// FILTER PRESETS — what the scanner is told to look for. `filter` accepts block ids and `#tag` strings
// (E3P9-D14); `#c:ores` is the NeoForge common tag, so every modded ore in the pack is covered with no
// hardcoded roster. Add your own rows freely: the page renders one button per entry, and the SERVER only
// ever applies a filter from THIS table (a preset key off the wire is looked up here, never trusted).
var PRESETS = [
  { key: "ores",     label: "ORES",    filter: ["#c:ores"] },
  { key: "spawner",  label: "SPAWNER", filter: ["minecraft:spawner", "minecraft:trial_spawner"] },
  { key: "amethyst", label: "BUDDING", filter: ["minecraft:budding_amethyst"] },
  { key: "debris",   label: "DEBRIS",  filter: ["minecraft:ancient_debris"] },
  { key: "chest",    label: "CHESTS",  filter: ["minecraft:chest", "minecraft:trapped_chest", "minecraft:barrel"] }
];

// --- the recommended-shaft model (the honest bit; see recommendShaft) ---
// A branch tunnel is 1 wide x 2 tall. Standing at FEET level y you dig 2 blocks per metre of tunnel and you
// EXPOSE the floor (y-1), your own two body layers plus their side walls (y, y+1), and the ceiling (y+2).
// SHAFT_BAND is that exposure, as [dy, blocks exposed per metre]; DUG_PER_M is what it costs you.
// Edit if you mine differently (a 1x3 tunnel, a 2-wide highway) — the recommendation follows the model.
var SHAFT_BAND = [[-1, 1], [0, 3], [1, 3], [2, 1]];
var DUG_PER_M = 2;
// The recommendation ignores any Y slice thinner than this. Under the old SPHERE that was load-bearing: a
// slice at the pole was a handful of blocks wide, so one lucky diamond up there out-scored a genuinely rich
// layer. The cube has no thin slices at all (every layer inside it is the full edge x edge square, i.e. at
// least 33^2 = 1,089 blocks), so this now only ever rejects a slice OUTSIDE the volume — which is exactly
// the clamp the exposure band needs where it would run off the top or bottom of the cube. Kept for that.
var MIN_SLICE_CELLS = 48;

// --- poll discipline (the E4-P1 freeze lesson: a device.call runs on the server TICK THREAD) ---
// The run loop keeps the SERVER's own clock (see the run loop at the bottom): exactly one status read per
// tick of that clock, with a hundred viewers or with nobody in the dimension. A bare viewer poll re-publishes
// the CACHED snapshot and issues ZERO device calls, so viewer count cannot move the device-call rate at all.
var SWEEP_MS = 1000;      // idle cadence: one status() per second
var SCAN_MS = 300;        // while a sweep is in flight, so the progress bar actually moves
var CONFIG_EVERY = 5;     // read the scanner's filter/radius every Nth idle tick (it changes rarely)

// --- how much of the survey this script HOLDS (script memory only — none of it rides the snapshot) ---
// The scanner's `veins` verb answers up to geoScannerMaxVeins, whose ceiling is 65,536. Hold all of it: the
// held list is what every sort, the ONLY filter and the map budget are cut FROM, so anything dropped here is
// unreachable by any control on the sheet. This used to be MAP_CAP * 4 = 1,600 — and since `veins` answers
// NEAREST first, a scanner configured past that silently discarded its farthest finds, which after E3P9-D22
// are exactly the ones RAREST exists to surface. Only `rows` (ROWS) and `map` (MAP_CAP dots) are published,
// so this costs script memory and nothing on the wire — matched to the server ceiling deliberately, since a
// number lower than what the admin allows is a silent truncation nobody can see.
var VEIN_HOLD_CAP = 65536;

// --- display caps (everything here rides the state snapshot on every push) ---
// Sized against the SHIPPED DEFAULT of [display] appStateMaxChars (262,144 chars), never its ceiling: the
// script cannot read server config, so a snapshot over the live cap throws and the sheet is lost. A worst-case
// snapshot at these caps — every list full, 39-character modded block ids throughout — measures ~76,000
// chars, i.e. ~71% headroom. Re-measure if you raise any of them. (These used to be sized against a 64 KB
// state cap, which is where the small numbers came from.)
var MAP_CAP = 2000;       // vein dots published for the plots (nearest first)
var ROWS = 32;            // vein-table rows per page
// Distinct block rows in the tally list — and the tally list IS the ONLY picker, so this cap is now the
// reach of a control, not just how much of a readout you can see. It is ordered by BLOCK COUNT descending,
// which puts exactly the ore you want to isolate (diamond, debris, emerald) near the BOTTOM: a modded pack
// sweeping `#c:ores` easily turns up 30+ distinct ores, and at the old 24 the interesting ones fell off the
// end into "+N more block types" — unfilterable. Raise it further if your pack out-runs this; each row
// costs ~45 bytes of the state snapshot.
var TALLY_CAP = 160;
var PALETTE_CAP = 24;     // distinct block ids that get their own plot colour
var SITE_CAP = 20;        // site-log entries
var MOB_CAP = 48;         // detector overlay marks
var HIT_READ_CAP = 4096;  // raw hits read per pulse for the histogram (geoScannerMaxResults default)

// ===========================================================================================
//  constants (do not edit)
// ===========================================================================================
// KIND / DET_KIND are Silica PERIPHERAL KINDS, not Minecraft block ids — the label the block reports in
// Java, which is what network.devices() puts in dev.kind. Changing these strings cannot make Silica find a
// different block; it only stops it matching the block it can already see.

var KIND = "geo_scanner";
var DET_KIND = "detector";

// The scan volume (E3P9-D21): a cube of edge `2*radius + 1` hanging entirely BELOW the scanner. TOP_DY is
// its top face as an offset from the scanner — the layer immediately beneath the machine — and the band runs
// from there down to `TOP_DY - edge + 1`, i.e. dy in [-edge, -1]. Nothing at or above the scanner's own
// level is ever read. Written once here; every band check below derives from it.
var TOP_DY = -1;

var TICKS_PER_SEC = 20;
var SORTS = ["dist", "rarity"];

// Longest SEARCH query accepted off the wire. It must match the `maxlength` on the box in ui/index.html and
// SEARCH_MAX in ui/client.js — and if they ever drift, THIS one wins (the server slices) and the page's box
// snaps to the truncated value once its send goes unacknowledged. A query is a fragment of a block id, and
// the longest modded ids in a pack are ~40 characters, so 32 is generous for a substring.
var SEARCH_MAX = 32;

// 16-point compass, N first, clockwise — only used as a fallback if a vein record arrives without its own
// `cardinal` (the scanner computes both bearing and cardinal itself; see E3P9-D7).
var POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
              "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

// Date.now() is a plain ECMAScript intrinsic (no host access) and DOES work in the Silica GraalJS sandbox —
// reactor-control and builder-control both rely on it. Guarded anyway: without it the loop falls back to a
// message-counted cadence instead of throwing.
var HAS_CLOCK = (typeof Date !== "undefined" && typeof Date.now === "function");

// ===========================================================================================
//  coercion helpers — web.setState needs PLAIN JSON-able values (a verb result is a host proxy)
// ===========================================================================================

function num(v) { return (typeof v === "number" && isFinite(v)) ? v : null; }
function str(v, dflt) { return (typeof v === "string" && v.length) ? v : dflt; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function r1(v) { return v == null ? null : Math.round(v * 10) / 10; }
function r3(v) { return v == null ? null : Math.round(v * 1000) / 1000; }
function ri(v) { return v == null ? null : Math.round(v); }

// The cube's EDGE and its DEPTH below the scanner are the same number — a cube's depth is its width
// (E3P9-D21) — so one helper serves both fields wherever a verb reports them: take what the scanner said,
// and fall back to the `2*radius + 1` identity when the field is missing (an older scanner, a trimmed
// record). The identity is written HERE and nowhere else, so the fallback cannot drift from the block.
function cubeSpan(reported, radius) {
  var v = num(reported);
  if (v != null) { return v; }
  var r = num(radius);
  return (r == null) ? null : 2 * r + 1;
}

// A {stored,capacity} host proxy -> a plain always-present pair, so the page can read t.stored blindly.
function tank(t) {
  if (!t) { return { stored: null, capacity: null }; }
  return { stored: num(t.stored), capacity: num(t.capacity) };
}
function pctOf(t) {
  if (!t || t.capacity == null || !(t.capacity > 0) || t.stored == null) { return null; }
  return clamp(t.stored / t.capacity * 100, 0, 100);
}

// Member keys of a host object (a ProxyObject exposes them as own keys), degrading to [] rather than
// throwing if a future marshalling ever stops being enumerable.
function keysOf(o) {
  if (!o || typeof o !== "object") { return []; }
  try {
    var k = Object.keys(o);
    return k ? k : [];
  } catch (e) { return []; }
}

// A foreign (host) array is NOT an Array, so Array.isArray is useless here — length + index access is the
// only portable read. Returns a plain JS array of the raw elements.
function listOf(v, cap) {
  var out = [];
  if (!v) { return out; }
  var n = num(v.length);
  if (n == null) { return out; }
  var lim = (cap == null) ? n : Math.min(n, cap);
  for (var i = 0; i < lim; i++) { out.push(v[i]); }
  return out;
}

function isScanner(dev) { return dev && dev.kind === KIND; }
function nameOf(dev) { return str(dev.label, dev.id); }
function byLabel(a, b) { return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0); }

// "minecraft:deepslate_diamond_ore@3,-6,12" -> "minecraft:deepslate_diamond_ore". A vein id is
// "<blockId>@<quantised centre>" (E3P9-D8), which is what lets a `diff` id name its block even when the
// vein itself is gone from the current survey.
function blockOfId(id) {
  var s = str(id, "");
  var at = s.lastIndexOf("@");
  return at > 0 ? s.slice(0, at) : s;
}

// ...and the quantised centre back to an approximate world position (the id quantises by >>2, so this is
// only ever accurate to +/-4 blocks — the site log says so).
function approxPosOfId(id) {
  var s = str(id, "");
  var at = s.lastIndexOf("@");
  if (at < 0) { return null; }
  var p = s.slice(at + 1).split(",");
  if (p.length !== 3) { return null; }
  var x = parseInt(p[0], 10), y = parseInt(p[1], 10), z = parseInt(p[2], 10);
  if (isNaN(x) || isNaN(y) || isNaN(z)) { return null; }
  return { x: x * 4, y: y * 4, z: z * 4 };
}

function fmtAge(ticks) {
  var t = num(ticks);
  if (t == null) { return "--"; }
  var s = Math.round(t / TICKS_PER_SEC);
  if (s < 60) { return s + "s"; }
  if (s < 3600) { return Math.floor(s / 60) + "m " + (s % 60) + "s"; }
  return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
}

// ===========================================================================================
//  session state (server-authoritative; the page only ever reflects this back)
// ===========================================================================================

var frame = 0;              // increments on every fresh clock tick; the site-log + status stamp
var lastAction = null;      // { action, target, ok, text } — sticky status line
var lastSnapshot = null;    // cached authoritative state, re-published to bare polls (zero device calls)
var nextTickMs = 0;         // wall-clock deadline for the next authoritative read (see markTicked)
var msgsSinceTick = 0;      // clock-free fallback gate only
var sel = null;             // device id of the scanner the sheet addresses
var sortMode = "dist";      // vein-table order: "dist" | "rarity"
var rowPage = 0;            // vein-table page (server-paged: every viewer sees the same page)
// The ONLY view filter: a block id, or null for "every block". Server-side and server-paged for the same
// reason the table is — two people watching one wall screen must be looking at the same thing. It narrows
// the vein table AND both plots; it deliberately does NOT touch the depth histogram (an aggregate per-Y
// tally, not a per-block one) or the survey's headline counts, which stay whole-survey.
var onlyBlock = null;
// The SEARCH query — the same view filter idea, free text instead of one exact block, and it COMPOSES with
// ONLY rather than replacing it (logical AND: ONLY is the tally's one-tap exact picker, SEARCH is what you
// type). Server-side and server-paged for the same reason ONLY is. It narrows exactly what ONLY narrows —
// the vein table and both plots — and deliberately NOT the tally (which *is* the ONLY picker: narrowing it
// would remove the way to pick), the depth histogram, or the survey's headline counts.
// Unlike ONLY it is NEVER auto-cleared by a new pulse: a block filter that the new survey cannot satisfy
// leaves you staring at an empty table (hence pruneOnly), whereas free text is the operator's own words and
// silently deleting them would be the more surprising failure. An unmatched query says so in the vein card.
//   query      as typed, length-capped — echoed to the page so every viewer sees the same query
//   queryNorm  trimmed + lowercased, "" for "no filter" — what actually matches
var query = "";
var queryNorm = "";
var overlay = false;        // detector overlay armed by the operator
var focusId = null;         // last vein WE focused — fallback if status() reports no `focused`
var scanning = false;       // last known sweep state (drives the loop cadence)

// One cache per scanner device id. This is what makes `diff` readable: `diff()` answers in vein IDS, and a
// vein that has been mined out is by definition no longer in the current survey — so the PREVIOUS pulse's
// records are the only place its block and position still exist.
//   veins      the full plain vein list of the newest pulse
//   byId       id -> record, for `diff` lookups and focus validation
//   veinBlocks block id -> true for every vein held, so validating an ONLY request (and dropping the
//              filter when a new pulse holds none of that block) is an O(1) lookup, not a list walk
//   prevById   the pulse before that (what a `removed` id resolves against)
//   lastAge    ageTicks seen on the previous read — a LOWER age means a new pulse landed
//   hist/rec   the ore-per-Y histogram + shaft recommendation of the newest pulse
//   sites      the running site log (newest first)
//   cfgAge     idle ticks since the filter/radius were last read
var caches = {};

function cacheFor(id) {
  var c = caches[id];
  if (!c) {
    c = caches[id] = {
      veins: [], byId: {}, veinBlocks: {}, prevById: {}, lastAge: null,
      survey: null, palette: [], tally: [], tallyMore: 0,
      hist: null, rec: null, truncated: false, hits: null, hitCap: null,
      origin: null, sites: [], cfg: null, cfgAge: 99, maxRadius: null,
      stallFrames: 0, lastProgress: null
    };
  }
  return c;
}

// Forget scanners that are no longer on the network, so one returning later re-baselines cleanly instead of
// diffing against a survey from an hour ago.
function pruneCaches(ids) {
  var live = {}, i;
  for (i = 0; i < ids.length; i++) { live[ids[i]] = true; }
  for (var k in caches) {
    if (Object.prototype.hasOwnProperty.call(caches, k) && !live[k]) { delete caches[k]; }
  }
}

function sitePush(c, kind, text) {
  c.sites.unshift({ kind: kind, text: "[" + frame + "] " + text });
  if (c.sites.length > SITE_CAP) { c.sites.length = SITE_CAP; }
}

// ===========================================================================================
//  reading the scanner
// ===========================================================================================

// The whole `status()` surface, coerced. Every field nullable — one missing field must never sink the sheet.
function readStatus(dev) {
  var s = dev.call("status", {});
  var e = tank(s.energy);
  return {
    online: true, error: false,
    scanning: !!s.scanning,
    progress: num(s.progress),
    radius: num(s.radius),
    // radius is the HORIZONTAL half-extent; edge/depth are the cube's full edge and how far it reaches
    // below the machine (E3P9-D21). All three travel together — a consumer that saw only `radius` would
    // reasonably assume a symmetric volume and plot the whole survey a cube-height too high.
    edge: cubeSpan(s.edge, s.radius),
    depth: cubeSpan(s.depth, s.radius),
    maxRadius: num(s.maxRadius),
    clampedByServer: !!s.clampedByServer,
    chip: str(s.chip, null),
    cooldownTicks: num(s.cooldownTicks),
    hasResult: !!s.hasResult,
    ageTicks: num(s.ageTicks),
    partial: !!s.partial,
    skippedChunks: num(s.skippedChunks),
    feDraw: num(s.feDraw),
    energy: e,
    energyPct: pctOf(e),
    rawFocused: s.focused        // string id OR record — normalised in focusedFrom (see there)
  };
}

function offlineStatus() {
  return {
    online: false, error: false, scanning: false, progress: null, radius: null,
    edge: null, depth: null, maxRadius: null,
    clampedByServer: false, chip: null, cooldownTicks: null, hasResult: false, ageTicks: null,
    partial: false, skippedChunks: null, feDraw: null, energy: tank(null), energyPct: null,
    rawFocused: null
  };
}

// One vein record -> plain values. `bearing` / `cardinal` / `depth` are computed by the scanner (E3P9-D7);
// they are re-derived here ONLY if a record arrives without them, so the walk-to panel is never blank.
function veinRec(v) {
  if (!v || typeof v !== "object") { return null; }
  var c = v.centre;
  var dx = num(v.dx), dy = num(v.dy), dz = num(v.dz);
  var bearing = num(v.bearing);
  if (bearing == null && dx != null && dz != null) {
    bearing = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;   // 0 = north, clockwise
  }
  var card = str(v.cardinal, null);
  if (card == null && bearing != null) {
    card = POINTS[Math.round(bearing / 22.5) % 16];
  }
  var dist = num(v.dist);
  if (dist == null && dx != null && dy != null && dz != null) {
    dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return {
    id: str(v.id, null),
    block: str(v.block, blockOfId(v.id)),
    count: num(v.count),
    x: c ? num(c.x) : null, y: c ? num(c.y) : null, z: c ? num(c.z) : null,
    dx: dx, dy: dy, dz: dz,
    dist: dist,
    bearing: bearing,
    cardinal: card,
    depth: (num(v.depth) != null) ? num(v.depth) : dy,
    // `count` is THIS vein; `typeCount` is how many of that ore the WHOLE scan found, and `rarity` is the
    // same fact as a 0..1 fraction (E3P9-D22 — both are per-ORE, so every vein of one ore shares them).
    // An older scanner reports no typeCount; fall back to rarity so the RAREST sort still ranks ores rather
    // than silently reverting to "smallest lump first". Rarity descending IS type count ascending, so the
    // fallback is exact wherever the scanner reported a rarity at all.
    typeCount: num(v.typeCount),
    rarity: num(v.rarity)
  };
}

// The scan cube hangs below the CONTROLLER, and the origin is that controller's own block position,
// recovered from any vein: centre - (dx,dy,dz). Everything that needs world coordinates — the section plot's
// Y axis, the histogram's absolute Y, the detector overlay's absolute-to-relative conversion — depends on
// this, which is why a survey with no finds plots nothing.
// (`status()` also reports `pos` directly, so wiring that in as a fallback would let the plots draw an empty
// volume before the first find. Deliberately not done: one source for the origin keeps the plots and the
// histogram pinned to the same coordinates the survey itself reported.)
function originOf(veins) {
  for (var i = 0; i < veins.length; i++) {
    var v = veins[i];
    if (v.x != null && v.y != null && v.z != null && v.dx != null && v.dy != null && v.dz != null) {
      return { x: v.x - v.dx, y: v.y - v.dy, z: v.z - v.dz };
    }
  }
  return null;
}

// ===========================================================================================
//  the ore-per-Y histogram and the shaft recommendation
// ===========================================================================================

// How many blocks the sweep actually READ in the Y slice at vertical offset dy — the denominator that makes
// the histogram a DENSITY instead of a popularity contest.
//
// Since E3P9-D21 that correction is TRIVIAL, and the trig it used to need is gone: the volume is a cube, so
// every layer inside the band is the SAME full edge x edge square and every layer outside it is nothing.
// The sphere it replaced had to weight each slice by the lattice points of a disc of radius
// sqrt(r^2 - dy^2), because its middle slice was ~pi*r^2 blocks wide against a handful at its poles — raw
// counts therefore always peaked at the scanner's own level whatever the rock was doing, and the histogram
// only became readable once that mid-bulge was divided out. A cube has no bulge to divide out: the shape you
// see IS the distribution. That is a genuinely better instrument, not just less code — a constant divisor
// cannot introduce a peak, and cannot hide one either.
function sliceCells(edge, dy) {
  if (!(edge > 0) || dy > TOP_DY || dy < TOP_DY - edge + 1) { return 0; }
  return edge * edge;
}

// Exact ore-per-Y from the raw hit list. `scan()` is capped (geoScannerMaxResults) and the sweep runs
// BOTTOM-UP, so a truncated hit list is biased towards low Y — the histogram carries `truncated` and the
// page labels the recommendation PROVISIONAL rather than quietly lying about the best depth.
//
// BINS. One per layer of the cube and not one more: the band is dy in [-edge, -1] (E3P9-D21), so there are
// exactly `edge` of them and bin k is the layer at dy = -edge + k. Hence k = dy + edge, i.e. the DEEPEST
// layer is bin 0 and the layer immediately under the scanner is bin edge-1 — bin index rises with Y, which
// is what `y0 + i` and the page's row order both assume. The scanner's own level (dy = 0) maps to k = edge,
// one past the end, and is rejected by the bounds guard rather than silently landing in the top bin.
function buildHistogram(hits, origin, edge) {
  if (!origin || edge == null || !(edge > 0)) { return null; }
  var n = edge, i;
  var counts = [], cells = [];
  for (i = 0; i < n; i++) { counts.push(0); cells.push(sliceCells(edge, i - edge)); }

  var used = 0;
  for (i = 0; i < hits.length; i++) {
    var y = num(hits[i] ? hits[i].y : null);
    if (y == null) { continue; }
    var k = Math.round(y - origin.y) + edge;
    if (k < 0 || k >= n) { continue; }          // outside the cube's Y band: ignore rather than clamp
    counts[k]++;
    used++;
  }
  // minCells travels with the data so the page can dim the slices the recommendation ignored without
  // keeping its own copy of MIN_SLICE_CELLS (a duplicated constant is a drift waiting to happen).
  return { y0: origin.y - edge, edge: edge, hits: counts, cells: cells,
           sampled: used, minCells: MIN_SLICE_CELLS };
}

// The recommendation. score(y) = sum over the exposure band of (blocks exposed per metre) x (ore density at
// that layer) — i.e. the ore a metre of tunnel at feet level y puts in front of you. per100 turns that into
// the number the player actually cares about: ore exposed per 100 blocks dug.
//
// A tunnel whose exposure band would reach past either end of the cube is skipped outright (the bounds test
// below, plus the cells test that catches the same thing): there is no data up there, and guessing at it is
// how a shaft advisor starts lying. That costs the top two and bottom one layers of every survey.
function recommendShaft(h) {
  if (!h) { return null; }
  var n = h.hits.length, best = null, i, j;
  for (i = 0; i < n; i++) {
    var score = 0, sample = 0, ok = true;
    for (j = 0; j < SHAFT_BAND.length; j++) {
      var k = i + SHAFT_BAND[j][0];
      if (k < 0 || k >= n || h.cells[k] < MIN_SLICE_CELLS) { ok = false; break; }
      score += SHAFT_BAND[j][1] * (h.hits[k] / h.cells[k]);
      sample += h.hits[k];
    }
    if (!ok) { continue; }
    // Tie-break towards the SHALLOWEST band — same yield, less digging down. (Under the sphere this read
    // "nearest the scanner's own Y", which was the same intent when half the volume sat above it; the whole
    // cube is below the machine now, so the top bin, n-1, IS the nearest layer.)
    var near = (n - 1) - i;
    if (best == null || score > best.score + 1e-12
        || (Math.abs(score - best.score) <= 1e-12 && near < best.near)) {
      best = { i: i, score: score, sample: sample, near: near };
    }
  }
  if (best == null || !(best.score > 0)) { return null; }
  return {
    y: h.y0 + best.i,
    score: Math.round(best.score * 1e4) / 1e4,
    per100: Math.round(best.score / DUG_PER_M * 1e4) / 100,   // ore exposed per 100 blocks dug, 2 dp
    band: [h.y0 + best.i + SHAFT_BAND[0][0], h.y0 + best.i + SHAFT_BAND[SHAFT_BAND.length - 1][0]],
    hits: best.sample
  };
}

// ===========================================================================================
//  one fresh pulse -> the heavy verbs (four calls, ONCE per pulse — never per viewer, never per tick)
// ===========================================================================================

function ingestResult(dev, c, fallbackRadius) {
  var i;

  // --- veins: the map, the table and (via their centres) the scan origin -------------------
  var raw = listOf(dev.call("veins", {}), VEIN_HOLD_CAP);
  var veins = [];
  for (i = 0; i < raw.length; i++) {
    var v = veinRec(raw[i]);
    if (v) { veins.push(v); }
  }
  c.prevById = c.byId;
  c.byId = {};
  c.veinBlocks = {};
  for (i = 0; i < veins.length; i++) {
    if (veins[i].id) { c.byId[veins[i].id] = veins[i]; }
    if (veins[i].block) { c.veinBlocks[veins[i].block] = true; }
  }
  c.veins = veins;
  c.origin = originOf(veins);

  // --- survey: tallies + the partial/skipped flags -----------------------------------------
  var sv = null;
  try { sv = dev.call("survey", {}); }
  catch (e) { print("geo-prospector: survey failed - " + e); }
  c.survey = {
    total: sv ? num(sv.total) : null,
    veinCount: sv ? num(sv.veinCount) : veins.length,
    radius: sv ? num(sv.radius) : null,
    edge: sv ? cubeSpan(sv.edge, sv.radius) : null,
    depth: sv ? cubeSpan(sv.depth, sv.radius) : null,
    ageTicks: sv ? num(sv.ageTicks) : null,
    partial: sv ? !!sv.partial : false,
    skippedChunks: sv ? num(sv.skippedChunks) : null
  };
  buildTally(c, sv ? sv.tally : null);

  // --- raw hits: the exact ore-per-Y distribution ------------------------------------------
  c.hist = null; c.rec = null; c.truncated = false; c.hits = null; c.hitCap = null;
  try {
    var sc = dev.call("scan", {});
    var hits = listOf(sc ? sc.hits : null, HIT_READ_CAP);
    c.truncated = !!(sc && sc.truncated);
    c.hitCap = sc ? num(sc.cap) : null;
    c.hits = hits.length;
    // The histogram bins the CUBE's layers, so it is driven by the edge — from the survey when it reported
    // one, else derived from whichever radius we have.
    var r = (c.survey.radius != null) ? c.survey.radius : num(fallbackRadius);
    var edge = (c.survey.edge != null) ? c.survey.edge : cubeSpan(null, r);
    c.hist = buildHistogram(hits, c.origin, edge);
    c.rec = recommendShaft(c.hist);
  } catch (e2) {
    print("geo-prospector: scan failed - " + e2);
  }

  // --- diff: the site log ------------------------------------------------------------------
  try {
    var df = dev.call("diff", {});
    var gone = listOf(df ? df.removed : null, SITE_CAP);
    var added = listOf(df ? df.added : null, SITE_CAP);
    for (i = 0; i < gone.length; i++) { sitePush(c, "gone", siteText("MINED OUT", gone[i], c.prevById)); }
    for (i = 0; i < added.length; i++) { sitePush(c, "new", siteText("NEW", added[i], c.byId)); }
    if (gone.length === 0 && added.length === 0 && c.sites.length === 0) {
      sitePush(c, "none", "baseline survey recorded — re-pulse to see what changed");
    }
  } catch (e3) {
    print("geo-prospector: diff failed - " + e3);
  }

  // Last, so its notice sits at the top of the log it just wrote: the ONLY filter survives a re-pulse
  // (you re-pulse precisely to watch ONE ore change), unless this survey holds none of it.
  pruneOnly(c);
}

// Drop the ONLY view filter when the survey in hand holds nothing of that block, rather than leaving the
// operator staring at an empty table wondering what broke. Silent persistence across a pulse is the right
// default; silent emptiness is not. Only ever runs against a survey that actually landed — an empty cache
// (a scanner that has not pulsed yet) keeps the filter for the pulse that is coming.
function pruneOnly(c) {
  if (onlyBlock == null || !c || !c.veins.length) { return; }
  if (c.veinBlocks && c.veinBlocks[onlyBlock]) { return; }
  var was = onlyBlock;
  onlyBlock = null;
  rowPage = 0;
  sitePush(c, "none", "ONLY " + shortBlock(was) + " cleared — this survey holds none");
  record("only", true, "ONLY " + shortBlock(was)
    + " cleared — the new survey holds none of it. Showing every block again.");
}

// A site-log line for one vein id. The record is preferred (exact centre); when the id is not in the
// survey we hold — `diff` answers over the scanner's FULL vein set, ours is capped — the id itself still
// carries the block and a quantised centre, so the line degrades to "+/-4 blocks" instead of vanishing.
function siteText(head, id, byId) {
  var sid = str(id, "?");
  var rec = byId ? byId[sid] : null;
  var block = shortBlock(rec ? rec.block : blockOfId(sid));
  if (rec && rec.x != null) {
    var where = rec.cardinal ? (Math.round(rec.dist) + "m " + rec.cardinal) : "";
    var depth = (rec.depth != null)
      ? (rec.depth < 0 ? (Math.abs(Math.round(rec.depth)) + " below") : (Math.round(rec.depth) + " above"))
      : "";
    return head + " " + block + " x" + (rec.count == null ? "?" : rec.count)
      + " @ " + rec.x + "," + rec.y + "," + rec.z
      + (where ? "  (" + where + (depth ? ", " + depth : "") + ")" : "");
  }
  var ap = approxPosOfId(sid);
  return head + " " + block + (ap ? (" @ ~" + ap.x + "," + ap.y + "," + ap.z + " (+/-4)") : "");
}

function shortBlock(id) {
  var s = str(id, "?");
  var c = s.indexOf(":");
  return c >= 0 ? s.slice(c + 1) : s;
}

// tally: {"<blockId>": count} -> a sorted [[id,count]] list capped for display, plus the plot palette.
function buildTally(c, t) {
  var keys = keysOf(t), rows = [], i;
  for (i = 0; i < keys.length; i++) {
    var n = num(t[keys[i]]);
    if (n != null) { rows.push([keys[i], n]); }
  }
  rows.sort(function (a, b) { return b[1] - a[1]; });
  c.tallyMore = Math.max(0, rows.length - TALLY_CAP);
  c.tally = rows.slice(0, TALLY_CAP);
  var pal = [];
  for (i = 0; i < rows.length && pal.length < PALETTE_CAP; i++) { pal.push(rows[i][0]); }
  c.palette = pal;
}

// ===========================================================================================
//  publishing shapes — compact on purpose (web.setState is capped by [display] appStateMaxChars)
// ===========================================================================================

// The SEARCH haystack for one block id: the RAW id, plus the id with `_` and `:` opened out to spaces. Two
// forms, and two is enough.
//   * the raw form is what makes a namespace fragment work — `mekanism:` matches nothing in the opened-out
//     form, and it is the only way to tell two mods' identically-named `platinum_ore` apart, since the page's
//     displayed names are truncated AND have their mod prefix stripped;
//   * the opened-out form is what makes a TYPED NAME work — `deepslate diamond`, `diamond ore` — because the
//     raw id spells those with underscores.
// It also covers the page's own prettified label for free, so there is no third entry: pretty() only ever
// DELETES from the id (the namespace, a trailing `_ore`, a leading `ore_`) and swaps `_` for a space, so
// pretty(id) lowercased is always a SUBSTRING of the opened-out form. Memoised by block id — a big survey
// holds tens of thousands of veins but only tens of distinct blocks, and this is a pure function of the id,
// so the memo never needs invalidating. Guarded with a typeof rather than a truthiness test: a bare object
// answers inherited keys like "constructor" with a function, which would throw on .indexOf.
var HAYS = {};
function haystack(block) {
  var b = str(block, "");
  var h = HAYS[b];
  if (typeof h !== "string") {
    var low = b.toLowerCase();
    // A newline cannot occur in a block id, so it is a join no query can straddle.
    h = HAYS[b] = low + "\n" + low.replace(/[_:]/g, " ");
  }
  return h;
}

// The whole VIEW filter in ONE place, so the table and the plots cannot drift apart: a vein shows only if it
// passes ONLY *and* SEARCH. Both are independently visible on the sheet and independently clearable.
function viewKeeps(v) {
  if (onlyBlock != null && v.block !== onlyBlock) { return false; }
  if (queryNorm && haystack(v.block).indexOf(queryNorm) < 0) { return false; }
  return true;
}

// Every vein as a plot point: [dx, dy, dz, count, paletteIndex]. Nearest MAP_CAP only; a block outside the
// palette gets -1 and draws grey. The page derives bearing/depth/distance from dx/dy/dz itself.
//
// The view filter (ONLY *and* SEARCH) is applied HERE and not on the page, which is most of its value:
// "where is the diamond" is a MAP question, and MAP_CAP then spends its whole budget on the ore you asked for
// instead of on the nearest 400 lumps of coal. (A page-side filter could only ever hide dots that had already
// won the cap.)
function buildMap(c) {
  var out = [], i, idx = {};
  for (i = 0; i < c.palette.length; i++) { idx[c.palette[i]] = i; }
  for (i = 0; i < c.veins.length && out.length < MAP_CAP; i++) {
    var v = c.veins[i];
    if (!viewKeeps(v)) { continue; }
    if (v.dx == null || v.dy == null || v.dz == null) { continue; }
    var pi = idx[v.block];
    out.push([Math.round(v.dx), Math.round(v.dy), Math.round(v.dz),
              v.count == null ? 1 : v.count, (pi == null ? -1 : pi)]);
  }
  return out;
}

// How scarce a vein's ORE is, as the sort key: how many of it the whole scan found, fewest = rarest
// (E3P9-D22). Falls back to the rarity fraction — the same ranking, since rarity descending IS type count
// ascending — and last to "treat it as common", so a record missing both sinks rather than displacing a real
// find. Never distance: RAREST ranks ORES, and there is already a NEAREST sort.
function scarcityOf(v) {
  if (v.typeCount != null) { return v.typeCount; }
  if (v.rarity != null) { return 1 - v.rarity; }        // 0..1, same direction, never collides with a count
  return 1e9;
}
function byDist(a, b) {
  return (a.dist == null ? 1e9 : a.dist) - (b.dist == null ? 1e9 : b.dist);
}

// The table's veins, narrowed by the view filter (ONLY *and* SEARCH, via the one viewKeeps the plots use) and
// then ordered. Filtering before the sort is what keeps the page count, the rank column and the "N shown"
// readout all talking about the same set of rows.
//
// RAREST is scarcest ORE first, then the ore is kept WHOLE, then nearest within it, then the id — a total
// order, so a row never swaps places with an equal-ranked sibling between two polls of the same survey.
//
// The ore-grouping key is load-bearing, not decoration. Two ores that happen to have the SAME survey count
// (18 monazite and 18 xychorium, say) tie on scarcity, and without it the tie falls through to distance and
// the two ores INTERLEAVE — 51m monazite, 53m xychorium, 61m xychorium, 61m monazite. That reads as a broken
// sort even though every row is correctly ranked, because "rarest" promises a ranking of ORES and a reader
// can only see that if each ore's veins are contiguous. Tied ores are ordered by their own NEAREST vein, so
// among equally-scarce ores the one you can actually reach comes first — alphabetical would be arbitrary.
//
// (It used to rank by a per-VEIN rarity, which measured how small an individual lump was: every one-block
// find scored the same and the tie fell through to distance, so the top of the list was "the nearest junk".
// The user's read of it was exact — "maybe it sorts by rarest AND closest".)
function sortedVeins(c) {
  var v = [], i;
  for (i = 0; i < c.veins.length; i++) {
    if (viewKeeps(c.veins[i])) { v.push(c.veins[i]); }
  }
  if (sortMode === "rarity") {
    var near = {};                          // ore -> its nearest vein, over the FILTERED set the table shows
    for (i = 0; i < v.length; i++) {
      var bk = v[i].block || "", bd = v[i].dist == null ? 1e9 : v[i].dist;
      if (near[bk] == null || bd < near[bk]) { near[bk] = bd; }
    }
    v.sort(function (a, b) {
      var as = scarcityOf(a), bs = scarcityOf(b);
      if (as !== bs) { return as - bs; }                                  // fewest found first
      var ab = a.block || "", bb = b.block || "";
      if (ab !== bb) {                                                   // keep each ore whole
        var an = near[ab] == null ? 1e9 : near[ab], bn = near[bb] == null ? 1e9 : near[bb];
        if (an !== bn) { return an - bn; }                               // closest tied ore first
        return ab < bb ? -1 : 1;                                         // total, so groups never reshuffle
      }
      var d = byDist(a, b);
      if (d !== 0) { return d; }                                         // then nearest within the ore
      return (a.id || "") < (b.id || "") ? -1 : ((a.id || "") > (b.id || "") ? 1 : 0);
    });
  } else {
    v.sort(byDist);
  }
  return v;
}

// The vein table is paged on the SERVER: one page of rows in the state, so 4,000 veins cost the same as 4
// and every viewer is looking at the same page.
//
// Each row carries BOTH halves of the E3P9-D22 rarity: `typeCount` is what the column prints ("x3" — the
// number that tells an operator WHY allthemodium is at the top, which "0.9998" does not), and `rarity` is
// what the bar is drawn from, against the filtered set's own maximum so it scales whatever the scan found.
// Rarity is published to THREE decimals, not one: the type-level score is ~1 for every scarce ore in a big
// survey, so r1 would round the whole rare end of the table to a flat 1 — identical bars, and (worse) a row
// signature that could not see a change.
function buildRows(c) {
  var all = sortedVeins(c);
  var pages = Math.max(1, Math.ceil(all.length / ROWS));
  if (rowPage >= pages) { rowPage = pages - 1; }
  if (rowPage < 0) { rowPage = 0; }
  var start = rowPage * ROWS, rows = [], i, maxR = 0;
  for (i = 0; i < all.length; i++) { if (all[i].rarity != null && all[i].rarity > maxR) { maxR = all[i].rarity; } }
  for (i = start; i < Math.min(all.length, start + ROWS); i++) {
    var v = all[i];
    rows.push({
      id: v.id, block: v.block, count: v.count,
      dist: r1(v.dist), bearing: ri(v.bearing), cardinal: v.cardinal, depth: ri(v.depth),
      typeCount: v.typeCount, rarity: r3(v.rarity), x: v.x, y: v.y, z: v.z
    });
  }
  return { rows: rows, page: rowPage, pages: pages, total: all.length,
           maxRarity: r3(maxR), rank: start + 1 };
}

// `status().focused` is documented as "focused" without saying whether it is the id or the record
// (E3P9-D7), so BOTH are accepted: a string is resolved against the survey we hold, an object is read as a
// record, and if the field is absent entirely the last id we focused ourselves is used.
function focusedFrom(st, c) {
  var f = st ? st.rawFocused : null;
  if (typeof f === "string" && f.length) {
    var hit = c.byId[f];
    if (hit) { return hit; }
    return { id: f, block: blockOfId(f), count: null, x: null, y: null, z: null,
             dx: null, dy: null, dz: null, dist: null, bearing: null, cardinal: null,
             depth: null, typeCount: null, rarity: null };
  }
  if (f && typeof f === "object") {
    var rec = veinRec(f);
    if (rec && rec.id && c.byId[rec.id]) { return c.byId[rec.id]; }       // prefer our fuller copy
    return rec;
  }
  if (focusId && c.byId[focusId]) { return c.byId[focusId]; }
  return null;
}

// ===========================================================================================
//  the detector overlay (optional, silently absent)
// ===========================================================================================

function findDetector() {
  var all = network.devices(), first = null, i;
  for (i = 0; i < all.length; i++) {
    if (all[i].kind !== DET_KIND) { continue; }
    if (DETECTOR && (all[i].id === DETECTOR || all[i].label === DETECTOR)) { return all[i]; }
    if (!first) { first = all[i]; }
  }
  return DETECTOR ? null : first;
}

// Mobs as scanner-relative marks: [dx, dz, flag] with flag 0 = friendly mob, 1 = hostile, 2 = player.
// The detector reports its entities in ABSOLUTE positions, so this needs the scan origin — which is why
// the overlay only appears once a pulse has found something to align against.
function readMobs(origin, r) {
  var have = false, on = false, pts = [], count = 0, note = null;
  var dev = findDetector();
  if (dev) {
    have = true;
    if (!overlay) {
      note = "overlay off";
    } else if (!dev.online) {
      note = "detector offline";
    } else if (!origin) {
      note = "needs a survey to align";
    } else {
      on = true;
      try {
        var list = listOf(dev.call("scan"), 512);
        var rows = [];
        for (var i = 0; i < list.length; i++) {
          var e = list[i], p = e ? e.pos : null;
          if (!p) { continue; }
          var ex = num(p.x), ez = num(p.z);
          if (ex == null || ez == null) { continue; }
          var dx = ex - origin.x, dz = ez - origin.z;
          // Cull to the plot, which is a SQUARE now (the cube's footprint, E3P9-D21) — a circular cut here
          // would drop exactly the mobs standing over the corners of the surveyed ground.
          if (r != null && (Math.abs(dx) > r + 1 || Math.abs(dz) > r + 1)) { continue; }
          var flag = (str(e.kind, "") === "player") ? 2 : (e.hostile ? 1 : 0);
          rows.push([Math.round(dx), Math.round(dz), flag, dx * dx + dz * dz]);
        }
        count = rows.length;
        rows.sort(function (a, b) { return a[3] - b[3]; });                          // nearest first
        for (var j = 0; j < rows.length && pts.length < MOB_CAP; j++) {
          pts.push([rows[j][0], rows[j][1], rows[j][2]]);
        }
        note = str(dev.label, dev.id);
      } catch (e2) {
        on = false;
        note = "detector refused: " + e2;
        print("geo-prospector: detector scan failed - " + e2);
      }
    }
  }
  return { have: have, on: on, count: count, pts: pts, note: note };
}

// ===========================================================================================
//  alarms — derived from the snapshot, no extra device calls
// ===========================================================================================

function buildAlarms(st, c, cfg, fatal) {
  var out = [];
  function add(level, text) { out.push({ level: level, text: text }); }

  if (!st.online) {
    add("warn", "scanner offline — chunk unloaded or the block is gone");
    return out;
  }
  if (st.error) {
    // The `geo` door welded shut lands here (the verbs throw, the block itself keeps working).
    add("crit", "the scanner refused the call: " + str(fatal, "unknown error"));
    add("warn", "if that names the `geo` capability, an admin has welded that door shut in "
      + "config/silica-server.toml — the block's own hologram, GUI and compass still work.");
    return out;
  }

  if (st.clampedByServer) {
    add("warn", "server clamps the radius to " + (st.maxRadius == null ? "?" : st.maxRadius)
      + " (geoScannerMaxRange) — the installed chip's extra range is ignored");
  }
  if (st.partial || (c.survey && c.survey.partial)) {
    var sk = (st.skippedChunks != null) ? st.skippedChunks : (c.survey ? c.survey.skippedChunks : null);
    add("warn", "survey is PARTIAL — " + (sk == null ? "some" : sk)
      + " unloaded chunk(s) were skipped, never loaded. The map has holes and the depth histogram is biased.");
  }
  if (c.truncated) {
    add("warn", "raw hits truncated at " + (c.hitCap == null ? "the cap" : c.hitCap)
      + " — the sweep runs bottom-up, so the histogram covers only the bottom of the cube. "
      + "Narrow the filter or drop the radius for a trustworthy depth recommendation.");
  }
  if (st.scanning && st.energyPct != null && st.energyPct <= 0) {
    add("crit", "no power while sweeping — the sweep is paused, progress is held");
  } else if (st.scanning && c.stallFrames >= 4) {
    add("crit", "sweep has not advanced for " + c.stallFrames + " ticks — brownout or a stalled budget");
  }
  if (!st.hasResult && !st.scanning) {
    add("none", "no survey yet — press PULSE");
  } else if (st.hasResult && st.ageTicks != null && st.ageTicks > 6000) {
    add("warn", "survey is " + fmtAge(st.ageTicks) + " old — re-pulse before trusting it");
  }
  if (cfg && cfg.filter && cfg.filter.length === 0) {
    add("warn", "the scanner's filter is empty — nothing can match");
  }
  if (out.length === 0) { add("none", "no advisories — survey nominal"); }
  return out;
}

// ===========================================================================================
//  the authoritative state the page renders from
// ===========================================================================================

// Chips: every scanner on the network, from network.devices() alone — no device calls, so extra scanners
// cost nothing. Only the SELECTED one is ever read.
function roster() {
  var all = network.devices(), out = [], i;
  for (i = 0; i < all.length; i++) {
    if (!isScanner(all[i])) { continue; }
    out.push({ id: all[i].id, label: nameOf(all[i]), online: !!all[i].online });
  }
  out.sort(byLabel);
  return out;
}

function resolveSelection(list) {
  var i;
  if (SCANNER) {                                   // a pinned scanner always wins
    for (i = 0; i < list.length; i++) {
      if (list[i].id === SCANNER || list[i].label === SCANNER) { return list[i].id; }
    }
    return null;
  }
  for (i = 0; i < list.length; i++) { if (list[i].id === sel) { return sel; } }
  for (i = 0; i < list.length; i++) { if (list[i].online) { return list[i].id; } }
  return list.length ? list[0].id : null;
}

function buildState() {
  frame++;

  var list = roster();
  var ids = [], i;
  for (i = 0; i < list.length; i++) { ids.push(list[i].id); }
  pruneCaches(ids);

  sel = resolveSelection(list);
  if (!sel) {
    return {
      ok: false, frame: frame,
      reason: SCANNER
        ? ("No geo_scanner named '" + SCANNER + "' on this computer's network. Check the name at the top of "
           + "entrypoint.js, or clear it to auto-discover.")
        : ("No Geo Scanner on the network. Place one adjacent to this computer or wire it in (a pylon face "
           + "works too), install a NIC, and check the `network` + `geo` doors in config/silica-server.toml.")
    };
  }

  var dev = network.find(sel);
  var c = cacheFor(sel);
  var st, fatal = null;

  if (!dev || !dev.online) {
    st = offlineStatus();
    c.lastAge = null;
  } else {
    try {
      st = readStatus(dev);
    } catch (e) {
      // A welded `geo` door lands here: the verbs throw and the block keeps working standalone. Say so
      // instead of pretending the scanner is missing.
      print("geo-prospector: status failed - " + e);
      st = offlineStatus();
      st.online = true;
      st.error = true;
      fatal = String(e);
    }
  }

  // --- sweep-stall watch (a brownout pauses the sweep with progress intact, E3P9-D4) ---
  if (st.scanning) {
    if (c.lastProgress != null && st.progress != null && st.progress <= c.lastProgress) { c.stallFrames++; }
    else { c.stallFrames = 0; }
    c.lastProgress = st.progress;
  } else {
    c.stallFrames = 0;
    c.lastProgress = null;
  }
  scanning = !!st.scanning;
  if (st.maxRadius != null) { c.maxRadius = st.maxRadius; }

  // --- a NEW pulse landed? ageTicks counts UP from the moment a result completed, so a LOWER age than we
  // last saw is a fresh result — which catches pulses fired from the block GUI or by a redstone edge just
  // as well as our own button. ---
  if (st.online && !st.error && dev) {
    if (!st.hasResult) {
      c.lastAge = null;
    } else if (c.lastAge == null || (st.ageTicks != null && st.ageTicks < c.lastAge)) {
      try { ingestResult(dev, c, st.radius); }
      catch (e2) { print("geo-prospector: reading the survey failed - " + e2); }
      c.cfgAge = 99;                                // re-read the filter with a new survey
    }
    // ONLY track the age of a real result. status() reports ageTicks = 0 while there is no result (it only
    // counts up once hasResult is set), so tracking it unconditionally seeded lastAge = 0 before the first
    // pulse -- and then "is this fresher?" asked `ageTicks < 0`, which is false forever, so the very first
    // result was never ingested. The symptom was the app polling status every second and never once calling
    // survey/veins/scan, while the block's own GUI listed the findings normally.
    if (st.hasResult && st.ageTicks != null) { c.lastAge = st.ageTicks; }

    // --- filter + radius: cheap, but it only changes when somebody changes it ---
    c.cfgAge++;
    if (c.cfgAge >= CONFIG_EVERY) {
      try {
        var cg = dev.call("config", {});
        var f = listOf(cg ? cg.filter : null, 64), fl = [];
        for (i = 0; i < f.length; i++) { var s = str(f[i], null); if (s) { fl.push(s); } }
        c.cfg = {
          filter: fl,
          radius: num(cg ? cg.radius : null),
          edge: cubeSpan(cg ? cg.edge : null, cg ? cg.radius : null),
          depth: cubeSpan(cg ? cg.depth : null, cg ? cg.radius : null)
        };
      } catch (e3) { print("geo-prospector: config read failed - " + e3); }
      c.cfgAge = 0;
    }
  }

  var cfg = c.cfg || { filter: [], radius: null, edge: null, depth: null };
  var r = (c.survey && c.survey.radius != null) ? c.survey.radius : st.radius;
  var mobs = readMobs(c.origin, r);
  var table = buildRows(c);

  return {
    ok: true,
    frame: frame,
    reason: null,
    fatal: fatal,
    scanners: list,
    sel: sel,
    st: {
      online: st.online, error: st.error, scanning: st.scanning,
      progress: r1(st.progress), radius: st.radius, edge: st.edge, depth: st.depth,
      maxRadius: st.maxRadius,
      clampedByServer: st.clampedByServer, chip: st.chip,
      cooldownTicks: st.cooldownTicks, hasResult: st.hasResult, ageTicks: st.ageTicks,
      ageText: fmtAge(st.ageTicks), partial: st.partial, skippedChunks: st.skippedChunks,
      feDraw: st.feDraw, energy: st.energy, energyPct: r1(st.energyPct)
    },
    cfg: { filter: cfg.filter, radius: cfg.radius, edge: cfg.edge, depth: cfg.depth,
           preset: presetKeyOf(cfg.filter) },
    presets: presetButtons(),
    survey: c.survey,
    truncated: c.truncated, hits: c.hits, hitCap: c.hitCap,
    origin: c.origin,
    palette: c.palette,
    map: buildMap(c),
    rows: table.rows, page: table.page, pages: table.pages, rowTotal: table.total,
    rank: table.rank, maxRarity: table.maxRarity, sort: sortMode,
    // `rowTotal` is the FILTERED table's length; `veinsHeld` is the whole survey's, so the headline counts
    // in the header rule and the scanner card keep reporting the survey rather than the current view.
    // `search` is echoed back AS TYPED so every viewer's box shows the same live query — see the page's
    // renderSearchBox for why that echo must never be written over somebody's caret.
    only: onlyBlock, search: query, veinsHeld: c.veins.length,
    focused: focusedFrom(st, c),
    hist: c.hist,
    rec: c.rec,
    tally: c.tally, tallyMore: c.tallyMore,
    sites: c.sites.slice(0),
    mobs: mobs,
    alarms: buildAlarms(st, c, cfg, fatal),
    last: lastAction
  };
}

// Which preset (if any) the scanner's live filter currently equals — so the page can light that button.
function presetKeyOf(filter) {
  if (!filter) { return null; }
  var i, j;
  for (i = 0; i < PRESETS.length; i++) {
    var p = PRESETS[i].filter;
    if (p.length !== filter.length) { continue; }
    var same = true;
    for (j = 0; j < p.length; j++) { if (filter.indexOf(p[j]) < 0) { same = false; break; } }
    if (same) { return PRESETS[i].key; }
  }
  return null;
}

function presetButtons() {
  var out = [], i;
  for (i = 0; i < PRESETS.length; i++) { out.push({ key: PRESETS[i].key, label: PRESETS[i].label }); }
  return out;
}

// One authoritative build + publish. Wrapped: web.setState throws above the configured appStateMaxChars, and
// an admin who LOWERS that knob (or raises the display caps above) could get us there — losing the sheet
// entirely over a too-big map would be a worse failure than losing the map, so the plots are dropped and the
// rest survives. This is the only reason the caps above can be tuned without reading server config.
function publish(s) {
  try {
    web.setState(s);
  } catch (e) {
    print("geo-prospector: state too large, publishing without the plots - " + e);
    s.map = [];
    s.hist = null;
    s.mobs = { have: s.mobs ? s.mobs.have : false, on: false, count: 0, pts: [], note: "state trimmed" };
    s.sites = s.sites ? s.sites.slice(0, 5) : [];
    try { web.setState(s); } catch (e2) { print("geo-prospector: state publish failed - " + e2); }
  }
}

function push() { lastSnapshot = buildState(); publish(lastSnapshot); }

// ===========================================================================================
//  control (the server holds ALL authority; every request is re-validated against a live device)
// ===========================================================================================

function record(action, ok, text) {
  lastAction = { action: action, ok: !!ok, text: text };
}

// The selected scanner as a live, ONLINE device — or null, with the refusal recorded.
function liveScanner(action) {
  var dev = sel ? network.find(sel) : null;
  if (!dev || !isScanner(dev) || !dev.online) {
    record(action, false, "No live Geo Scanner selected.");
    return null;
  }
  return dev;
}

function doPulse() {
  var dev = liveScanner("pulse");
  if (!dev) { return; }
  try {
    var ack = dev.call("pulse", {});
    if (ack && ack.started === false) {
      var cd = num(ack.cooldownTicks);
      record("pulse", false, "Cooling down — " + (cd == null ? "wait" : Math.ceil(cd / TICKS_PER_SEC) + "s")
        + " before the next pulse.");
      return;
    }
    var sw = num(ack ? ack.sweepTicks : null);
    record("pulse", true, "Pulse away" + (sw == null ? "" : " — sweeping " + (sw / TICKS_PER_SEC).toFixed(1) + "s"));
    print("geo-prospector: pulse -> " + sel);
  } catch (e) {
    record("pulse", false, "Pulse refused — " + e);
    print("geo-prospector: pulse refused - " + e);
  }
}

// Filters are applied BY KEY out of the PRESETS table above — the wire never carries a block id or tag, so
// no client can ask the scanner to look for something the operator never put in this file.
function doPreset(key) {
  var dev = liveScanner("preset");
  if (!dev) { return; }
  var p = null, i;
  for (i = 0; i < PRESETS.length; i++) { if (PRESETS[i].key === key) { p = PRESETS[i]; break; } }
  if (!p) { record("preset", false, "Unknown filter preset."); return; }
  try {
    dev.call("config", { filter: p.filter });
    var c = cacheFor(sel);
    c.cfgAge = 99;
    record("preset", true, "Filter -> " + p.label + " (" + p.filter.join(", ") + "). Pulse again to re-survey.");
    print("geo-prospector: filter -> " + p.key);
  } catch (e) {
    record("preset", false, "Filter refused — " + e);
    print("geo-prospector: config filter refused - " + e);
  }
}

// Radius steppers, never a slider: a native <input type=range> drag is not deliverable through MCEF (E3P1 —
// wall screens are tap-only and the desktop forwards no held-button state).
function doRadius(delta, toMax) {
  var dev = liveScanner("radius");
  if (!dev) { return; }
  var c = cacheFor(sel);
  try {
    // Authoritative re-read of the CURRENT radius (never the page's number). `maxRadius` comes from the
    // last status read a second ago instead of a third device call — it only moves when a chip is installed
    // or an admin edits geoScannerMaxRange, and the block clamps whatever we ask for anyway.
    var cur = dev.call("config", {});
    var have = num(cur ? cur.radius : null);
    var max = c.maxRadius;
    var want = toMax ? (max == null ? have : max) : ((have == null ? 16 : have) + delta);
    if (max != null) { want = Math.min(want, max); }
    want = Math.max(1, Math.round(want));
    var ack = dev.call("config", { radius: want });
    var got = num(ack ? ack.radius : null);
    if (got == null) { got = want; }
    var edge = cubeSpan(ack ? ack.edge : null, got);
    if (c.cfg) {                                   // so a rapid second press steps from here
      c.cfg.radius = got;
      c.cfg.edge = edge;
      c.cfg.depth = cubeSpan(ack ? ack.depth : null, got);
    }
    c.cfgAge = 99;
    record("radius", true, "Radius -> " + got + (max == null ? "" : " (max " + max + ")")
      + " — a " + edge + " block cube, all of it BELOW the scanner.");
  } catch (e) {
    record("radius", false, "Radius refused — " + e);
    print("geo-prospector: config radius refused - " + e);
  }
}

function doFocus(id) {
  var dev = liveScanner("focus");
  if (!dev) { return; }
  var c = cacheFor(sel);
  var want = str(id, null);
  if (!want || !c.byId[want]) { record("focus", false, "Unknown vein."); return; }   // untrusted input
  try {
    // E3P9-D7 writes this verb as `focus(id)` without saying how the id rides the args object, so the
    // natural {id} shape is tried first and a bare-string arg is the fallback. If BOTH refuse, the second
    // error is the one reported (a welded `geo` door refuses either shape identically).
    try { dev.call("focus", { id: want }); }
    catch (e0) { dev.call("focus", want); }
    focusId = want;
    var v = c.byId[want];
    record("focus", true, "Focused " + shortBlock(v.block) + " — " + Math.round(v.dist) + "m "
      + (v.cardinal || "?") + ", " + (v.depth == null ? "?" : (v.depth < 0
        ? (Math.abs(Math.round(v.depth)) + " below") : (Math.round(v.depth) + " above")))
      + ". The compass now points at it.");
  } catch (e) {
    record("focus", false, "Focus refused — " + e);
    print("geo-prospector: focus refused - " + e);
  }
}

// The ONLY view filter. Unlike every other control on this sheet it calls NO device at all — it re-cuts a
// survey already in hand, so it is instant, costs nothing, and cannot be refused by a welded `geo` door.
// Untrusted input all the same: the block must be one THIS survey actually holds, so the wire can never
// park the sheet on a block that would only ever show an empty table.
function doOnly(block) {
  var want = str(block, null);
  if (!want) {                                     // null / missing / "" clears — never a refusal
    if (onlyBlock != null) { rowPage = 0; }
    onlyBlock = null;
    // The two view filters are independent, so clearing one must not claim to have cleared the other.
    record("only", true, queryNorm
      ? ("ONLY cleared — search \"" + queryNorm + "\" still holds.")
      : "Showing every block in the survey again.");
    return;
  }
  var c = sel ? cacheFor(sel) : null;
  if (!c || !c.veinBlocks[want]) {
    record("only", false, "No " + shortBlock(want) + " vein in the survey this scanner is holding.");
    return;
  }
  onlyBlock = want;
  rowPage = 0;                                     // a new set of rows always starts at its first page
  record("only", true, "Showing ONLY " + shortBlock(want)
    + " — the vein table and both plots. The scanner's own scan filter is untouched.");
}

// The SEARCH query. Like ONLY it calls NO device — it re-cuts a survey already in hand, so it is instant,
// costs nothing and cannot be refused by a welded `geo` door. Untrusted input all the same, and unlike ONLY it
// is FREE TEXT, so it gets the two guards free text needs: a length cap (it rides the state snapshot back to
// every viewer, and appStateMaxChars is finite) and no interpretation whatsoever — it is a plain substring
// test, never a pattern, never anything the scanner is told.
//
// The page sends this DEBOUNCED as the operator types, and re-sends if an echo never arrives, so the same
// value can land twice: an unchanged query returns early rather than resetting the page under a re-send.
function doSearch(q) {
  var want = (typeof q === "string") ? q : "";
  if (want.length > SEARCH_MAX) { want = want.slice(0, SEARCH_MAX); }
  var norm = want.replace(/^\s+|\s+$/g, "").toLowerCase();
  if (want === query && norm === queryNorm) { return; }        // an echo / re-send of what we already hold
  query = want;
  queryNorm = norm;
  rowPage = 0;                                     // a different set of rows always starts at its first page
  // The page prints the action name ahead of this text ("SEARCH — ..."), so neither line repeats the word.
  if (!norm) {
    record("search", true, "Cleared" + (onlyBlock != null
      ? (" — ONLY " + shortBlock(onlyBlock) + " still holds.") : " — showing every vein in the survey."));
  } else {
    record("search", true, "Filtering to \"" + norm + "\" — the vein table and both plots show matching blocks"
      + (onlyBlock != null ? (", within ONLY " + shortBlock(onlyBlock)) : "")
      + ". No pulse needed; the scanner's own scan filter is untouched.");
  }
}

function handle(msg) {
  if (!msg || typeof msg.action !== "string") { return; }
  var a = msg.action;

  if (a === "poll") { return; }

  if (a === "select") {
    var id = str(msg.id, null);
    var d = id ? network.find(id) : null;
    if (!d || !isScanner(d)) { record(a, false, "Unknown scanner."); return; }
    sel = d.id;
    rowPage = 0;
    pruneOnly(cacheFor(sel));      // this scanner's survey may hold nothing of the filtered block
    return;
  }
  if (a === "pulse") { doPulse(); return; }
  if (a === "preset") { doPreset(str(msg.key, null)); return; }
  if (a === "radius") { doRadius(num(msg.delta) || 0, msg.max === true); return; }
  if (a === "focus") { doFocus(msg.id); return; }
  if (a === "only") { doOnly(msg.block); return; }
  if (a === "search") { doSearch(msg.q); return; }
  if (a === "sort") {
    var m = str(msg.mode, null);
    if (SORTS.indexOf(m) < 0) { return; }
    sortMode = m;
    rowPage = 0;
    return;
  }
  if (a === "page") {
    rowPage += (num(msg.delta) || 0) > 0 ? 1 : -1;      // buildRows clamps against the real page count
    if (rowPage < 0) { rowPage = 0; }
    return;
  }
  if (a === "mobs") {
    overlay = !!msg.on;
    record(a, true, "Detector overlay " + (overlay ? "ON" : "OFF"));
    return;
  }
  // Anything unrecognised is a no-op; the clock still publishes fresh state.
}

// ===========================================================================================
//  the server clock — WHY THIS APP DOES NOT WAIT ON THE PAGE
// ===========================================================================================
// A `web_message` exists only while some player's browser is running this page, so a plain
// os.pullEvent("web_message") parks FOREVER in an empty world. That is how a fission reactor melted down in
// this project once: the STATE was server-authoritative, the CADENCE was borrowed from the client
// (UF0724-D5). os.pullEvent(filter, seconds) returns null on timeout, which lets this loop keep its own
// clock — so a sweep completes, its survey is ingested, and its diff lands in the site log whether or not
// anyone is watching.

function cadence() { return scanning ? SCAN_MS : SWEEP_MS; }

// Re-arm from NOW — never `nextTickMs += cadence()`. After a lag spike the next cycle is simply late; it
// never queues a catch-up burst of reads into an already struggling tick thread.
function markTicked() {
  nextTickMs = HAS_CLOCK ? (Date.now() + cadence()) : 0;
  msgsSinceTick = 0;
}

function tickDue() {
  if (HAS_CLOCK) { return Date.now() >= nextTickMs; }
  return msgsSinceTick >= 2;
}

// Whatever is LEFT on the deadline, so an arriving message does not restart the clock (that is what would
// let a steady poll stream starve the clock). Capped at the cadence against a backwards clock jump, floored
// at 0 — and pullEvent rounds any value up to one whole game tick, so this can never busy-spin.
function waitSeconds() {
  if (!HAS_CLOCK) { return cadence() / 1000; }
  var left = nextTickMs - Date.now();
  var cap = cadence();
  if (left > cap) { left = cap; }
  if (left < 0) { left = 0; }
  return left / 1000;
}

// ===========================================================================================
//  run
// ===========================================================================================

web.openFile("ui/index.html");   // resolves relative to this app's own folder
push();                          // initial render
markTicked();

while (true) {
  var ev = os.pullEvent("web_message", waitSeconds());

  if (ev) {
    msgsSinceTick++;
    var msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { msg = null; }
    var action = msg && msg.action;

    if (action && action !== "poll") {
      // Control action — immediate, never debounced, never served from the cache: handle() re-resolves the
      // target live, then we rebuild and publish at once. Re-arming the clock here is what stops a button
      // press and the clock tick behind it from reading the scanner twice.
      handle(msg);
      push();
      markTicked();
      continue;
    }

    // Bare poll / heartbeat / unparsable frame — re-publish what the clock already built. ZERO device
    // calls, so the number of viewers cannot change the device-call rate at all.
    if (lastSnapshot) { publish(lastSnapshot); }
  }

  // The clock tick — the half that has to run with nobody watching.
  if (!ev || tickDue()) {
    push();
    markTicked();
  }
}
