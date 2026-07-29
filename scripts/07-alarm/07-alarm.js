// 07-alarm.js — a proximity alarm driven by an Entity Detector.
//
// WHAT   Reads an Entity Detector on this computer's own clock and powers a redstone face
//        while something you care about is inside TRIP_DIST, holding the line for HOLD_SEC
//        after the last contact leaves so it cannot chatter as a mob walks over the line.
// NEEDS  A NIC and an Entity Detector wired to this computer (the 'detector' capability
//        door must be open — it is by default).
// SETUP  Wire the Detector in and label it with a screwdriver; put that label in DETECTOR ("" =
//        use the first one found). Wire what you want triggered to ALARM_SIDE of THIS computer.
// TWEAK  DETECTOR, WATCH, TRIP_DIST, HOLD_SEC, ALARM_SIDE, POLL_SEC.

const DETECTOR = "";        // label or id of the Detector; "" = the first one on the network
const WATCH = "hostile";    // what counts as a contact: "hostile" | "player" | "any"
const TRIP_DIST = 8;        // blocks: a contact closer than this trips the alarm
const HOLD_SEC = 5;         // keep the line hot this long after the last contact leaves
const ALARM_SIDE = "down";  // face of THIS computer that carries the alarm
const POLL_SEC = 1;         // seconds between reads (the block scans on its own clock anyway)

function probe(fn) { try { fn(); return true; } catch (e) { return false; } }
const HAS_GFX = probe(function () { gfx.width(); });
const HAS_NET = probe(function () { network.devices(); });

if (!HAS_NET) {
  print("07-alarm: this computer has no network card. Install a NIC to reach the Detector.");
  while (true) { os.pullEvent(); }   // park rather than crash: the message stays readable
}

const HOLD_POLLS = Math.max(1, Math.ceil(HOLD_SEC / POLL_SEC));
let range = TRIP_DIST, contacts = [], lastWhy = "", alarm = false, hold = 0;   // range: read below

function find() {
  if (DETECTOR) { return network.find(DETECTOR); }
  const all = network.devices();
  for (let i = 0; i < all.length; i++) { if (all[i].kind === "detector") { return all[i]; } }
  return null;
}

// Keep only what we care about, nearest first. Never throws: a missing, unloaded or unreadable
// Detector comes back as a reason string instead of killing the alarm.
function sweep() {
  const d = find();
  const missing = DETECTOR ? "no device labelled '" + DETECTOR + "'" : "no Entity Detector";
  if (!d) { return { why: missing + " on the network" }; }
  if (!d.online) { return { why: "the Detector is offline (chunk unloaded or block gone)" }; }
  let rows;
  try {
    rows = d.call("scan");                     // DetectorRecord[]: name, kind, dx, dz, dist, hostile
  } catch (err) { return { why: String(err) }; }
  const hits = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], want = WATCH === "any" || (WATCH === "player" ? r.kind === "player" : r.hostile);
    if (want && r.dist <= TRIP_DIST) { hits.push(r); }
  }
  hits.sort(function (a, b) { return a.dist - b.dist; });
  return { hits: hits };
}

function draw() {
  if (!HAS_GFX) { return; }
  const cx = 62, cy = 104, R = 54, scale = R / Math.max(1, range);
  gfx.clear(0x0b1020);
  gfx.rect(0, 0, gfx.width(), 20, alarm ? 0xff6b6b : 0x5fd08a);
  gfx.text(8, 6, alarm ? "ALARM - " + contacts.length + " contact(s)" : "CLEAR", 0x0b1020);
  gfx.rect(cx - R, cy - R, R * 2, R * 2, 0x101a33);      // the dish, centred on the Detector
  gfx.hLine(cx - R, cy, R * 2, 0x1c2540);
  gfx.vLine(cx, cy - R, R * 2, 0x1c2540);
  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];                               // dx / dz are offsets from the block
    const x = cx + Math.round(Math.max(-range, Math.min(range, c.dx)) * scale);
    const y = cy + Math.round(Math.max(-range, Math.min(range, c.dz)) * scale);
    gfx.rect(x - 1, y - 1, 3, 3, c.hostile ? 0xff6b6b : (c.kind === "player" ? 0x6bb8ff : 0x5fd08a));
  }
  gfx.text(cx - R, cy + R + 10, "range " + range + "  trip " + TRIP_DIST, 0x4a5570);
  gfx.text(136, 34, "watch " + WATCH + "  out " + ALARM_SIDE, 0xd7e0ee);
  for (let i = 0; i < contacts.length && i < 5; i++) {
    gfx.text(136, 58 + i * 16, contacts[i].name.substring(0, 12) + " " + contacts[i].dist, 0xffd166);
  }
  if (contacts.length === 0) { gfx.text(136, 58, lastWhy ? "no reading" : "all clear", 0x8a93a6); }
}

// One config read at startup: it gives the radar its outer edge, and catches the trap where the
// block's own filter can never report the thing you armed the alarm against.
try {
  const cfg = find().call("config");
  range = cfg.range;
  if (cfg.filter.length === 0) {
    print("07-alarm: this Detector's filter is EMPTY — it matches nothing and will never trip.");
  }
} catch (err) { print("07-alarm: no config read at startup (" + err + ") — radar uses TRIP_DIST."); }
print("07-alarm: watching " + WATCH + " within " + TRIP_DIST + " blocks of "
    + (DETECTOR || "the first Detector found") + ". Alarm on " + ALARM_SIDE + ", held "
    + HOLD_SEC + "s, read every " + POLL_SEC + "s.");
while (true) {
  const r = sweep();
  if (r.why) {
    contacts = [];
    if (r.why !== lastWhy) { lastWhy = r.why; print("07-alarm: cannot read — " + r.why); }
  } else {
    lastWhy = "";
    const wasEmpty = contacts.length === 0;
    contacts = r.hits;
    if (contacts.length > 0) {
      hold = HOLD_POLLS;                       // re-armed by every sweep that still sees something
      if (wasEmpty) {
        print("07-alarm: contact — " + contacts[0].name + " at " + contacts[0].dist + " blocks"
            + (contacts.length > 1 ? " (+" + (contacts.length - 1) + " more)" : ""));
      }
    } else if (hold > 0 && --hold === 0) {
      print("07-alarm: clear.");
    }
  }
  const want = contacts.length > 0 || hold > 0;
  if (want !== alarm) {
    alarm = want;
    try { redstone.setOutput(ALARM_SIDE, alarm ? 15 : 0); }
    catch (err) { print("07-alarm: cannot drive " + ALARM_SIDE + " — " + err + ". Display only."); }
  }
  draw();
  os.sleep(POLL_SEC);
}
