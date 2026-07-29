// 02-lamp.js — a redstone pulser.
//
// WHAT   Drives one face on and off forever, on a period you set. A software clock: no
//        repeater loop to build, no observer trick, and the timing is one number you edit.
//        Good for a lamp, a dispenser, a piston door, or a farm on a duty cycle.
// NEEDS  Nothing beyond a working computer — redstone is always available.
// SETUP  Put the computer next to whatever you want to pulse, and set SIDE to face it.
// TWEAK  SIDE, ON_SEC, OFF_SEC, LEVEL, CYCLES, LOG_EVERY.

const SIDE = "north";     // which face to drive: north|south|east|west|up|down
const ON_SEC = 1;         // seconds the face stays powered
const OFF_SEC = 1;        // seconds it stays off
const LEVEL = 15;         // redstone level while on, 0-15 (a comparator can read the difference)
const CYCLES = 0;         // how many on/off pairs to run; 0 = forever
const LOG_EVERY = 0;      // print a line every N cycles; 0 = stay quiet after the banner

// A door you lack throws on every access, so the only way to ask is to try it and catch.
function probe(fn) { try { fn(); return true; } catch (e) { return false; } }
const HAS_GFX = probe(function () { gfx.width(); });

// Sleeps round to whole game ticks, minimum one, so anything under 0.05 s becomes a single
// tick: twenty on/off pairs a second is as fast as this can go.
const PERIOD = ON_SEC + OFF_SEC;

print("02-lamp: pulsing " + SIDE + " — " + ON_SEC + "s on at level " + LEVEL
    + ", " + OFF_SEC + "s off (" + PERIOD + "s period, "
    + (CYCLES === 0 ? "forever" : CYCLES + " cycles") + ").");
if (!HAS_GFX) {
  print("02-lamp: no GPU, so no screen indicator — the redstone still works.");
}

function draw(on, cycles) {
  if (!HAS_GFX) { return; }
  const W = gfx.width();
  gfx.clear(0x0b1020);
  gfx.rect(0, 0, W, 20, on ? 0xffd166 : 0x1c2540);
  gfx.text(8, 6, "PULSER - " + SIDE, on ? 0x0b1020 : 0x8a93a6);

  // The lamp itself: a big block of colour, bright while the face is powered.
  gfx.rect(20, 44, 84, 84, on ? 0xffd166 : 0x1c2540);
  gfx.rect(28, 52, 68, 68, on ? 0xfff3c4 : 0x141c33);
  gfx.text(46, 140, on ? "ON " + LEVEL : "OFF", on ? 0xffd166 : 0x4a5570);

  gfx.text(124, 48, "on   " + ON_SEC + "s", 0xd7e0ee);
  gfx.text(124, 66, "off  " + OFF_SEC + "s", 0xd7e0ee);
  gfx.text(124, 84, "period " + PERIOD + "s", 0x8a93a6);
  gfx.text(124, 110, "cycles " + cycles, 0x5fd08a);
  if (CYCLES > 0) {
    gfx.text(124, 128, "of " + CYCLES, 0x8a93a6);
  }
}

let cycles = 0;

// os.sleep parks the script off the compute budget, so this loop is idle between edges rather
// than spinning. A while(true) with no sleep or pullEvent in it would be killed by the
// per-tick budget within a tick — every loop in this folder yields.
while (CYCLES === 0 || cycles < CYCLES) {
  redstone.setOutput(SIDE, LEVEL);
  draw(true, cycles);
  os.sleep(ON_SEC);

  redstone.setOutput(SIDE, 0);
  draw(false, cycles);
  os.sleep(OFF_SEC);

  cycles++;
  if (LOG_EVERY > 0 && cycles % LOG_EVERY === 0) {
    print("02-lamp: " + cycles + " cycle(s).");
  }
}

// Only reachable with CYCLES > 0. Leave the face cold rather than however it happened to end.
redstone.setOutput(SIDE, 0);
print("02-lamp: finished " + cycles + " cycle(s); " + SIDE + " left off.");
