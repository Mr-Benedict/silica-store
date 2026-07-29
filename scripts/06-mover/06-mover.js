// 06-mover.js — an item mover between two networked inventories.
//
// WHAT   Moves items from one labelled device into another, either on a timer or on a
//        redstone pulse, optionally only one item id. The move is simulate-then-execute:
//        it can never dupe or void, and it reports how many items actually went.
// NEEDS  A NIC, and two wired devices whose faculties include "items" — a Port on a chest
//        or a machine, a Collector, an Ejector, a Turret's magazine.
// SETUP  Screwdriver-label the source and the destination and put those names in FROM and
//        TO. In "redstone" mode, pulse TRIGGER_SIDE of this computer to move one batch.
// TWEAK  FROM, TO, MODE, PERIOD_SEC, TRIGGER_SIDE, ITEM, BATCH.

const FROM = "input";           // label (or id) of the device to take items out of
const TO = "output";            // label (or id) of the device to put them into
const MODE = "timer";           // "timer" = every PERIOD_SEC; "redstone" = one batch per pulse
const PERIOD_SEC = 5;           // timer mode only
const TRIGGER_SIDE = "north";   // redstone mode only: pulse this face
const ITEM = "";                // "" = move anything; else one id, e.g. "minecraft:iron_ingot"
const BATCH = 0;                // 0 = as much as fits; else the most items to move per run

function probe(fn) { try { fn(); return true; } catch (e) { return false; } }
const HAS_GFX = probe(function () { gfx.width(); });
const HAS_NET = probe(function () { network.devices(); });

if (!HAS_NET) {
  print("06-mover: this computer has no network card. Install a NIC to reach '" + FROM + "'/'" + TO + "'.");
  while (true) { os.pullEvent(); }   // park rather than crash: the message stays readable
}

let moves = 0, total = 0;          // runs that moved something, and items moved altogether
let status = "waiting", lastWhy = "";
let icon = ITEM || null;           // item id drawn on the screen

// Resolve a label to a usable inventory, or explain why it is not one. Resolved fresh on every
// run, so swapping the chest mid-game just works and an unloaded chunk is a message, not a crash.
function inventory(label) {
  const d = network.find(label);
  if (!d) { return { why: "no device labelled '" + label + "' on the network" }; }
  if (!d.online) { return { why: "'" + label + "' is offline (chunk unloaded or block gone)" }; }
  if (d.faculties.indexOf("items") < 0) {
    return { why: "'" + label + "' has no inventory (can: " + d.faculties.join(", ") + ")" };
  }
  return { dev: d };
}

function moveOnce(announce) {
  const src = inventory(FROM);
  const dst = inventory(TO);
  if (src.why || dst.why) {
    status = src.why || dst.why;
    // Say it once, not every PERIOD_SEC — but always answer a pulse the player just sent.
    if (announce || status !== lastWhy) { lastWhy = status; print("06-mover: " + status); }
    return;
  }
  lastWhy = "";
  const opts = {};
  if (ITEM) { opts.id = ITEM; }
  if (BATCH > 0) { opts.count = BATCH; }
  let moved = 0;
  try {
    moved = src.dev.items.move(dst.dev, opts);
  } catch (err) {
    status = String(err);
    print("06-mover: move failed — " + status);
    return;
  }
  if (moved > 0) {
    moves++;
    total += moved;
    if (!ITEM && HAS_GFX) {
      try {                                    // only so the screen can show what is flowing
        const rest = src.dev.items.list();
        if (rest.length > 0) { icon = rest[0].id; }
      } catch (err) { /* keep the last icon */ }
    }
  }
  status = moved > 0 ? "moved " + moved : "nothing to move";
  if (moved > 0 || announce) {
    print("06-mover: " + status + " from '" + FROM + "' to '" + TO + "'"
        + (ITEM ? " (" + ITEM + ")" : "") + ".");
  }
}

function draw() {
  if (!HAS_GFX) { return; }
  gfx.clear(0x0b1020);
  gfx.rect(0, 0, gfx.width(), 20, 0x5fd08a);
  gfx.text(8, 6, "MOVER - " + MODE, 0x0b1020);
  if (icon) { gfx.sprite(20, 40, icon); }      // the item id currently flowing
  gfx.text(48, 44, FROM + "  ->  " + TO, 0xd7e0ee);
  gfx.text(20, 76, ITEM ? "filter " + ITEM : "filter: everything", 0x8a93a6);
  gfx.text(20, 94, BATCH > 0 ? "batch " + BATCH : "batch: as much as fits", 0x8a93a6);
  gfx.text(20, 120, "runs " + moves + "   items " + total, 0x5fd08a);
  gfx.text(20, 144, status.length > 34 ? status.substring(0, 33) + "~" : status, 0xffd166);
  gfx.text(20, 166, MODE === "timer" ? "every " + PERIOD_SEC + "s" : "pulse " + TRIGGER_SIDE, 0x4a5570);
}

print("06-mover: '" + FROM + "' -> '" + TO + "', " + (ITEM ? "only " + ITEM : "anything") + ", "
    + (MODE === "timer" ? "every " + PERIOD_SEC + "s." : "one batch per " + TRIGGER_SIDE + " pulse."));
draw();

if (MODE === "redstone") {
  // Only the rising edge fires, so a lever left on does not move items forever. pullEvent rather
  // than sleep: sleep discards events, and a dropped button press is a batch that never moved.
  let wasHigh = redstone.getInput(TRIGGER_SIDE) > 0;
  while (true) {
    os.pullEvent("redstone");
    const high = redstone.getInput(TRIGGER_SIDE) > 0;
    if (high && !wasHigh) {
      moveOnce(true);     // you pressed it, so say what happened even if nothing moved
      draw();
    }
    wasHigh = high;
  }
} else {
  while (true) {
    moveOnce(false);      // an idle timer stays quiet; it reports only when items actually move
    draw();
    os.sleep(PERIOD_SEC);
  }
}
