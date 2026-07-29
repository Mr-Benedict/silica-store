// stock-display/entrypoint.js — server-side entry for the Stock Display (multi-file Path B).
// Points at any inventory on the Silica network — a chest behind a Port, a Collector's buffer, a modded
// storage block — and puts it on a screen: how full it is, what is in it by NAME, and a tag filter that
// keeps working when the player installs a mod.
//
// ALL capability access is here on the server. The page holds no authority: it asks for a refresh or a
// filter with mc.send, and this script answers with an authoritative snapshot (client messages are
// untrusted input).
//
// Read this file for the shape of the widened `items` faculty (epic3-phase-10):
//   * summary()  — one call for "42 / 54 slots" AND "1,204 cobblestone". It never throws on size.
//   * list()     — one record per non-empty slot, each carrying name / maxCount / damage / tags.
//                  It DOES throw on an inventory bigger than the itemsMaxSlots knob, which is why the
//                  two reads are in separate try blocks here: the fill bar survives a storage block
//                  the row list cannot.
//   * detail(s)  — ONE slot's full record plus its data components. Per slot and opt-in on purpose
//                  (E3P10-D4): it costs a game-thread round trip each time, so it is driven by a TAP on
//                  an item row and by nothing else — never the sweep, never a viewer poll.
//   * tags       — the filter chips below are built from the tags actually present. No item ids in this
//                  file at all, which is the whole point: it sorts modded wood it has never heard of.
//
// Capability doors: network (needs a NIC installed) + web (needs web-display).
//
// Set up: a smart computer (SilicaOS ROM + GPU + web-display) with a NIC; wire a Port onto a chest (or
// wire a Collector straight to the computer); run this from the Runner and stream it to a screen, or
// open it on a pad or pocket. Screwdriver-label the inventory you want "stock"; otherwise it takes the
// first device on the network that advertises the `items` faculty.

const NAME = "stock";           // the label this app looks for first; "" = first items device found
const MAX_ROWS = 60;            // item rows published (a page can only show so many anyway)
const MAX_TAGS = 12;            // filter chips published, most-common first
const MAX_FIELD_ROWS = 200;     // flattened component rows published for one inspected slot

// --- the server clock: WHY THIS APP DOES NOT WAIT ON THE PAGE ---
// A faculty call runs on the server TICK THREAD, and this app reads the inventory twice per sweep. With
// the untimed os.pullEvent("web_message") the loop would advance once per *viewer poll*, so five people
// looking at the same screen would cost five times the reads — the viewer count, not the app, setting
// the load. os.pullEvent(filter, seconds) returns null on timeout, which lets the loop keep its own:
//
//   * exactly ONE inventory sweep per SWEEP_MS, however many people are watching;
//   * a bare poll re-publishes the CACHED reading — zero faculty calls;
//   * a filter click re-derives the view from that same cached reading — also zero.
const SWEEP_MS = 1500;
const NOCLOCK_SWEEP_EVERY = 2;  // no Date.now() at all (see HAS_CLOCK): sweep every 2nd message instead

// Date.now() is a plain ECMAScript intrinsic (no host access) and DOES work in the Silica sandbox.
// Guarded anyway: without it the clock degrades to a message-counted debounce rather than throwing.
const HAS_CLOCK = (typeof Date !== "undefined" && typeof Date.now === "function");

let nextSweepMs = 0;      // the server clock's deadline (see markSwept)
let msgsSinceSweep = 0;   // no-clock fallback counter
let reading = null;       // the last raw device reading — re-filtered without touching the device again
let filterTag = "";       // server-held, so every viewer of the same screen sees the same board
let detail = null;        // the open slot card — ONE detail() call, held until it is closed or moved

// The inventory to watch: prefer the labelled one, else the first device advertising `items`.
// Re-resolved every sweep, so it recovers if the block is replaced or a chunk reloads.
function findStock() {
  const all = network.devices();
  let first = null;
  for (let i = 0; i < all.length; i++) {
    const d = all[i];
    if (d.faculties.indexOf("items") < 0) { continue; }   // the honest predicate — ask, don't guess
    if (NAME && d.label === NAME) { return d; }
    if (!first) { first = d; }
  }
  return first;
}

// "minecraft:cobblestone" -> "Cobblestone". Only ever a FALLBACK: list() reports the real display name,
// and this is for an id that appears in summary().totals but in no listed row (a storage block too big
// for list(), most likely).
function prettify(id) {
  const s = String(id || "").replace(/^[^:]*:/, "").replace(/_/g, " ").trim();
  if (!s) { return "?"; }
  return s.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

// ---- the device read -------------------------------------------------------------------------

// Two reads, two try blocks, on purpose. summary() is bounded by distinct item ids and never refuses on
// size; list() throws on an inventory past the itemsMaxSlots knob because a partial list would be worse
// than none. Keeping them apart means a 4096-slot storage block still gets a fill bar and totals.
function read() {
  const dev = findStock();
  if (!dev) {
    return { ok: false, reason: "No inventory found. Wire a Port onto a chest (and install a NIC)." };
  }
  if (!dev.online) {
    return { ok: false, reason: "'" + (dev.label || dev.id) + "' is offline (chunk unloaded or removed)." };
  }

  let sum;
  try {
    sum = dev.items.summary();
  } catch (e) {
    // `online` was true a moment ago, which is not a promise it still is. Report it as a card the
    // viewer can read rather than letting it kill the app, page and all.
    return { ok: false, reason: "'" + (dev.label || dev.id) + "' stopped answering: " + e };
  }

  let rows = [];
  let listNote = "";
  try {
    rows = dev.items.list();
  } catch (e) {
    listNote = String(e);   // over the slot cap, most likely — the summary above still stands
  }

  return {
    ok: true,
    name: dev.label || dev.id,
    slots: sum.slots, scanned: sum.scanned, used: sum.used, free: sum.free,
    totals: sum.totals,
    rows: rows,
    listNote: listNote
  };
}

// ---- the slot inspector: the ONE place this app spends a detail() call -----------------------

// detail(slot) is the "only if you really have to" door (E3P10-D4): one game-thread round trip per slot,
// which is exactly why the faculty made it per-slot instead of a components flag on list(). So it is
// driven by a TAP and cached:
//
//   * the sweep never calls it — read() above stays two calls, however long a card is left open;
//   * a viewer poll never calls it — publish() re-sends the cached card for free, like the filter;
//   * tapping the SAME row again is a no-op, and only a different slot or the explicit re-read button
//     spends another one.
//
// Which slot does a row mean? A row is a TOTAL across every slot holding that item, so it maps to the
// slots holding it, first one first — and the card can step through them. That stepper is the point on an
// inventory of enchanted books: they are all `minecraft:enchanted_book`, so they are one row, and their
// components are the only thing that tells them apart.

// The slots holding `id`, ascending — list() walks in slot order. Pure: derived from the cached reading.
function slotsHolding(rows, id) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].id === id) { out.push(rows[i].slot); }
  }
  return out;
}

// The card skeleton every state shares. `state` is one of ok / empty / refused / gone / noslot, and every
// state that is not "ok" carries a `reason` the page shows instead of the record — the same treatment the
// board already gives an offline device.
function card(rowId, slot, slots, state, reason) {
  let at = -1;
  for (let i = 0; i < slots.length; i++) { if (slots[i] === slot) { at = i; break; } }
  return { rowId: rowId, slot: slot, slots: slots, at: at, state: state, reason: reason || "" };
}

// A component map is an arbitrarily nested object — a written book's pages, a modded machine's saved
// inventory, a bundle's contents — and a wall screen can neither scroll a tree nor expand one. So it is
// flattened HERE into dot-path rows ("minecraft:stored_enchantments.minecraft:sharpness" -> 5) which the
// page pages with the same up/down control as the item list. An empty container still gets a row: a key
// that is silently absent looks identical to one that was never there.
//
// Bounded by MAX_FIELD_ROWS on top of the server's own itemComponentMaxNodes — that knob bounds the map,
// this bounds what we put on the wire.
function flatten(value, path, out) {
  if (out.length >= MAX_FIELD_ROWS) { return; }
  if (value === null || value === undefined) { out.push({ k: path, v: "null" }); return; }
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") { out.push({ k: path, v: String(value) }); return; }
  // Nested values cross the sandbox seam as host-backed objects rather than native ones, so ask for the
  // array shape both ways rather than trusting Array.isArray alone.
  if (Array.isArray(value) || (t === "object" && typeof value.length === "number")) {
    if (!value.length) { out.push({ k: path, v: "[]" }); return; }
    for (let i = 0; i < value.length; i++) {
      flatten(value[i], path + "[" + i + "]", out);
      if (out.length >= MAX_FIELD_ROWS) { return; }
    }
    return;
  }
  const keys = [];
  for (const k in value) {
    if (Object.prototype.hasOwnProperty.call(value, k)) { keys.push(k); }
  }
  if (!keys.length) { out.push({ k: path, v: "{}" }); return; }
  keys.sort();
  for (let i = 0; i < keys.length; i++) {
    flatten(value[keys[i]], path ? path + "." + keys[i] : keys[i], out);
    if (out.length >= MAX_FIELD_ROWS) { return; }
  }
}

// tags arrive as a host-backed array; copy it into a plain one before it goes on the wire.
function copyList(a) {
  const out = [];
  if (!a) { return out; }
  for (let i = 0; i < a.length; i++) { out.push(String(a[i])); }
  return out;
}

// The one call. Both of detail()'s edges are answered as a CARD, never as a throw that kills the app:
// a slot the handler does not have throws, an empty slot returns null (E3P10-D11), and they are different
// enough questions to deserve different answers on screen.
function fetchDetail(rowId, slot, slots) {
  const dev = findStock();
  if (!dev) {
    return card(rowId, slot, slots, "gone",
      "The inventory has left the network. Tap BACK and try again once it is wired up.");
  }
  if (!dev.online) {
    return card(rowId, slot, slots, "gone",
      "'" + (dev.label || dev.id) + "' is offline (chunk unloaded or removed).");
  }

  let rec;
  try {
    rec = dev.items.detail(slot);        // <- the entire faculty cost of this feature, once per tap
  } catch (e) {
    // A slot the handler does not have. Ordinary in the world: the chest was swapped for a smaller one
    // between the sweep that listed this row and the tap that asked about it.
    return card(rowId, slot, slots, "refused", String(e));
  }
  if (rec === null || rec === undefined) {
    // A legitimate question with a legitimate answer — the slot exists and holds nothing.
    return card(rowId, slot, slots, "empty",
      "Slot " + slot + " is empty. Whatever was here has been taken or moved since the last sweep.");
  }

  const c = card(rowId, slot, slots, "ok", "");
  c.id = rec.id;
  c.name = rec.name;
  c.count = rec.count;
  c.maxCount = rec.maxCount;
  c.damage = rec.damage;
  c.maxDamage = rec.maxDamage;
  c.tags = copyList(rec.tags);
  // The visible end of the whole cap chain: itemComponentMaxDepth / itemComponentMaxNodes, and the shared
  // node budget the caps are spent from. The page gives this its own card state, not a quiet field —
  // a half-converted map a script believed was whole is the failure the flag exists to prevent.
  c.truncated = !!rec.truncated;
  const fields = [];
  flatten(rec.components, "", fields);
  c.fields = fields;
  c.capped = fields.length >= MAX_FIELD_ROWS;   // OUR wire cap, distinct from the server's truncation
  return c;
}

// A tap on a row. Resolves the slot from the cached reading, then spends at most one faculty call.
function openDetail(rawId, rawSlot) {
  const rowId = (rawId == null) ? "" : String(rawId);
  // Untrusted input from the page: only a real JSON number is a slot. Number("") and Number(null) are
  // both 0, so coercing here would turn a missing field into a read of slot 0.
  let slot = (typeof rawSlot === "number" && isFinite(rawSlot)) ? Math.floor(rawSlot) : -1;
  const slots = (reading && reading.ok) ? slotsHolding(reading.rows, rowId) : [];
  if (slot < 0) { slot = slots.length ? slots[0] : -1; }

  if (slot < 0) {
    // A row that came from summary().totals with no listed slot behind it — list() was refused past
    // itemsMaxSlots. The board knows the item is in there but not where, and saying so beats guessing.
    return card(rowId, -1, slots, "noslot",
      "This row is a summary() total: the slot list was refused past the itemsMaxSlots cap, so there is no"
      + " slot to inspect. Point the board at a smaller inventory, or raise itemsMaxSlots.");
  }
  // The cache. A second tap on the open row costs nothing; only a different slot spends a call.
  if (detail && detail.rowId === rowId && detail.slot === slot && detail.state !== "gone") { return detail; }
  return fetchDetail(rowId, slot, slots);
}

// ---- deriving the published view (no device access below this line) --------------------------

// Item id -> display name, from the listed rows. Names come off list(); summary() only counts.
function nameIndex(rows) {
  const out = {};
  for (let i = 0; i < rows.length; i++) { out[rows[i].id] = rows[i].name; }
  return out;
}

// Which tags are worth offering as filters: every tag present, ranked by how many stacks carry it.
function tagChips(rows) {
  const counts = {};
  for (let i = 0; i < rows.length; i++) {
    const tags = rows[i].tags;
    for (let j = 0; j < tags.length; j++) { counts[tags[j]] = (counts[tags[j]] || 0) + 1; }
  }
  const out = [];
  for (const tag in counts) {
    if (Object.prototype.hasOwnProperty.call(counts, tag)) { out.push({ tag: tag, stacks: counts[tag] }); }
  }
  out.sort(function (a, b) { return b.stacks - a.stacks || (a.tag < b.tag ? -1 : 1); });
  return out.slice(0, MAX_TAGS);
}

// Unfiltered, the totals come straight from summary() — already aggregated server-side, and correct even
// for slots list() never saw. Filtered, they are re-aggregated from the rows, because only a row knows
// its tags.
function itemRows(raw, tag) {
  const names = nameIndex(raw.rows);
  const totals = {};
  if (tag) {
    for (let i = 0; i < raw.rows.length; i++) {
      const r = raw.rows[i];
      if (r.tags.indexOf(tag) >= 0) { totals[r.id] = (totals[r.id] || 0) + r.count; }
    }
  } else {
    for (const id in raw.totals) {
      if (Object.prototype.hasOwnProperty.call(raw.totals, id)) { totals[id] = raw.totals[id]; }
    }
  }
  const out = [];
  for (const id in totals) {
    if (Object.prototype.hasOwnProperty.call(totals, id)) {
      // `slot` is what makes a row tappable: the first slot holding this item, and `held` how many slots
      // hold it, so the detail card can step through them. -1 when list() was refused and the row is a
      // summary() total with no slot behind it — the inspector says so rather than guessing one.
      const at = slotsHolding(raw.rows, id);
      out.push({
        id: id, name: names[id] || prettify(id), count: totals[id],
        slot: at.length ? at[0] : -1, held: at.length
      });
    }
  }
  out.sort(function (a, b) { return b.count - a.count || (a.name < b.name ? -1 : 1); });
  return out.slice(0, MAX_ROWS);
}

// The open card as it goes on the wire. The RECORD is the cached one and must stay that way — re-reading
// it here would put a detail() call behind every publish, which is behind every viewer poll, which is the
// one thing this app's whole shape exists to avoid. Only the stepper's slot list is re-derived, and that
// is free: it comes out of the cached reading, not the device.
function detailView() {
  if (!detail) { return null; }
  const out = {};
  for (const k in detail) {
    if (Object.prototype.hasOwnProperty.call(detail, k)) { out[k] = detail[k]; }
  }
  const slots = (reading && reading.ok) ? slotsHolding(reading.rows, detail.rowId) : detail.slots;
  out.slots = slots;
  out.at = -1;
  for (let i = 0; i < slots.length; i++) { if (slots[i] === detail.slot) { out.at = i; break; } }
  return out;
}

function view(raw) {
  if (!raw || !raw.ok) { return raw; }
  const rows = itemRows(raw, filterTag);
  let items = 0;
  for (let i = 0; i < rows.length; i++) { items += rows[i].count; }
  return {
    ok: true,
    name: raw.name,
    slots: raw.slots, used: raw.used, free: raw.free,
    partial: raw.scanned < raw.slots,   // the cap cut the walk short — say so rather than imply a full read
    scanned: raw.scanned,
    listNote: raw.listNote,
    filter: filterTag,
    tags: tagChips(raw.rows),
    rows: rows,
    detail: detailView(),
    distinct: rows.length,
    items: items
  };
}

function publish() { web.setState(view(reading)); }
function sweep() { reading = read(); publish(); }

// ---- the server clock ------------------------------------------------------------------------

// Re-arm the deadline from NOW — never `nextSweepMs += SWEEP_MS`. After a lag spike the next cycle is
// simply late; it never queues a catch-up burst of sweeps into an already struggling tick thread.
function markSwept() {
  nextSweepMs = HAS_CLOCK ? (Date.now() + SWEEP_MS) : 0;
  msgsSinceSweep = 0;
}

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
sweep();
markSwept();

while (true) {
  // null on timeout. NOT a plain pullEvent: with nobody watching, no web_message is ever produced.
  const ev = os.pullEvent("web_message", waitSeconds());

  if (ev) {
    msgsSinceSweep++;
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { msg = null; }   // untrusted input from the page
    if (msg && msg.action === "filter") {
      // A filter is a VIEW change, not a device question: re-derive from the cached reading, so a room
      // full of people clicking chips costs the tick thread nothing at all.
      filterTag = (msg.tag == null) ? "" : String(msg.tag);
    } else if (msg && msg.action === "inspect") {
      // The one message that may spend a faculty call — and at most one, only when the slot changes.
      detail = openDetail(msg.id, msg.slot);
    } else if (msg && msg.action === "reread" && detail && detail.slot >= 0) {
      // The card is a snapshot of the moment it was taken; this is the only way to take another, and it
      // is deliberately a button rather than a timer. A timer would be a detail() call per tick per open
      // card, which is the per-viewer server work the read()/view() split exists to prevent.
      detail = fetchDetail(detail.rowId, detail.slot, detail.slots);
    } else if (msg && msg.action === "close") {
      detail = null;
    }
    publish();
  }

  // The clock tick: the fresh device read. `!ev` = the timeout fired; sweepDue() = a message woke us
  // early but the deadline has since passed.
  if (!ev || sweepDue()) {
    sweep();
    markSwept();
  }
}
