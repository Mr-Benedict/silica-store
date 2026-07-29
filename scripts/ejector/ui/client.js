// ejector/ui/client.js — the page side of the Ejector monitor.
// Talks to the server through the injected window.mc bridge:
//   • mc.onState(state)  <- the server pushed a fresh snapshot (from web.setState)
//   • mc.send(msg)       -> request "force eject" / a filter-mode flip, or send a poll heartbeat
//   • mc.display / mc.player -> which surface this is + who is looking
// The page holds NO authority: the buffer/filter/tank readouts only ever reflect authoritative state
// coming down, and the two buttons just *request* an action — entrypoint.js re-resolves the device,
// validates the message and calls the real verbs. The poll is a VIEW heartbeat only; the server runs its
// own clock (SWEEP_MS) and answers a bare poll from cache with zero device calls.
//
// The status card at the foot of the sheet closes the loop on those two buttons: whatever the server made
// of a request — the item that left, the reason nothing did, an offline block, a thrown verb — comes back
// down as `state.last` and is rendered here, on the surface the player pressed.
//
// MCEF input: plain clicks only. A wall screen forwards mouse press and release and nothing else — no
// wheel, no drag, no keys — so both lists are paged with ▲/▼ buttons rather than left to overflow
// scrolling, and neither is rebuilt wholesale on a push.

(function () {
  "use strict";
  const mc = window.mc || { send: function () {}, onState: null, player: "", display: "" };
  const POLL_MS = 1000;   // view heartbeat only — the server's own clock drives the device reads
  let currentMode = "blacklist";

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
    list: $("list"), lUp: $("lUp"), lDn: $("lDn"), lPos: $("lPos"),
    filterList: $("filterList"), fUp: $("fUp"), fDn: $("fDn"), fPos: $("fPos"),
    modeBtn: $("modeBtn"), ejectBtn: $("ejectBtn"),
    tankFluid: $("tankFluid"), tankFill: $("tankFill"), tankAmt: $("tankAmt"),
    stLamp: $("stLamp"), stTxt: $("stTxt")
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

  /* Paging for the two scrolling lists. The buffer holds 27 slots and the filter box is capped at
     160 px, so most of either can sit off-screen — and neither a wall screen (tap-only) nor MCEF (no
     wheel event forwarded) can scroll it. So: two explicit page buttons per list, dimmed at each end,
     plus a "first visible / total" position mark. Returns the sync fn the renderer calls after every
     update; it never touches scrollTop itself. */
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
  const syncList = pager(R.list, R.lUp, R.lDn, R.lPos);
  const syncFilter = pager(R.filterList, R.fUp, R.fDn, R.fPos);

  /* The filter chips are a SIGNATURE rebuild: the list only changes when somebody edits the block's own
     config, so a content signature almost always matches and the box is left alone — which is what keeps
     the pager's scroll position alive between pushes. The empty note depends on the mode, so the mode is
     part of the signature. */
  function renderFilter(filter) {
    const box = R.filterList; if (!box) return;
    const sig = currentMode + "|" + filter.join("|");
    if (box.__sig !== sig) {
      const keep = box.scrollTop;
      box.__sig = sig; box.__n = filter.length; box.innerHTML = "";
      if (!filter.length) {
        box.appendChild(el("span", "fnote", currentMode === "whitelist"
          ? "empty whitelist — nothing passes"
          : "empty blacklist — everything passes"));
      } else {
        filter.forEach(function (id) {
          box.appendChild(el("span", "fchip", String(id).replace(/^[^:]*:/, "").replace(/_/g, " ")));
        });
      }
      box.scrollTop = keep;
    }
    syncFilter();
  }

  /* The buffer rows are a REUSED POOL. A blanket `innerHTML = ""` on every push destroys the reader's
     scroll position once a second, which on a paged list means the ▲/▼ buttons can never get you
     anywhere. So the pool is rebuilt only when the row COUNT changes, and the cells are patched in place.
     Both pagers are re-synced on EVERY frame, not just a rebuild — a resize changes what fits without
     changing content. */
  function renderList(items) {
    const box = R.list; if (!box) return;
    let i;
    if (box.__n !== items.length) {
      const keep = box.scrollTop;
      box.__n = items.length; box.innerHTML = ""; box.__pool = [];
      if (!items.length) {
        box.appendChild(el("li", "empty", "Buffer empty — nothing queued to eject."));
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

  // The tank tile always shows (see entrypoint.js's comment — a Liquid Chip's *install* status isn't
  // exposed over the network verbs, only its effect on placement is), so an empty tank just reads 0/cap.
  function renderTank(tank) {
    if (!tank) { txt(R.tankFluid, "Empty"); if (R.tankFill) R.tankFill.style.width = "0%"; txt(R.tankAmt, "0 / 0 mB"); return; }
    txt(R.tankFluid, tank.fluid || "Empty");
    const cap = tank.capacity || 0;
    const frac = cap > 0 ? tank.amount / cap : 0;
    if (R.tankFill) R.tankFill.style.width = (frac * 100) + "%";
    txt(R.tankAmt, tank.amount + " / " + cap + " mB");
  }

  /* The status card: the last control action and how it went — `{action, target, ok, text}` built by
     entrypoint.js, the same shape and the same st-lamp/st-txt classes the `detector` app uses. This is the
     whole point of the card: a refused eject ("the container on the output face is full") is reported on
     the sheet the player just tapped, not only in the computer's terminal, which is a different screen. */
  function renderStatus(last) {
    if (!last || !last.text) {
      cls(R.stLamp, "st-lamp"); cls(R.stTxt, "st-txt");
      txt(R.stTxt, "Standing by — no operator action yet.");
      return;
    }
    cls(R.stLamp, "st-lamp " + (last.ok ? "ok" : "err"));
    cls(R.stTxt, "st-txt" + (last.ok ? "" : " err"));
    let head = last.action ? String(last.action).toUpperCase() : "";
    if (last.target) head += " · " + last.target;
    txt(R.stTxt, head ? (head + " — " + last.text) : last.text);
  }

  // --- authoritative state in ---
  mc.onState = function (state) {
    // Before the offline early-return: the card is the one thing that must survive an offline sheet, since
    // "it went offline mid-action" is exactly one of the outcomes it exists to report.
    renderStatus(state && state.last);
    if (!state || !state.ok) {
      cls(R.offline, "offline");
      cls(R.live, "live hidden");
      cls(R.dot, "dot off");
      txt(R.offlineMsg, (state && state.reason) ? state.reason : "Searching for an ejector…");
      return;
    }
    cls(R.offline, "offline hidden");
    cls(R.live, "live");
    cls(R.dot, "dot on");
    txt(R.title, state.name || "Ejector");

    // header: used/27 + the output facing
    txt(R.sub, state.usedSlots + " / " + (state.capacity || 27) + " slots · facing " + (state.facing || "?"));

    currentMode = state.mode || "blacklist";
    txt(R.modeBtn, "Mode: " + currentMode);
    if (R.modeBtn) R.modeBtn.classList.toggle("whitelist", currentMode === "whitelist");

    renderFilter(state.filter || []);
    renderList(state.items || []);
    renderTank(state.tank);
  };

  // --- showcase controls: request an action; the server validates + calls the real verb ---
  on(R.ejectBtn, function () { mc.send({ action: "eject" }); });
  on(R.modeBtn, function () {
    mc.send({ action: "config", mode: currentMode === "whitelist" ? "blacklist" : "whitelist" });
  });

  // --- view heartbeat: tell the server somebody is looking. It answers from cache, so this cannot
  //     move the device-call rate; the device sweep happens on the server's clock either way. ---
  mc.send({ action: "poll" });
  setInterval(function () { mc.send({ action: "poll" }); }, POLL_MS);
})();
