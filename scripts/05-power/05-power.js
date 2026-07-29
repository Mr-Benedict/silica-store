// 05-power.js — an energy gauge with a low-power alarm.
//
// WHAT   Watches one device's energy buffer, shows a gauge, and powers a redstone face when
//        the charge falls to LOW_PCT — releasing it only once the charge climbs back above
//        CLEAR_PCT. That gap is the whole point: a buffer hovering on a single threshold
//        would switch your backup generator on and off several times a second.
// NEEDS  A NIC, and a wired device with an energy buffer — a Port on an energy cube or a
//        machine, a Powercell, a Turret: anything whose faculties include "energy".
// SETUP  Screwdriver-label the device, put that label in TARGET, and wire the backup
//        generator (or a lamp, or a siren) to ALARM_SIDE of THIS computer.
// TWEAK  TARGET, LOW_PCT, CLEAR_PCT, ALARM_SIDE, ALARM_LEVEL, POLL_SEC, ALARM_ON_LOST, LOG_EVERY.

const TARGET = "battery";      // screwdriver label (or device id) of the thing to watch
const LOW_PCT = 20;            // alarm switches ON at or below this percentage
const CLEAR_PCT = 40;          // ...and OFF again only at or above this one
const ALARM_SIDE = "down";     // face of THIS computer that carries the alarm
const ALARM_LEVEL = 15;        // level to drive while alarmed, 0-15
const POLL_SEC = 2;            // seconds between readings
const ALARM_ON_LOST = true;    // treat "cannot read the device" as an alarm too
const LOG_EVERY = 30;          // print the charge every N readings; 0 = only on a change

function probe(fn) { try { fn(); return true; } catch (e) { return false; } }
const HAS_GFX = probe(function () { gfx.width(); });
const HAS_NET = probe(function () { network.devices(); });
const HAS_RS = probe(function () { redstone.getInput(ALARM_SIDE); });

if (!HAS_NET) {
  print("05-power: this computer has no network card. Install a NIC to reach '" + TARGET + "'.");
  while (true) { os.pullEvent(); }   // park rather than crash: the message stays readable
}

function fmt(n) {
  return n >= 1000000 ? (n / 1000000).toFixed(1) + "M"
      : (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n)));
}

// Resolve and read in one go, and never throw: every failure comes back as a reason string, so a
// chunk unloading under the target degrades to a message instead of killing the alarm.
function read() {
  const d = network.find(TARGET);
  if (!d) { return { why: "no device labelled '" + TARGET + "' on the network" }; }
  if (!d.online) { return { why: "'" + TARGET + "' is offline (chunk unloaded or block gone)" }; }
  if (d.faculties.indexOf("energy") < 0) {
    return { why: "'" + TARGET + "' has no energy buffer (can: " + d.faculties.join(", ") + ")" };
  }
  try {
    const e = d.energy();
    if (!e || e.capacity <= 0) { return { why: "'" + TARGET + "' reports a zero capacity" }; }
    return { ok: true, stored: e.stored, capacity: e.capacity, pct: e.stored * 100 / e.capacity };
  } catch (err) { return { why: String(err) }; }
}

function draw(r, alarm) {
  if (!HAS_GFX) { return; }
  const W = gfx.width();
  gfx.clear(0x0b1020);
  gfx.rect(0, 0, W, 20, alarm ? 0xff6b6b : 0x5fd08a);
  gfx.text(8, 6, "POWER - " + TARGET, 0x0b1020);
  if (!r.ok) {
    gfx.text(10, 46, "no reading", 0xff6b6b);
    gfx.text(10, 64, r.why.length > 34 ? r.why.substring(0, 33) + "~" : r.why, 0x8a93a6);
    return;
  }
  const pct = Math.round(r.pct);
  const barW = W - 40;
  gfx.rect(20, 56, barW, 22, 0x1c2540);
  gfx.rect(20, 56, Math.round(barW * Math.min(pct, 100) / 100), 22, alarm ? 0xff6b6b : 0x5fd08a);
  gfx.vLine(20 + Math.round(barW * LOW_PCT / 100), 50, 34, 0xff6b6b);     // the alarm threshold
  gfx.vLine(20 + Math.round(barW * CLEAR_PCT / 100), 50, 34, 0xffd166);   // the release threshold
  gfx.text(20, 32, pct + "%", 0xd7e0ee);
  gfx.text(20, 96, fmt(r.stored) + " / " + fmt(r.capacity) + " FE", 0xd7e0ee);
  gfx.text(20, 120, alarm ? "ALARM - " + ALARM_SIDE + " is live" : "ok", alarm ? 0xff6b6b : 0x5fd08a);
  gfx.text(20, 144, "alarm at " + LOW_PCT + "%, clears at " + CLEAR_PCT + "%", 0x8a93a6);
}

print("05-power: watching '" + TARGET + "'. Alarm on " + ALARM_SIDE + " at " + LOW_PCT
    + "%, clears at " + CLEAR_PCT + "%, reading every " + POLL_SEC + "s.");
if (CLEAR_PCT < LOW_PCT) {
  print("05-power: CLEAR_PCT is below LOW_PCT — the alarm will chatter. Raise it above " + LOW_PCT + ".");
}
if (!HAS_RS) {
  print("05-power: the redstone door is closed, so the alarm is display-only.");
}

let alarm = false;
let lastWhy = "";
let polls = 0;

while (true) {
  const r = read();

  if (r.ok) {
    lastWhy = "";
    if (!alarm && r.pct <= LOW_PCT) {
      alarm = true;
      print("05-power: ALARM — '" + TARGET + "' down to " + Math.round(r.pct) + "%.");
    } else if (alarm && r.pct >= CLEAR_PCT) {
      alarm = false;
      print("05-power: clear — '" + TARGET + "' back up to " + Math.round(r.pct) + "%.");
    }
  } else {
    if (r.why !== lastWhy) {
      lastWhy = r.why;
      print("05-power: cannot read — " + r.why);
    }
    alarm = ALARM_ON_LOST || alarm;   // a gauge that goes quiet when its target vanishes is a trap
  }

  if (HAS_RS) { redstone.setOutput(ALARM_SIDE, alarm ? ALARM_LEVEL : 0); }
  draw(r, alarm);

  polls++;
  if (LOG_EVERY > 0 && polls % LOG_EVERY === 0 && r.ok) {
    print("05-power: '" + TARGET + "' at " + Math.round(r.pct) + "% (" + fmt(r.stored)
        + " / " + fmt(r.capacity) + " FE)" + (alarm ? " — alarmed" : ""));
  }
  os.sleep(POLL_SEC);
}
