// collector/ui/client.js — the page side of the Collector monitor.
// Talks to the server through the injected window.mc bridge:
//   • mc.onState(state)  <- the server pushed a fresh snapshot (from web.setState)
//   • mc.send(msg)       -> a VIEW heartbeat only; the server runs its own clock (SWEEP_MS) and answers
//                           a bare poll from its cached snapshot with zero device calls
//   • mc.display / mc.player -> which surface this is + who is looking
// The page holds NO authority and no controls: it only renders the buffer coming down. Retune the
// collector from the block's own config GUI, not here.
//
// MCEF input: plain clicks only. A wall screen forwards mouse press and release and nothing else — no
// wheel, no drag, no keys — so the list is paged with ▲/▼ buttons rather than left to overflow scrolling,
// and the rows are a reused pool so a push never throws the reader back to the top.

(function () {
  "use strict";
  const mc = window.mc || { send: function () {}, onState: null, player: "", display: "" };
  const POLL_MS = 1000;   // view heartbeat only — the server's own clock drives the device reads

  function $(id) { return document.getElementById(id); }
  function el(tag, c, t) { const x = document.createElement(tag); if (c) x.className = c; if (t != null) x.textContent = t; return x; }
  function txt(n, s) { if (n && n.textContent !== s) n.textContent = s; }
  function cls(n, s) { if (n && n.className !== s) n.className = s; }
  function dis(n, b) { if (n) n.disabled = !!b; }
  function on(n, fn) { if (n) n.addEventListener("click", fn); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  const R = {
    offline: $("offline"), offlineMsg: $("offlineMsg"), live: $("live"), dot: $("statusDot"),
    title: $("title"), sub: $("sub"),
    list: $("list"), up: $("lUp"), dn: $("lDn"), pos: $("lPos")
  };

  // Item "icon": CEF can't reach the game texture atlas (no real item sprites — a documented Path-B limit),
  // so each row gets an honest generated chip instead — a rounded square whose HUE is a deterministic hash
  // of the item id (same item ⇒ same colour every time) with the item's 1–2 letter initials centred on it.
  function hashHue(id) {
    let h = 5381;
    const s = String(id || "");
    for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
    return Math.abs(h) % 360;
  }
  function initials(name) {
    const words = String(name || "?").trim().split(/\s+/);
    if (words.length >= 2) { return (words[0][0] + words[1][0]).toUpperCase(); }
    return words[0].slice(0, 2).toUpperCase();   // "Cobblestone" -> "Co"
  }

  /* Paging for the buffer list. A full 27-slot buffer does not fit the box, and neither a wall screen
     (tap-only) nor MCEF (no wheel event forwarded) can scroll it — so: two explicit page buttons, dimmed
     at each end, plus a "first visible / total" position mark. Returns the sync fn the renderer calls
     after every update; it never touches scrollTop itself. */
  function pager(box, up, dn, pos) {
    function sync() {
      if (!box) return;
      const h = box.clientHeight, max = Math.max(0, box.scrollHeight - h), t = box.scrollTop;
      dis(up, t <= 1); dis(dn, t >= max - 1);
      const n = box.__n || 0, kids = box.children;
      let first = 1, i;
      for (i = 0; i < kids.length; i++) { if (kids[i].offsetTop + kids[i].offsetHeight > t + 1) { first = i + 1; break; } }
      txt(pos, n ? (first + "/" + n) : "0/0");
    }
    function page(dir) {
      if (!box) return;
      const h = box.clientHeight;
      box.scrollTop = clamp(box.scrollTop + dir * Math.max(24, h * 0.85), 0, Math.max(0, box.scrollHeight - h));
      sync();
    }
    on(up, function () { page(-1); }); on(dn, function () { page(1); });
    return sync;
  }
  const syncList = pager(R.list, R.up, R.dn, R.pos);

  /* The rows are a REUSED POOL. A blanket `innerHTML = ""` on every push destroys the reader's scroll
     position once a second, which on a paged list means the ▲/▼ buttons can never get you anywhere. So
     the pool is rebuilt only when the row COUNT changes, and the cells are patched in place. The pager
     is re-synced on EVERY frame, not just a rebuild — a resize changes what fits without changing
     content. */
  function renderList(items) {
    const box = R.list; if (!box) return;
    let i;
    if (box.__n !== items.length) {
      const keep = box.scrollTop;
      box.__n = items.length; box.innerHTML = ""; box.__pool = [];
      if (!items.length) {
        box.appendChild(el("li", "empty", "Buffer empty — nothing collected yet."));
      } else {
        for (i = 0; i < items.length; i++) {
          const li = el("li", "row"), icon = el("span", "icon"), nm = el("span", "nm"), ct = el("span", "ct");
          li.appendChild(icon); li.appendChild(nm); li.appendChild(ct);
          box.appendChild(li);
          box.__pool.push({ icon: icon, nm: nm, ct: ct, hue: null });
        }
      }
      box.scrollTop = keep;
    }
    for (i = 0; i < items.length; i++) {
      const it = items[i], cell = box.__pool[i]; if (!cell) break;
      const hue = hashHue(it.id);
      if (cell.hue !== hue) {                      // the hue only changes when a slot's ITEM changes
        cell.hue = hue;
        cell.icon.style.background = "hsl(" + hue + ",45%,32%)";
        cell.icon.style.borderColor = "hsl(" + hue + ",55%,55%)";
      }
      txt(cell.icon, initials(it.name));
      txt(cell.nm, it.name);
      txt(cell.ct, "×" + it.count);
    }
    syncList();
  }

  // --- authoritative state in ---
  mc.onState = function (state) {
    if (!state || !state.ok) {
      cls(R.offline, "offline");
      cls(R.live, "live hidden");
      cls(R.dot, "dot off");
      txt(R.offlineMsg, (state && state.reason) ? state.reason : "Searching for a collector…");
      return;
    }
    cls(R.offline, "offline hidden");
    cls(R.live, "live");
    cls(R.dot, "dot on");
    txt(R.title, state.name || "Collector");

    // header context: used/27, plus mode + range when the server reports them
    let sub = state.usedSlots + " / " + (state.capacity || 27) + " slots";
    if (state.mode) { sub += " · " + state.mode; }
    if (state.range != null) { sub += " · range " + state.range; }
    txt(R.sub, sub);

    renderList(state.items || []);
  };

  // --- view heartbeat: tell the server somebody is looking. It answers from cache, so this cannot
  //     move the device-call rate; the buffer read happens on the server's clock either way. ---
  mc.send({ action: "poll" });
  setInterval(function () { mc.send({ action: "poll" }); }, POLL_MS);
})();
