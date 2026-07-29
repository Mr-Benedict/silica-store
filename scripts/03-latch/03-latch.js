// 03-latch.js — a redstone toggle (a T flip-flop, in software).
//
// WHAT   A pulse in flips an output that STAYS flipped until the next pulse. One button
//        turns a lamp, a door or a farm on; the same button turns it off again. Building
//        this out of vanilla redstone takes a chest-load of parts and a lot of floor space.
// NEEDS  Nothing beyond a working computer. A hard drive is optional: with one, the latch
//        remembers its state across a restart instead of coming back off.
// SETUP  Wire a button, lever or pressure plate to IN_SIDE of this computer, and wire what
//        you want toggled to OUT_SIDE. A button or plate is the natural fit: one press, one
//        flip. A lever works, but only switching it ON counts — switching it back off does
//        nothing, so it takes two lever throws to get one flip.
// TWEAK  IN_SIDE, OUT_SIDE, LEVEL, REMEMBER.

const IN_SIDE = "north";    // pulse this face to flip the latch
const OUT_SIDE = "south";   // this face holds the latched state
const LEVEL = 15;           // output level while latched on, 0-15
const REMEMBER = true;      // save the state to disk so a restart comes back the same way

// A door you lack throws on every access, so the only way to ask is to try it and catch.
function probe(fn) { try { fn(); return true; } catch (e) { return false; } }
const HAS_GFX = probe(function () { gfx.width(); });
const HAS_FS = probe(function () { fs.has("silica-latch"); });

const SAVE_KEY = "03-latch." + OUT_SIDE;   // one saved state per output face
const REMEMBERING = REMEMBER && HAS_FS;

let on = REMEMBERING && fs.read(SAVE_KEY) === "on";
let flips = 0;

function draw() {
  if (!HAS_GFX) { return; }
  const W = gfx.width();
  gfx.clear(0x0b1020);
  gfx.rect(0, 0, W, 20, on ? 0x5fd08a : 0x1c2540);
  gfx.text(8, 6, "LATCH - " + IN_SIDE + " in / " + OUT_SIDE + " out", on ? 0x0b1020 : 0x8a93a6);

  gfx.rect(20, 46, 96, 60, on ? 0x5fd08a : 0x1c2540);
  gfx.text(52, 68, on ? "ON" : "OFF", on ? 0x0b1020 : 0x4a5570);

  gfx.text(132, 50, "out " + (on ? LEVEL : 0) + " / 15", 0xd7e0ee);
  gfx.text(132, 68, "flips " + flips, 0x8a93a6);
  gfx.text(20, 124, REMEMBERING ? "state saved to disk" : "no drive: resets on restart", 0x8a93a6);
  gfx.text(20, 142, "pulse " + IN_SIDE + " to flip", 0x8a93a6);
}

function apply() {
  redstone.setOutput(OUT_SIDE, on ? LEVEL : 0);
  if (REMEMBERING) {
    fs.write(SAVE_KEY, on ? "on" : "off");
  }
  draw();
}

print("03-latch: " + IN_SIDE + " pulse flips " + OUT_SIDE + ". Starting " + (on ? "ON" : "OFF") + ".");
if (REMEMBER && !HAS_FS) {
  print("03-latch: no hard drive, so the latch forgets its state on restart.");
}
apply();

// Only the RISING edge counts, so holding a lever down is one flip, not thousands: we remember
// what the face looked like last time and act only when it goes from cold to hot.
let wasHigh = redstone.getInput(IN_SIDE) > 0;

// pullEvent, not sleep. os.sleep DISCARDS whatever arrives while it is parked, so a button press
// during the nap would be lost; a script that must not miss an edge waits on the event itself.
// The event fires for a change on ANY face, which is why we still re-read IN_SIDE and compare.
while (true) {
  os.pullEvent("redstone");

  const high = redstone.getInput(IN_SIDE) > 0;
  if (high && !wasHigh) {
    on = !on;
    flips++;
    apply();
    print("03-latch: flip " + flips + " -> " + (on ? "ON" : "OFF"));
  }
  wasHigh = high;
}
