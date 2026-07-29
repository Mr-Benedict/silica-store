// 08-beacon.js — two computers talking to each other.
//
// WHAT   Broadcasts a numbered heartbeat every PERIOD_SEC, listens for everyone else's, and
//        powers a redstone face while at least one partner is alive — a link light for a
//        remote base, or a dead-man's switch for a machine that must not run alone. The beat
//        counter is written to disk, so a restart carries on instead of starting over.
// NEEDS  A NIC, and a SECOND computer running this same script on the same network: a
//        broadcast never comes back to its sender, so one beacon alone sees no peers. A hard
//        drive is optional — without one the counter simply restarts at zero.
// SETUP  Wire two computers together (adjacent, through a Switch, or Router -> Receiver),
//        run this on both, give each a different NAME, and wire a lamp to LINK_SIDE.
// TWEAK  NAME, PERIOD_SEC, TIMEOUT_SEC, LINK_SIDE, SEND_TO, LOG_BEATS.

const NAME = "beacon-a";     // what this computer calls itself; make it different on each one
const PERIOD_SEC = 5;        // seconds between heartbeats
const TIMEOUT_SEC = 15;      // a partner unheard for this long counts as lost
const LINK_SIDE = "down";    // face of THIS computer that is live while a partner is alive
const SEND_TO = "";          // "" = broadcast to every computer; else one computer's label/id
const LOG_BEATS = true;      // print every heartbeat received, not just arrivals and losses

function probe(fn) { try { fn(); return true; } catch (e) { return false; } }
const HAS_GFX = probe(function () { gfx.width(); });
const HAS_NET = probe(function () { network.devices(); });
const HAS_FS = probe(function () { fs.has("silica-beacon"); });

if (!HAS_NET) {
  print("08-beacon: this computer has no network card. Install a NIC to talk to anything.");
  while (true) { os.pullEvent(); }   // park rather than crash: the message stays readable
}

const SAVE_KEY = "08-beacon.beats";
const saved = HAS_FS ? parseInt(fs.read(SAVE_KEY), 10) : NaN;   // read() is null when unset
const peers = {};            // sender device id -> { name, beat, last }
let beats = isNaN(saved) ? 0 : saved;
let linked = false;

function send() {
  beats++;
  const payload = { kind: "heartbeat", name: NAME, beat: beats };
  try {
    if (SEND_TO) { network.send(SEND_TO, payload); } else { network.broadcast(payload); }
  } catch (err) {
    print("08-beacon: send failed — " + err);
    return;
  }
  if (HAS_FS) { fs.write(SAVE_KEY, String(beats)); }   // survives a restart or a server stop
}

// A message can come from any script on any computer, so check the shape before trusting it.
function receive(data, now) {
  const p = data.payload;
  if (!p || p.kind !== "heartbeat") { return; }
  const known = peers[data.from];
  peers[data.from] = { name: p.name || data.from, beat: p.beat, last: now };
  if (!known) {
    print("08-beacon: '" + (p.name || data.from) + "' is up (" + data.from + ").");
  } else if (LOG_BEATS) {
    print("08-beacon: heartbeat " + p.beat + " from '" + (p.name || data.from) + "'.");
  }
}

function expire(now) {
  const ids = Object.keys(peers);
  for (let i = 0; i < ids.length; i++) {
    if (now - peers[ids[i]].last > TIMEOUT_SEC * 1000) {
      print("08-beacon: lost '" + peers[ids[i]].name + "' — nothing heard for " + TIMEOUT_SEC + "s.");
      delete peers[ids[i]];
    }
  }
}

function draw(now) {
  if (!HAS_GFX) { return; }
  const ids = Object.keys(peers);
  gfx.clear(0x0b1020);
  gfx.rect(0, 0, gfx.width(), 20, linked ? 0x5fd08a : 0x1c2540);
  gfx.text(8, 6, linked ? "LINK UP - " + ids.length + " peer(s)" : "NO PEERS", linked ? 0x0b1020 : 0x8a93a6);
  gfx.text(10, 34, "this is '" + NAME + "'", 0xd7e0ee);
  gfx.text(10, 52, "sent " + beats + " beat(s), one every " + PERIOD_SEC + "s", 0x8a93a6);
  for (let i = 0; i < ids.length && i < 6; i++) {
    const p = peers[ids[i]];
    gfx.text(10, 82 + i * 18, p.name.substring(0, 14) + "  beat " + p.beat + "  "
        + Math.round((now - p.last) / 1000) + "s ago", 0x5fd08a);
  }
  if (ids.length === 0) { gfx.text(10, 82, "run 08-beacon on a second computer", 0x8a93a6); }
  gfx.text(10, 172, HAS_FS ? "counter saved to disk" : "no drive: counter resets", 0x4a5570);
}

print("08-beacon: '" + NAME + "' beating every " + PERIOD_SEC + "s "
    + (SEND_TO ? "to '" + SEND_TO + "'" : "to everyone") + ", resuming at beat " + beats
    + ". A partner unheard for " + TIMEOUT_SEC + "s is dropped.");

let nextBeat = Date.now();

while (true) {
  // Wait for a heartbeat, but never past our own next send. The TIMED form of pullEvent is what
  // lets one loop both listen and keep a clock: it returns the event, or null when the time is up.
  const wait = Math.max(0, (nextBeat - Date.now()) / 1000);
  const ev = os.pullEvent("net_message", wait);

  const now = Date.now();
  if (ev) { receive(ev.data, now); }
  if (now >= nextBeat) {
    send();
    nextBeat = now + PERIOD_SEC * 1000;
  }
  expire(now);

  const up = Object.keys(peers).length > 0;
  if (up !== linked) {
    linked = up;
    try { redstone.setOutput(LINK_SIDE, linked ? 15 : 0); }
    catch (err) { print("08-beacon: cannot drive " + LINK_SIDE + " — " + err + ". Display only."); }
  }
  draw(now);
}
