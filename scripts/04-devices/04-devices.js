// 04-devices.js — the network browser.
//
// WHAT   Lists every device this computer can reach — label, id, kind, online, faculties —
//        plus the energy buffer and inventory of the ones that have them. Re-reads on a
//        timer and prints only when something changed, so it can be left running while you
//        build: new blocks appear on the list as you wire them in.
// NEEDS  A network card (NIC). A device is reachable if it is face-adjacent to this
//        computer, wired to it, or across a Router -> Receiver pair.
// SETUP  Wire your blocks in, then label them with a screwdriver — that label is the name
//        every other script in this folder uses to address a device.
// TWEAK  REFRESH_SEC, KIND, SHOW_DETAIL, ROW_CAP.

const REFRESH_SEC = 5;      // how often to re-read the network
const KIND = "";            // "" = every kind; else only this one, e.g. "detector" or "port"
const SHOW_DETAIL = true;   // also read energy + inventory (one extra call per device that has one)
const ROW_CAP = 16;         // most rows to print at once

// A door you lack throws on every access, so the only way to ask is to try it and catch.
function probe(fn) { try { fn(); return true; } catch (e) { return false; } }
const HAS_GFX = probe(function () { gfx.width(); });
const HAS_NET = probe(function () { network.devices(); });

if (!HAS_NET) {
  print("04-devices: this computer has no network card. Install a NIC to reach the network.");
  while (true) { os.pullEvent(); }   // park rather than crash: the message stays readable
}

function fmt(n) {
  return n >= 1000000 ? (n / 1000000).toFixed(1) + "M" : (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
}

// One row per device. Every faculty read is wrapped: a chunk can unload between listing a device
// and calling it, and an unreadable device should cost you one line, not the whole script.
function inspect(d) {
  const row = { name: d.label || d.id, kind: d.kind, online: d.online, info: "", icon: null };
  if (!d.online) {
    row.info = "offline (chunk unloaded or block gone)";
    return row;
  }
  const bits = [];
  if (SHOW_DETAIL && d.faculties.indexOf("energy") >= 0) {
    try {
      const e = d.energy();
      const pct = e.capacity > 0 ? Math.round(e.stored * 100 / e.capacity) : 0;
      bits.push(fmt(e.stored) + "/" + fmt(e.capacity) + " FE (" + pct + "%)");
    } catch (err) { bits.push("energy: " + err); }
  }
  if (SHOW_DETAIL && d.faculties.indexOf("items") >= 0) {
    try {
      const stacks = d.items.list();
      let total = 0;
      for (let i = 0; i < stacks.length; i++) { total += stacks[i].count; }
      bits.push(stacks.length + " stack(s), " + total + " item(s)");
      if (stacks.length > 0) { row.icon = stacks[0].id; }
    } catch (err) { bits.push("items: " + err); }
  }
  row.info = bits.length ? bits.join("  ") : "can: " + (d.faculties.join(", ") || "nothing");
  return row;
}

function scan() {
  const all = network.devices();
  const rows = [];
  for (let i = 0; i < all.length; i++) {
    if (!KIND || all[i].kind === KIND) { rows.push(inspect(all[i])); }
  }
  return rows;
}

function draw(rows) {
  if (!HAS_GFX) { return; }
  const shown = Math.min(rows.length, 8);
  gfx.clear(0x0b1020);
  gfx.rect(0, 0, gfx.width(), 20, 0x5fd08a);
  gfx.text(8, 6, "NETWORK - " + rows.length + " device(s)", 0x0b1020);
  for (let i = 0; i < shown; i++) {
    const y = 30 + i * 18;
    const name = rows[i].name;
    gfx.rect(8, y + 3, 6, 6, rows[i].online ? 0x5fd08a : 0xff6b6b);
    if (rows[i].icon) { gfx.sprite(18, y - 2, rows[i].icon); }   // first stack in that inventory
    gfx.text(38, y, name.length > 15 ? name.substring(0, 14) + "~" : name, 0xd7e0ee);
    gfx.text(150, y, rows[i].kind, 0x8a93a6);
  }
  if (rows.length > shown) {
    gfx.text(8, 30 + shown * 18, "+" + (rows.length - shown) + " more - see the terminal", 0x8a93a6);
  } else if (rows.length === 0) {
    gfx.text(8, 40, "nothing reachable", 0xff6b6b);
  }
}

print("04-devices: watching the network" + (KIND ? " for kind '" + KIND + "'" : "")
    + ", re-reading every " + REFRESH_SEC + "s. Printing only when something changes.");

let last = null;

while (true) {
  const rows = scan();

  // Print the table only when the picture actually differs — otherwise a browser left running
  // buries everything else in an endless identical list.
  const signature = rows.map(function (r) { return r.name + "|" + r.online + "|" + r.info; }).join(";");
  if (signature !== last) {
    last = signature;
    print("--- " + rows.length + " device(s) ---");
    for (let i = 0; i < rows.length && i < ROW_CAP; i++) {
      const r = rows[i];
      print("  " + (r.online ? "[on ]" : "[OFF]") + " " + r.name + "  [" + r.kind + "]  " + r.info);
    }
    if (rows.length > ROW_CAP) {
      print("  ...and " + (rows.length - ROW_CAP) + " more (raise ROW_CAP to see them).");
    } else if (rows.length === 0) {
      print("  Nothing reachable. Wire a block to this computer, or clear KIND if you set it.");
    }
  }

  draw(rows);
  os.sleep(REFRESH_SEC);
}
