// 01-welcome.js — the hardware and network self-test. Start here.
//
// WHAT   Reports which capability doors this computer has open, which part each closed one
//        wants and what installing it unlocks, what is reachable on the network, and which
//        of the other scripts you can run right now.
// NEEDS  Nothing. This is the one script that runs on a bare motherboard + CPU + RAM.
// SETUP  None — just run it. It only reads; it changes nothing and drives no redstone.
// TWEAK  DEVICE_CAP.

const DEVICE_CAP = 12;   // list at most this many devices, then summarise the rest

// A capability door you lack is not simply missing — it is a stub that THROWS on every access,
// with a message naming the part it wants. So the honest way to ask "do I have a GPU?" is to try
// it and catch. Every script in this folder starts with a probe like this one, which is why a
// missing part costs you a feature instead of killing the script.
function probe(fn) { try { fn(); return true; } catch (e) { return false; } }

const HAS_RS = probe(function () { redstone.getInput("north"); });
const HAS_GFX = probe(function () { gfx.width(); });
const HAS_FS = probe(function () { fs.has("silica-welcome"); });
const HAS_NET = probe(function () { network.devices(); });

const DEVS = HAS_NET ? network.devices() : [];

// part = the card that opens this door, or null for a door only an admin can close.
function door(name, ok, part, unlocks) {
  if (ok) {
    print("  [ OK ] " + name + "  " + unlocks);
  } else if (part) {
    print("  [ -- ] " + name + "  closed — install a " + part + " to unlock " + unlocks + ".");
  } else {
    print("  [ -- ] " + name + "  closed — an admin welded it shut. No " + unlocks + ".");
  }
}

print("=== Silica self-test ===");
print("");
print("Capability doors:");
door("redstone", HAS_RS, null, "control of this computer's own six faces");
door("gfx     ", HAS_GFX, "GPU", "the screen, " + (HAS_GFX ? gfx.width() + "x" + gfx.height() : "256x192") + " pixels");
door("fs      ", HAS_FS, "hard drive", "files that survive a restart");
door("network ", HAS_NET, "network card (NIC)", "wired blocks and other computers");

print("");
if (!HAS_NET) {
  print("Network: no NIC installed, so nothing is reachable at all.");
} else {
  print("Network: " + DEVS.length + " device(s) reachable.");
  for (let i = 0; i < DEVS.length && i < DEVICE_CAP; i++) {
    const d = DEVS[i];
    print("  " + (d.label || d.id) + "  [" + d.kind + "]  " + (d.online ? "online" : "OFFLINE")
        + "  can: " + (d.faculties.length ? d.faculties.join(", ") : "nothing"));
  }
  if (DEVS.length > DEVICE_CAP) {
    print("  ...and " + (DEVS.length - DEVICE_CAP) + " more.");
  }
  if (DEVS.length === 0) {
    print("  Nothing wired up yet. Put a peripheral against this computer, run a wire to it,");
    print("  or reach further with a Switch or a Router -> Receiver pair.");
  }
  print("  Tip: name a device with a screwdriver — most scripts here address devices by label.");
}

const NET_OK = HAS_NET ? "ready" : "needs a NIC";
print("");
print("What to run next:");
print("  02-lamp     a redstone pulser         " + (HAS_RS ? "ready" : "needs the redstone door"));
print("  03-latch    a redstone toggle         " + (HAS_RS ? "ready" : "needs the redstone door"));
print("  04-devices  browse the network        " + NET_OK);
print("  05-power    energy gauge + alarm      " + NET_OK + (HAS_NET ? ", plus a device with a battery" : ""));
print("  06-mover    move items between two    " + NET_OK + (HAS_NET ? ", plus two inventories" : ""));
print("  07-alarm    watch an Entity Detector  " + NET_OK + (HAS_NET ? ", plus a Detector block" : ""));
print("  08-beacon   two computers talking     " + NET_OK + (HAS_NET ? ", plus a second computer" : ""));
print("");
print("README.md in this folder describes all eight. Open a script to read its header first —");
print("every one of them starts with WHAT / NEEDS / SETUP / TWEAK.");

// The same report as a screen card — decoration, so it is skipped entirely without a GPU.
if (HAS_GFX) {
  const W = gfx.width();
  const H = gfx.height();
  const rows = [["redstone", HAS_RS], ["gfx", HAS_GFX], ["fs", HAS_FS], ["network", HAS_NET]];
  gfx.clear(0x0b1020);
  gfx.rect(0, 0, W, 20, 0x5fd08a);
  gfx.text(8, 6, "SILICA - self test", 0x0b1020);
  for (let i = 0; i < rows.length; i++) {
    const y = 38 + i * 20;
    gfx.rect(10, y, 8, 8, rows[i][1] ? 0x5fd08a : 0xff6b6b);
    gfx.text(28, y, rows[i][0], 0xd7e0ee);
    gfx.text(120, y, rows[i][1] ? "open" : "closed", rows[i][1] ? 0x5fd08a : 0xff6b6b);
  }
  gfx.hLine(10, 126, W - 20, 0x1c2540);
  gfx.text(10, 136, HAS_NET ? DEVS.length + " device(s) on the network" : "no NIC - network unreachable", 0x8a93a6);
  gfx.text(10, 154, "Full report in the terminal above.", 0x8a93a6);
  gfx.text(10, H - 20, "Canvas " + W + "x" + H, 0x4a5570);
}

// Nothing left to do. Park forever instead of exiting so the report stays on the screen; an
// unfiltered pullEvent blocks until something — anything — happens, and costs no CPU meanwhile.
while (true) {
  os.pullEvent();
}
