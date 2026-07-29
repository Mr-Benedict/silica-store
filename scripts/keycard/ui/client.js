/* ACCESS CONTROL — the page side. Talks to the server script through the injected window.mc bridge:
     mc.onState(state)  <- authoritative snapshot pushed by web.setState
     mc.send(msg)       -> request an action (the server re-validates EVERYTHING and may refuse)
   The page holds no authority: it renders what comes down and asks for changes. Rules that cost this
   project playtest cycles and are honoured here:
     * MCEF forwards no mouse wheel -> every overflowing list gets explicit page buttons.
     * native drag does not survive MC->CEF -> the auto-lock is steppers + tappable presets, no slider.
     * native dblclick never fires      -> every control is a single click.
     * innerHTML on every poll drops clicks + resets scroll -> signature rebuild + scroll preserve. */
(function () {
"use strict";
var mc = window.mc || { send: function () {} };
var D = "—";
var STEPS = [0, 5, 10, 30, 60, 300];          // KeycardLogic.AUTO_LOCK_STEPS

// ---------------------------------------------------------------- tiny helpers
function id(k) { return document.getElementById(k); }
function txt(n, v) { if (n && n.textContent !== v) { n.textContent = v; } }
function cls(n, v) { if (n && n.className !== v) { n.className = v; } }
function dis(n, v) { if (n) { n.disabled = !!v; } }
function el(tag, c, t) { var n = document.createElement(tag); if (c) { n.className = c; }
  if (t != null) { n.textContent = t; } return n; }
function on(n, fn) { if (n) { n.addEventListener("click", fn); } }
function send(m) { try { mc.send(JSON.stringify(m)); } catch (e) {} }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function secs(v) { return !v ? "NEVER" : (v >= 60 ? (v / 60) + " min" : v + " s"); }

var R = {};
("offsheet offTag offReason mDoors mReaders link linkTxt "
 + "nDoor dName dState dStateTxt dChips dPh bolt shackle dBig pipOpen pipArmed dNote "
 + "btnUnlock btnLock alVal alMinus alPlus ladder autoOpen autoOpenTxt "
 + "tReaders tCards grpNote rdlist "
 + "nRoster rState rStateTxt rPh cOwner cNormal cTotal cardbox cardPos cardUp cardDn "
 + "nLog lState lStateTxt nOk nBad nAll logbox logPos logUp logDn logClear "
 + "stLamp stTxt clock banner btnLockAll mSub").split(" ").forEach(function (k) { R[k] = id(k); });

// ---------------------------------------------------------------- state held on the page
var cur = { key: null, target: null, door: null, live: false, doors: [] };

function selected() {
  var i;
  for (i = 0; i < cur.doors.length; i++) { if (cur.doors[i].key === cur.key) { return cur.doors[i]; } }
  // The group key is the door's own position, so it is stable across a revoke — but a door whose chunk
  // unloads drops to a per-reader key. Fall back to the reader we were addressing before giving up and
  // jumping to the first door, so the selection survives that.
  for (i = 0; i < cur.doors.length; i++) {
    var rs = cur.doors[i].readers || [];
    for (var j = 0; j < rs.length; j++) { if (rs[j].id === cur.target) { return cur.doors[i]; } }
  }
  return cur.doors.length ? cur.doors[0] : null;
}

// ---------------------------------------------------------------- one-time wiring
function attr(ev, name) {
  var n = ev.target;
  while (n && n !== ev.currentTarget) {
    if (n.getAttribute && n.getAttribute(name) != null) { return n.getAttribute(name); }
    n = n.parentNode;
  }
  return null;
}
on(R.dChips, function (ev) {
  var k = attr(ev, "data-k");
  if (k) { cur.key = k; var d = selected(); cur.target = d ? d.target : null; if (cur.last) { render(cur.last); } }
});
on(R.btnLock, function () { if (cur.live) { send({ action: "lock", target: cur.target }); } });
on(R.btnUnlock, function () { if (cur.live) { send({ action: "unlock", target: cur.target }); } });
on(R.alMinus, function () { stepAuto(-1); });
on(R.alPlus, function () { stepAuto(1); });
on(R.ladder, function (ev) {
  var v = attr(ev, "data-s");
  if (v != null && cur.live) { send({ action: "config", target: cur.target, autoLockSeconds: +v }); }
});
on(R.autoOpen, function () {
  var d = cur.door;
  if (cur.live && d) { send({ action: "config", target: cur.target, autoOpenOnUnlock: !d.autoOpenOnUnlock }); }
});
on(R.cardbox, function (ev) {
  var c = attr(ev, "data-c");
  if (c && cur.live) { send({ action: "revoke", target: cur.target, card: c }); }
});
on(R.logClear, function () { send({ action: "clearLog" }); });
// One click, no confirm: a lockdown that needs two clicks is not a lockdown.
on(R.btnLockAll, function () { send({ action: "lockAll" }); });

function stepAuto(dir) {
  var d = cur.door;
  if (!cur.live || !d) { return; }
  var i = STEPS.indexOf(d.autoLockSeconds);
  if (i < 0) {                                  // an off-ladder value (the verb accepts any 0..3600)
    i = 0;
    while (i < STEPS.length && STEPS[i] < d.autoLockSeconds) { i++; }
    if (dir < 0) { i--; }
  } else { i += dir; }
  send({ action: "config", target: cur.target, autoLockSeconds: STEPS[clamp(i, 0, STEPS.length - 1)] });
}

// the auto-lock preset ladder (built once)
STEPS.forEach(function (s) {
  var b = el("button", "rung", s ? (s >= 60 ? (s / 60) + "m" : s + "s") : "never");
  b.type = "button";
  b.setAttribute("data-s", String(s));
  R.ladder.appendChild(b);
});

/* Paging for the roster + the access log. Both can overflow, and neither a wall screen (tap-only) nor
   MCEF (no wheel forwarded) can scroll them — so: two explicit page buttons per list, dimmed at each
   end, plus a "first visible / total" mark. Returns the sync fn the renderer calls every frame. */
function pager(box, up, dn, pos) {
  function sync() {
    if (!box) { return; }
    var h = box.clientHeight, max = Math.max(0, box.scrollHeight - h), t = box.scrollTop;
    dis(up, t <= 1); dis(dn, t >= max - 1);
    var n = box.__n || 0, kids = box.children, first = 1, i;
    for (i = 0; i < kids.length; i++) {
      if (kids[i].offsetTop + kids[i].offsetHeight > t + 1) { first = i + 1; break; }
    }
    txt(pos, n ? (first + " / " + n) : "0 / 0");
  }
  function page(dir) {
    if (!box) { return; }
    var h = box.clientHeight;
    box.scrollTop = clamp(box.scrollTop + dir * Math.max(24, h * 0.85), 0,
                          Math.max(0, box.scrollHeight - h));
    sync();
  }
  on(up, function () { page(-1); });
  on(dn, function () { page(1); });
  return sync;
}
var syncCards = pager(R.cardbox, R.cardUp, R.cardDn, R.cardPos);
var syncLog = pager(R.logbox, R.logUp, R.logDn, R.logPos);

// A card id is a UUID and CEF cannot render item sprites, so each card gets an honest generated chip:
// a hue hashed from the id, initials on top (the Collector / rs-terminal convention).
function hue(s) {
  var h = 0;
  for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) % 360; }
  return h;
}

// ---------------------------------------------------------------- renderers
function stateClass(d) {
  if (!d) { return "none"; }
  // unpaired = amber (nothing wired up yet); refused/offline/error = red (something is wrong).
  if (!d.bound) { return (!d.issue || d.issue === "unpaired") ? "none" : "lock"; }
  if (d.armed) { return "armed"; }
  return d.locked ? "lock" : "open";
}
function stateWord(d) {
  if (!d) { return "NO DOOR"; }
  if (!d.bound) { return (d.issue || "unpaired").toUpperCase(); }   // refused | unpaired | offline | error
  if (d.armed) { return "PAIRING"; }
  return d.locked ? "LOCKED" : "UNLOCKED";
}

function renderChips(doors) {
  var box = R.dChips;
  var sig = doors.map(function (d) {
    return d.key + "~" + d.name + "~" + stateClass(d) + "~" + (d.key === cur.key ? 1 : 0);
  }).join("|");
  if (box.__sig === sig) { return; }
  box.__sig = sig;
  box.innerHTML = "";
  cls(box, doors.length > 1 ? "chips" : "chips hide");
  if (doors.length < 2) { return; }
  doors.forEach(function (d) {
    var b = el("button", "chip-b st-" + stateClass(d) + (d.key === cur.key ? " sel" : ""));
    b.type = "button";
    b.setAttribute("data-k", d.key);
    b.appendChild(el("span", "cl"));
    b.appendChild(el("span", null, d.name));
    box.appendChild(b);
  });
}

function renderDoor(d) {
  var st = stateClass(d), live = !!(d && d.live);
  cur.door = d; cur.live = live; cur.target = d ? d.target : null;

  cls(R.nDoor, "node door" + (st === "open" ? " open" : (st === "none" ? " none" : "")));
  cls(R.dPh, "ph" + (d ? "" : " on"));
  txt(R.dName, d ? d.name : D);
  cls(R.dState, "n-state " + st);
  txt(R.dStateTxt, stateWord(d));
  txt(R.dBig, stateWord(d));
  cls(R.bolt, "bolt" + (d && d.bound && !d.locked ? " unlocked" : "") + (d && d.bound ? " live" : ""));
  cls(R.pipOpen, "pip" + (d && d.open ? " on" : ""));
  cls(R.pipArmed, "pip arm" + (d && d.armed ? " on" : ""));
  txt(R.dNote, !d ? D
      : (!d.bound ? ((d.readers[0] && d.readers[0].error)
                     || "this reader drives no Secure Door — bind it by right-clicking a door with the reader item")
      : (d.armed ? "a reader is armed — the next card swiped there is enrolled"
      : (d.autoLockSeconds ? "re-locks " + secs(d.autoLockSeconds) + " after a valid swipe"
                           : "stays unlocked until locked"))));

  dis(R.btnLock, !live); dis(R.btnUnlock, !live);
  txt(R.alVal, d && d.bound ? secs(d.autoLockSeconds) : D);
  dis(R.alMinus, !live || (d && d.autoLockSeconds <= STEPS[0]));
  dis(R.alPlus, !live || (d && d.autoLockSeconds >= STEPS[STEPS.length - 1]));
  var rungs = R.ladder.children;
  for (var i = 0; i < rungs.length; i++) {
    cls(rungs[i], "rung" + (d && d.bound && d.autoLockSeconds === STEPS[i] ? " on" : ""));
    dis(rungs[i], !live);
  }
  cls(R.autoOpen, "toggle" + (d && d.autoOpenOnUnlock ? " on" : "") + (live ? "" : " dis"));
  txt(R.autoOpenTxt, d && d.autoOpenOnUnlock ? "ON — a valid card swings it open" : "OFF — card unlocks, you open it");

  txt(R.tReaders, d ? String(d.readers.length) : D);
  txt(R.tCards, d ? String(d.cards.length) : D);
  txt(R.grpNote, d && d.bound && d.readers.length > 1 ? "several readers, one door" : "");
  renderReaders(d ? d.readers : []);
}

function renderReaders(list) {
  var box = R.rdlist;
  var sig = list.map(function (r) { return r.id + "~" + r.state + "~" + (r.error || ""); }).join("|");
  if (box.__sig === sig) { return; }
  box.__sig = sig;
  box.innerHTML = "";
  list.forEach(function (r) {
    var k = r.ok ? (r.armed ? "armed" : (r.state === "unpaired" ? "none" : r.state))
                 : (r.state === "offline" ? "bad" : "bad");
    var row = el("div", "rd " + k);
    row.appendChild(el("span", "lamp"));
    row.appendChild(el("span", "rd-name", r.name));
    row.appendChild(el("span", "rd-st", r.ok ? (r.armed ? "ARMED" : r.state.toUpperCase())
                                             : r.state.toUpperCase()));
    if (!r.ok && r.error) { row.appendChild(el("span", "rd-why", r.error)); }
    box.appendChild(row);
  });
}

function renderRoster(d) {
  var cards = d ? d.cards : [];
  var owner = 0;
  cards.forEach(function (c) { if (c.tier === "owner") { owner++; } });
  txt(R.cOwner, String(owner));
  txt(R.cNormal, String(cards.length - owner));
  txt(R.cTotal, String(cards.length));
  cls(R.rState, "n-state " + (cards.length ? "none" : "idle"));
  txt(R.rStateTxt, cards.length ? cards.length + " ENROLLED" : "EMPTY");
  cls(R.rPh, "ph" + (d && d.bound ? "" : " on"));

  var box = R.cardbox;
  var sig = cards.map(function (c) { return c.id + "~" + c.tier + "~" + (c.by || ""); }).join("|")
    + "~" + (cur.live ? 1 : 0);
  if (box.__sig !== sig) {
    var keep = box.scrollTop;
    box.__sig = sig; box.__n = cards.length; box.innerHTML = "";
    if (!cards.length) {
      box.appendChild(el("div", "none-row", d && d.bound ? "no cards enrolled" : "no door"));
    } else {
      cards.forEach(function (c) {
        var row = el("div", "card " + (c.tier === "owner" ? "owner" : "normal"));
        // A card id is a random UUID, so the only human label is who enrolled it. Cards enrolled before the
        // server recorded that have none — fall back to a short code rather than showing a raw UUID.
        var name = c.by || "";
        var label = name || ("CARD-" + c.short.substring(0, 4).toUpperCase());
        var seed = (name ? name.replace(/[^A-Za-z0-9]/g, "") : c.short).substring(0, 2).toUpperCase();
        var chip = el("span", "hue", seed);
        chip.style.background = "hsl(" + hue(c.id) + ",62%,58%)";   // hue stays keyed on the id, so it is
        row.appendChild(chip);                                      // stable even if a name is absent
        var idEl = el("span", "card-id" + (name ? "" : " anon"), label);
        idEl.title = c.short + "…";        // the id is still reachable, just not the headline
        row.appendChild(idEl);
        row.appendChild(el("span", "tier " + (c.tier === "owner" ? "owner" : ""), c.tier));
        var b = el("button", "rv", "REVOKE");
        b.type = "button";
        b.setAttribute("data-c", c.id);
        // The last owner card cannot be revoked (it would orphan the door) — the server refuses it too.
        b.disabled = !cur.live || (c.tier === "owner" && owner <= 1);
        row.appendChild(b);
        box.appendChild(row);
      });
    }
    box.scrollTop = keep;
  }
  syncCards();
}

var lastTop = 0;
function renderLog(state) {
  var list = (state.log || []).slice().reverse();       // newest first
  var c = state.counts || { accepted: 0, denied: 0, total: 0 };
  txt(R.nOk, String(c.accepted || 0));
  txt(R.nBad, String(c.denied || 0));
  txt(R.nAll, String(c.total || 0));
  var newest = list.length ? list[0].n : 0;
  var fresh = newest > lastTop;
  cls(R.lState, "n-state " + (list.length ? (list[0].accepted ? "open" : "lock") : "armed"));
  txt(R.lStateTxt, list.length ? (fresh ? "SWIPE" : "LIVE") : "LIVE");

  var box = R.logbox;
  var sig = newest + "/" + list.length;
  if (box.__sig !== sig) {
    var keep = box.scrollTop;
    box.__sig = sig; box.__n = list.length; box.innerHTML = "";
    if (!list.length) {
      box.appendChild(el("div", "none-row", "no swipes yet"));
    } else {
      list.forEach(function (e, i) {
        var row = el("div", "ev " + (e.accepted ? "ok" : "bad") + (i === 0 && fresh ? " fresh" : ""));
        row.appendChild(el("span", "ts", e.time));
        row.appendChild(el("span", "vd", e.accepted ? "GRANT" : "DENY"));
        var who = el("span", "who");
        who.appendChild(document.createTextNode(
          (e.card ? e.short + "…" : "blank card") + (e.tier ? " (" + e.tier + ")" : "")));
        var at = el("span", "rdr", "  @ " + e.reader);
        who.appendChild(at);
        row.appendChild(who);
        box.appendChild(row);
      });
    }
    // Newest is at the top, so a fresh entry should be visible: only hold position if the operator has
    // paged down to read history.
    box.scrollTop = fresh ? 0 : keep;
    lastTop = newest;
  }
  syncLog();
}

function renderStatus(last) {
  if (!last || !last.text) {
    cls(R.stLamp, "st-lamp"); cls(R.stTxt, "st-txt");
    txt(R.stTxt, "Standing by — no operator action yet.");
    return;
  }
  cls(R.stLamp, "st-lamp " + (last.ok ? "ok" : "err"));
  cls(R.stTxt, "st-txt" + (last.ok ? "" : " err"));
  var head = last.action ? String(last.action).toUpperCase() : "";
  if (last.target) { head += " · " + last.target; }
  txt(R.stTxt, (head ? head + " — " : "") + last.text + (last.at ? "  [" + last.at + "]" : ""));
}

function setBanner(text, crit) {
  cls(R.banner, "banner" + (text ? " on" : "") + (crit ? " crit" : ""));
  txt(R.banner, text || "");
}

// ---------------------------------------------------------------- main render
var lastRecv = 0;
function setLink(live) {
  cls(R.link, "link" + (live ? "" : " down"));
  txt(R.linkTxt, live ? "LINK LIVE" : "NO SIGNAL");
}

function render(state) {
  cur.last = state;
  var ok = !!(state && state.ok);
  cls(R.offsheet, "offsheet" + (ok ? "" : " on"));
  if (!ok) {
    txt(R.offTag, state && state.welded ? "Security door welded shut" : "No reader on the net");
    txt(R.offReason, (state && state.reason) || "Awaiting link...");
    setLink(false);
    return;
  }
  setLink(true);
  cur.doors = state.doors || [];
  var f = state.fleet || {};
  txt(R.mDoors, String(f.doors == null ? cur.doors.length : f.doors));
  txt(R.mReaders, (f.online || 0) + "/" + (f.readers || 0));
  txt(R.clock, state.now || "--:--:--");

  var d = selected();
  cur.key = d ? d.key : null;
  renderChips(cur.doors);
  renderDoor(d);
  renderRoster(d);
  renderLog(state);
  renderStatus(state.last);

  var bad = [];
  if (f.refused) { bad.push(f.refused + " reader(s) refuse this computer — bind them to it (right-click "
      + "the computer holding the reader item) or place them as the same player."); }
  if (f.unpaired) { bad.push(f.unpaired + " reader(s) drive no door — bind one by right-clicking a Secure "
      + "Door with the reader item."); }
  setBanner(bad.join("  "), false);

  var lockable = 0;
  cur.doors.forEach(function (g) { if (g.live && !g.locked) { lockable++; } });
  txt(R.mSub, (f.unlocked || 0) + " unlocked");
  dis(R.btnLockAll, !(f.doors > 0));
}

mc.onState = function (state) { lastRecv = Date.now(); render(state); };

// --- live refresh: the server stays the authority; card_swipe pushes arrive between polls on its own ---
send({ action: "poll" });
setInterval(function () {
  send({ action: "poll" });
  if (lastRecv && Date.now() - lastRecv > 5000) { setLink(false); }
}, 1000);
})();
