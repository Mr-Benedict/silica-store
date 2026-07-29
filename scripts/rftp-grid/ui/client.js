// rftp-grid/ui/client.js — the page side of the RFTools Power Grid Monitor.
// Talks to the server through the injected window.mc bridge:
//   • mc.onState(state) <- the server pushed a fresh authoritative snapshot (from web.setState)
//   • mc.send(msg)      -> a bare {action:"poll"} heartbeat (read-only phase — no controls to request)
//   • mc.display / mc.player -> which surface this is + who is looking
// The page holds NO authority — it only renders whatever state comes down, and it does NOT pace the
// server: the device sweep runs on the server's own clock (SWEEP_MS in entrypoint.js) and a heartbeat is
// answered from the cached snapshot with zero device calls. The heartbeat exists to kick a freshly-opened
// page into showing state at once instead of waiting out the current sweep.

(function () {
  var mc = window.mc;

  var POLL_MS = 1000;   // heartbeat only — the SERVER decides how often the devices are actually read

  var TEAL = "#4fd6c0";
  var AMBER = "#f5b942";
  var CRIT = "#e8604e";
  var VIOLET = "#b28dff";
  var BLUE = "#7fb2ff";

  var networksEl = document.getElementById("networks");
  var generatorsEl = document.getElementById("generators");
  var noNetworksEl = document.getElementById("noNetworks");
  var noGeneratorsEl = document.getElementById("noGenerators");
  var emptyEl = document.getElementById("empty");
  var emptyMsgEl = document.getElementById("emptyMsg");
  var contentEl = document.getElementById("content");

  var netCards = {};   // key -> { card, refs }
  var genCards = {};   // id -> { card, refs }
  var netOrder = [];
  var genOrder = [];

  // ---------- tiny DOM helpers (pager() below is lifted verbatim from detector/ui/client.js) ----------
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function txt(n, s) { if (n && n.textContent !== s) { n.textContent = s; } }
  function dis(n, b) { if (n) { n.disabled = !!b; } }
  function on(node, fn) { if (node) { node.addEventListener("click", fn); } }
  function id$(s) { return document.getElementById(s); }

  // ---------- paging ----------
  /* Paging for the two scrolling card columns. Neither a wall screen (tap-only) nor MCEF (no wheel event
     forwarded) can scroll a column, so everything below the fold would simply be unreachable there. So:
     two explicit page buttons per column, dimmed at each end, plus a "first visible / total" position
     mark. Returns the sync fn the renderer calls after every update; it never touches scrollTop itself. */
  function pager(box,up,dn,pos){
    function sync(){
      if(!box)return;
      var h=box.clientHeight,max=Math.max(0,box.scrollHeight-h),t=box.scrollTop;
      dis(up,t<=1);dis(dn,t>=max-1);
      var n=box.__n||0,kids=box.children,first=1,i;
      for(i=0;i<kids.length;i++)if(kids[i].offsetTop+kids[i].offsetHeight>t+1){first=i+1;break;}
      txt(pos,n?(first+"/"+n):"0/0");}
    function page(dir){
      if(!box)return;
      var h=box.clientHeight;
      box.scrollTop=clamp(box.scrollTop+dir*Math.max(24,h*.85),0,Math.max(0,box.scrollHeight-h));
      sync();}
    on(up,function(){page(-1);});on(dn,function(){page(1);});
    return sync;}
  var syncNet = pager(networksEl, id$("netUp"), id$("netDn"), id$("netPos"));
  var syncGen = pager(generatorsEl, id$("genUp"), id$("genDn"), id$("genPos"));

  // ---------- formatting ----------
  function fmtFe(n) {
    if (n == null) { return "—"; }
    var a = Math.abs(n);
    if (a >= 1e9) { return (n / 1e9).toFixed(2) + "G"; }
    if (a >= 1e6) { return (n / 1e6).toFixed(2) + "M"; }
    if (a >= 1e3) { return (n / 1e3).toFixed(1) + "k"; }
    return String(Math.round(n));
  }
  // A rate readout (FE/tick) — keeps a couple of significant figures for the small values a flow usually
  // is, k/M for big ones. Sign is carried by the caller's label, this always renders the magnitude.
  function fmtRate(n) {
    if (n == null) { return "—"; }
    var a = Math.abs(n);
    if (a >= 1e6) { return (n / 1e6).toFixed(2) + "M"; }
    if (a >= 1e3) { return (n / 1e3).toFixed(1) + "k"; }
    if (a >= 100) { return String(Math.round(n)); }
    if (a >= 10) { return n.toFixed(1); }
    return n.toFixed(2);
  }
  function pct(frac) { return frac == null ? "—" : Math.round(frac * 100) + "%"; }
  function titleCase(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : "?"; }

  // "minecraft:the_nether" -> "Nether"; "minecraft:overworld" -> "Overworld"; anything else -> the last
  // namespace segment, spelled out. Never throws on a missing/odd string.
  function dimLabel(dim) {
    if (!dim) { return "—"; }
    var s = String(dim);
    var i = s.indexOf(":");
    if (i >= 0) { s = s.substring(i + 1); }
    s = s.replace(/^the_/, "").replace(/_/g, " ");
    return s.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function posLabel(p) { return p ? (p.x + ", " + p.y + ", " + p.z) : ""; }

  // Ticks (20/s) -> a short human duration, e.g. "12s" / "1m 04s". Used for a generator's remaining burn.
  function fmtTicks(t) {
    if (t == null) { return "—"; }
    var sec = Math.max(0, Math.round(t / 20));
    var m = Math.floor(sec / 60), s = sec % 60;
    if (m > 0) { return m + "m " + (s < 10 ? "0" : "") + s + "s"; }
    return sec + "s";
  }

  function setBar(fillEl, valEl, stored, capacity) {
    if (stored == null || capacity == null || capacity <= 0) {
      valEl.textContent = stored == null ? "— FE" : fmtFe(stored) + " FE";
      fillEl.style.width = "0%";
      return;
    }
    var frac = Math.max(0, Math.min(1, stored / capacity));
    valEl.textContent = fmtFe(stored) + " / " + fmtFe(capacity) + " FE (" + pct(frac) + ")";
    fillEl.style.width = (frac * 100) + "%";
    fillEl.style.background = frac < 0.12
      ? "linear-gradient(90deg,#7a2a22," + CRIT + ")"
      : "linear-gradient(90deg,#1e6b5e," + TEAL + ")";
  }

  function tile(value, label, cls) {
    var t = document.createElement("div"); t.className = "tile" + (cls ? " " + cls : "");
    var b = document.createElement("b"); b.textContent = value;
    var s = document.createElement("span"); s.textContent = label;
    t.appendChild(b); t.appendChild(s);
    return t;
  }

  // A tile row whose CONTENTS vary (how many tiles, which labels) — rebuilt only when the row it should
  // hold actually changed. `defs` is a list of [value, label, cls?]; the signature is the whole list, so
  // a row that reads the same second after second is left completely alone. Rows whose value changes
  // every sweep (the flow tiles) are not built this way — they are built once and patched in place.
  function renderTiles(row, defs) {
    var sig = JSON.stringify(defs);
    if (row.__sig === sig) { return; }
    row.__sig = sig;
    row.innerHTML = "";
    for (var i = 0; i < defs.length; i++) { row.appendChild(tile(defs[i][0], defs[i][1], defs[i][2] || null)); }
  }

  // ---------- network cards (PowerCell + DimensionalCell, deduped by network id) ----------
  function buildNetCard(n) {
    var card = document.createElement("section");
    card.className = "card net " + n.kind;

    var head = document.createElement("div"); head.className = "card-head";
    var badge = document.createElement("span"); badge.className = "badge " + n.kind;
    var name = document.createElement("span"); name.className = "cname";
    var dim = document.createElement("span"); dim.className = "cdim";
    head.appendChild(badge); head.appendChild(name); head.appendChild(dim);

    var body = document.createElement("div"); body.className = "card-body";
    var buffer = document.createElement("div"); buffer.className = "buffer";
    var bhead = document.createElement("div"); bhead.className = "buf-head";
    var blabel = document.createElement("span"); blabel.textContent = "Network buffer";
    var bval = document.createElement("span"); bval.className = "buf-val";
    bhead.appendChild(blabel); bhead.appendChild(bval);
    var bbar = document.createElement("div"); bbar.className = "bar";
    var bfill = document.createElement("div"); bfill.className = "bar-fill";
    bbar.appendChild(bfill);
    buffer.appendChild(bhead); buffer.appendChild(bbar);

    var stats = document.createElement("div"); stats.className = "stat-row";

    // The two flow tiles carry a MEASURED rate, so their value moves on almost every sweep — built once
    // here and patched by value, never rebuilt.
    var flow = document.createElement("div"); flow.className = "flow-row";
    var flowIn = document.createElement("div"); flowIn.className = "flow in";
    var flowOut = document.createElement("div"); flowOut.className = "flow out";
    var flowInTile = tile("…", "FE/t in", "in");
    var flowOutTile = tile("…", "FE/t out", "out");
    flowIn.appendChild(flowInTile); flowOut.appendChild(flowOutTile);
    flow.appendChild(flowIn); flow.appendChild(flowOut);

    body.appendChild(buffer); body.appendChild(stats); body.appendChild(flow);
    card.appendChild(head); card.appendChild(body);

    return { card: card, refs: { badge: badge, name: name, dim: dim, bval: bval, bfill: bfill, stats: stats,
                                 flowInVal: flowInTile.firstChild, flowOutVal: flowOutTile.firstChild } };
  }

  function applyNetCard(mm, n) {
    var r = mm.refs;
    r.badge.className = "badge " + n.kind;
    r.badge.textContent = n.kind === "powercell" ? "PowerCell" : "Dimensional";
    r.name.textContent = "Network #" + n.networkId;
    r.dim.textContent = dimLabel(n.dimension);

    setBar(r.bfill, r.bval, n.stored, n.capacity);

    renderTiles(r.stats, n.kind === "powercell"
      ? [[n.cells == null ? "—" : String(n.cells), "cells"]]
      : [[n.blocks == null ? "—" : String(n.blocks), "blocks"],
         [n.simpleBlocks == null ? "—" : String(n.simpleBlocks), "simple"],
         [n.advancedBlocks == null ? "—" : String(n.advancedBlocks), "advanced"],
         [n.costFactor == null ? "—" : n.costFactor.toFixed(2) + "x", "cost"]]);

    txt(r.flowInVal, n.flowIn == null ? "…" : "+" + fmtRate(n.flowIn));
    txt(r.flowOutVal, n.flowOut == null ? "…" : "−" + fmtRate(n.flowOut));
  }

  function renderNetworks(networks) {
    var order = [];
    var seen = {};
    for (var i = 0; i < networks.length; i++) {
      var n = networks[i];
      seen[n.key] = true;
      order.push(n.key);
      var mm = netCards[n.key];
      if (!mm) { var built = buildNetCard(n); mm = netCards[n.key] = { card: built.card, refs: built.refs }; }
      applyNetCard(mm, n);
    }
    for (var id in netCards) {
      if (netCards.hasOwnProperty(id) && !seen[id]) {
        var c = netCards[id].card;
        if (c.parentNode) { c.parentNode.removeChild(c); }
        delete netCards[id];
      }
    }
    if (order.join(",") !== netOrder.join(",")) {
      for (var j = 0; j < order.length; j++) { networksEl.appendChild(netCards[order[j]].card); }
      netOrder = order;
    }
    noNetworksEl.classList.toggle("hidden", networks.length > 0);
    // Re-synced on EVERY frame, not just when the roster changes — a resize changes what fits without
    // changing content, and so does a card that grew a tile.
    networksEl.__n = networks.length;
    syncNet();
  }

  // ---------- generator cards (Endergenic / Coal / Blazing — one per device) ----------
  function buildGenCard(g) {
    var card = document.createElement("section");
    card.className = "card gen " + g.kind;

    var head = document.createElement("div"); head.className = "card-head";
    var badge = document.createElement("span"); badge.className = "badge " + g.kind;
    var name = document.createElement("span"); name.className = "cname";
    var dim = document.createElement("span"); dim.className = "cdim";
    head.appendChild(badge); head.appendChild(name); head.appendChild(dim);

    var body = document.createElement("div"); body.className = "card-body";
    var hero = document.createElement("div"); hero.className = "hero";
    var heroLabel = document.createElement("span"); heroLabel.textContent = "Output";
    var heroVal = document.createElement("b");
    var heroUnit = document.createElement("i"); heroUnit.textContent = "FE/t";
    var workDot = document.createElement("span"); workDot.className = "workdot";
    hero.appendChild(heroLabel); hero.appendChild(heroVal); hero.appendChild(heroUnit); hero.appendChild(workDot);

    var buffer = document.createElement("div"); buffer.className = "buffer";
    var bhead = document.createElement("div"); bhead.className = "buf-head";
    var blabel = document.createElement("span"); blabel.textContent = "Buffer";
    var bval = document.createElement("span"); bval.className = "buf-val";
    bhead.appendChild(blabel); bhead.appendChild(bval);
    var bbar = document.createElement("div"); bbar.className = "bar";
    var bfill = document.createElement("div"); bfill.className = "bar-fill";
    bbar.appendChild(bfill);
    buffer.appendChild(bhead); buffer.appendChild(bbar);

    var stats = document.createElement("div"); stats.className = "stat-row";
    var offlineBanner = document.createElement("div"); offlineBanner.className = "offline-banner";
    offlineBanner.textContent = "OFFLINE — chunk unloaded or block removed";

    body.appendChild(offlineBanner); body.appendChild(hero); body.appendChild(buffer); body.appendChild(stats);
    card.appendChild(head); card.appendChild(body);

    return {
      card: card,
      refs: { badge: badge, name: name, dim: dim, heroVal: heroVal, workDot: workDot, bval: bval, bfill: bfill, stats: stats }
    };
  }

  function chargingLabel(g) {
    if (g.chargingMode === "holding") { return g.holding ? "Holding" : "Charging"; }
    return "Idle";
  }

  // The tile row a generator should be showing, as [value, label, cls?] triples — how many tiles there are
  // and what they say depends on the generator kind, so renderTiles() rebuilds the row only when the list
  // itself changes rather than once a second forever.
  function genTiles(g) {
    if (!g.online) { return []; }
    if (g.kind === "endergenic") {
      var out = [
        [chargingLabel(g), "phase", g.chargingMode === "holding" ? "hot" : null],
        [g.charge == null ? "—" : String(g.charge), "charge"],
        [g.distanceTicks == null ? "—" : fmtTicks(g.distanceTicks), "eta"],
        [g.lastGained == null ? "—" : "+" + fmtRate(g.lastGained), "last gained", "hot"],
        [g.lastLost == null ? "—" : "−" + fmtRate(g.lastLost), "last lost", g.lastLost ? "crit" : null],
        [(g.pearlsLaunched == null ? "0" : g.pearlsLaunched) + " / " + (g.pearlsLost == null ? "0" : g.pearlsLost), "launched / lost"]
      ];
      if (g.lostReason) { out.push([g.lostReason, "last loss reason", "crit"]); }
      return out;
    }
    if (g.kind === "coal") {
      return [[fmtTicks(g.burnRemaining), "burn remaining", g.burnRemaining ? "hot" : null]];
    }
    if (g.kind === "blazing") {
      return [[g.slots == null ? "—" : String(g.slots), "lit slots", g.slots ? "hot" : null]];
    }
    return [];
  }

  function renderGenStats(stats, g) { renderTiles(stats, genTiles(g)); }

  function applyGenCard(mm, g) {
    var r = mm.refs;
    r.badge.className = "badge " + g.kind;
    r.badge.textContent = titleCase(g.kind);
    r.name.textContent = g.label;
    r.dim.textContent = g.online ? (dimLabel(g.dimension) + (g.pos ? " @ " + posLabel(g.pos) : "")) : "offline";

    mm.card.classList.toggle("offline", !g.online);
    mm.card.classList.toggle("working", !!g.working);

    if (!g.online) {
      r.heroVal.textContent = "—";
      r.workDot.className = "workdot";
      setBar(r.bfill, r.bval, null, null);
      renderGenStats(r.stats, g);
      return;
    }

    r.heroVal.textContent = g.rfPerTick == null ? "—" : fmtFe(g.rfPerTick);
    r.workDot.className = "workdot" + (g.working ? " on" : "");
    setBar(r.bfill, r.bval, g.stored, g.capacity);
    renderGenStats(r.stats, g);
  }

  function renderGenerators(generators) {
    var order = [];
    var seen = {};
    for (var i = 0; i < generators.length; i++) {
      var g = generators[i];
      seen[g.id] = true;
      order.push(g.id);
      var mm = genCards[g.id];
      if (!mm) { var built = buildGenCard(g); mm = genCards[g.id] = { card: built.card, refs: built.refs }; }
      applyGenCard(mm, g);
    }
    for (var id in genCards) {
      if (genCards.hasOwnProperty(id) && !seen[id]) {
        var c = genCards[id].card;
        if (c.parentNode) { c.parentNode.removeChild(c); }
        delete genCards[id];
      }
    }
    if (order.join(",") !== genOrder.join(",")) {
      for (var j = 0; j < order.length; j++) { generatorsEl.appendChild(genCards[order[j]].card); }
      genOrder = order;
    }
    noGeneratorsEl.classList.toggle("hidden", generators.length > 0);
    generatorsEl.__n = generators.length;
    syncGen();
  }

  // ---------- header totals ----------
  function updateTotals(networks, generators) {
    var sub = document.getElementById("sub");
    var totStored = document.getElementById("totStored");
    var totCap = document.getElementById("totCap");
    var totGen = document.getElementById("totGen");
    var linkDot = document.getElementById("linkDot");

    var stored = 0, capacity = 0, haveCapacity = false;
    for (var i = 0; i < networks.length; i++) {
      var n = networks[i];
      if (n.stored != null) { stored += n.stored; }
      if (n.capacity != null) { capacity += n.capacity; haveCapacity = true; }
    }
    var gen = 0, onlineGen = 0;
    for (var j = 0; j < generators.length; j++) {
      var g = generators[j];
      if (g.online) { onlineGen++; }
      if (g.online && g.working && g.rfPerTick != null) { gen += g.rfPerTick; }
    }

    totStored.textContent = networks.length ? fmtFe(stored) + " FE" : "—";
    totCap.textContent = haveCapacity ? fmtFe(capacity) + " FE" : "—";
    totGen.textContent = generators.length ? fmtFe(gen) + " FE/t" : "—";

    sub.textContent = networks.length + " network" + (networks.length === 1 ? "" : "s") +
      " · " + generators.length + " generator" + (generators.length === 1 ? "" : "s") +
      " (" + onlineGen + " online)" + (mc.display ? " · " + mc.display : "");
    linkDot.className = "dot on";
  }

  // ---------- state in ----------
  mc.onState = function (state) {
    if (!state || !state.ok) {
      emptyEl.classList.remove("hidden");
      contentEl.classList.add("hidden");
      emptyMsgEl.textContent = (state && state.reason) ? state.reason : "Searching for RFTools Power blocks…";
      document.getElementById("linkDot").className = "dot";
      document.getElementById("sub").textContent = "No devices";
      return;
    }
    emptyEl.classList.add("hidden");
    contentEl.classList.remove("hidden");

    var networks = state.networks || [];
    var generators = state.generators || [];
    renderNetworks(networks);
    renderGenerators(generators);
    updateTotals(networks, generators);
  };

  // ---------- heartbeat (the SERVER is paced; this only asks for the cached snapshot) ----------
  // The server sweeps its devices on its own clock and pushes to every viewer. This heartbeat costs zero
  // device calls — it exists so a page that has just opened sees state immediately, and so a viewer that
  // missed a push gets the current snapshot back.
  mc.send({ action: "poll" });
  setInterval(function () { mc.send({ action: "poll" }); }, POLL_MS);
})();
