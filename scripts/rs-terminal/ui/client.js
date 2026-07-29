// rs-terminal/ui/client.js — the page side of the Refined Storage Terminal.
// Talks to the server through the injected window.mc bridge:
//   • mc.onState(state) <- the server pushed a fresh authoritative snapshot (from web.setState)
//   • mc.send(msg)      -> {action:"poll"} heartbeat, or a user-requested action (selectNetwork / search /
//                          craft / cancelTask / cancelAll)
//   • mc.display / mc.player -> which surface this is + who is looking
// The page holds NO authority — it only renders whatever state comes down and asks the server to act.
//
// INPUT REALITY, and it is the reason this file looks the way it does. A wall screen forwards exactly two
// events: a mouse press and a mouse release. No wheel, no drag, no keyboard. A pad or the full-window
// desktop additionally forwards keys and the wheel. So:
//   • the network picker is a row of CHIPS — a native <select> renders no popup at all under offscreen
//     CEF, so the dropdown that used to live in the header never appeared and no wall-screen operator
//     could ever change network;
//   • every scrolling region carries a ▲/▼ PAGER, because otherwise everything past the fold is
//     unreachable on a wall;
//   • the search field is backed by an on-page KEYPAD. The real <input> stays: it is the better control
//     on the surfaces that forward keystrokes, and the two are kept in sync in both directions.
//
// Rendering is INCREMENTAL. The three lists are reused row POOLS — rebuilt only when the row count
// changes, patched in place otherwise. The old blanket innerHTML rebuild threw away up to 300 rows a
// second, which does not merely cost DOM work: it eats a tap that lands mid-rebuild, and with a keypad on
// the page that is a bug you can feel.
//
// Item "icons": CEF can't reach the game's texture atlas, so every row gets an honest generated chip
// instead — a rounded square whose HUE is a deterministic hash of the resource id (same item, same
// colour, every time) with its 1–2 letter initials centred on it (the Collector/Detector precedent).

(function () {
  var mc = window.mc;

  var POLL_MS = 1000;            // a VIEW heartbeat only — the server keeps its own sweep clock and
                                 // answers a bare poll from cache, so this cannot move the device rate
  var SEARCH_DEBOUNCE_MS = 350;  // don't hit listItems on every keystroke or every keypad tap
  var MAX_QUERY = 100;           // the server slices the filter to the same length
  var PEND_MS = 3000;            // how long a local edit outranks the server's echo (see syncQuery)

  var TEAL = "#4fd6c0";
  var CRIT = "#e8604e";

  // ---------- formatting ----------
  function fmtNum(n) {
    if (n == null) { return "—"; }
    var a = Math.abs(n);
    if (a >= 1e9) { return (n / 1e9).toFixed(2) + "G"; }
    if (a >= 1e6) { return (n / 1e6).toFixed(2) + "M"; }
    if (a >= 1e3) { return (n / 1e3).toFixed(1) + "k"; }
    return String(Math.round(n));
  }
  function pct(frac) { return frac == null ? "—" : Math.round(frac * 100) + "%"; }

  function dimLabel(dim) {
    if (!dim) { return null; }
    var s = String(dim);
    var i = s.indexOf(":");
    if (i >= 0) { s = s.substring(i + 1); }
    s = s.replace(/^the_/, "").replace(/_/g, " ");
    return s.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function posLabel(p) { return p ? (p.x + ", " + p.y + ", " + p.z) : null; }

  // ---------- tiny DOM helpers (patch, never rebuild) ----------
  function el(tag, c, t) {
    var x = document.createElement(tag);
    if (c) { x.className = c; }
    if (t != null) { x.textContent = t; }
    return x;
  }
  function txt(n, s) { if (n && n.textContent !== s) { n.textContent = s; } }
  // Patch ONE text node, for the rows that carry a sibling element (the "crafting…" badge lives inside
  // .nm, and setting .textContent on the parent would delete it).
  function tnode(n, s) { if (n && n.nodeValue !== s) { n.nodeValue = s; } }
  function cls(n, s) { if (n && n.className !== s) { n.className = s; } }
  function dis(n, b) { if (n) { n.disabled = !!b; } }
  function on(n, fn) { if (n) { n.addEventListener("click", fn); } }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // Deterministic hash-hue chip (djb2 over the resource id) — see file header. Painted in place so a
  // pooled row keeps its node; a chip whose id has not changed costs nothing.
  function hashHue(id) {
    var h = 5381;
    var s = String(id || "");
    for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
    return Math.abs(h) % 360;
  }
  function initials(name) {
    var words = String(name || "?").trim().split(/\s+/);
    if (words.length >= 2) { return (words[0][0] + words[1][0]).toUpperCase(); }
    return words[0].slice(0, 2).toUpperCase();
  }
  function paintChip(node, id, name) {
    if (!node || node.__id === id) { return; }
    node.__id = id;
    var hue = hashHue(id);
    node.style.background = "hsl(" + hue + ",45%,32%)";
    node.style.borderColor = "hsl(" + hue + ",55%,55%)";
    node.textContent = initials(name);
  }

  // ---------- element refs ----------
  var linkDot = document.getElementById("linkDot");
  var subEl = document.getElementById("sub");
  var netChips = document.getElementById("netChips");
  var emptyEl = document.getElementById("empty");
  var emptyMsgEl = document.getElementById("emptyMsg");
  var contentEl = document.getElementById("content");
  var energyVal = document.getElementById("energyVal");
  var energyFill = document.getElementById("energyFill");
  var statRow = document.getElementById("statRow");
  var tabStorage = document.getElementById("tabStorage");
  var tabCraft = document.getElementById("tabCraft");
  var searchRow = document.getElementById("searchRow");
  var searchInput = document.getElementById("searchInput");
  var searchCount = document.getElementById("searchCount");
  var keysBtn = document.getElementById("keysBtn");
  var storageList = document.getElementById("storageList");
  var storagePager = document.getElementById("storagePager");
  var craftList = document.getElementById("craftList");
  var craftPager = document.getElementById("craftPager");
  var offlineNote = document.getElementById("offlineNote");
  var taskList = document.getElementById("taskList");
  var noTasks = document.getElementById("noTasks");
  var cancelAllBtn = document.getElementById("cancelAllBtn");
  var statusLine = document.getElementById("statusLine");
  var keypad = document.getElementById("keypad");
  var kpGrid = document.getElementById("kpGrid");
  var kpQuery = document.getElementById("kpQuery");

  var currentTab = "storage";   // "storage" | "craft"
  var qty = {};                 // pattern id -> chosen craft quantity (client-side only, default 1)
  var lastState = null;

  // ---------- pagers ----------
  /* Lifted verbatim from detector/ui/client.js — same problem, same answer. Entries wrap, so most of a
     busy list sits off-screen, and neither a wall screen (tap-only) nor MCEF (no wheel event forwarded)
     can scroll it. So: two explicit page buttons per list, dimmed at each end, plus a "first visible /
     total" position mark. Returns the sync fn the renderer calls after every update; it never touches
     scrollTop itself. */
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

  var syncStorage = pager(storageList, document.getElementById("stUp"),
                          document.getElementById("stDn"), document.getElementById("stPos"));
  var syncCraft = pager(craftList, document.getElementById("crUp"),
                        document.getElementById("crDn"), document.getElementById("crPos"));
  var syncTasks = pager(taskList, document.getElementById("tkUp"),
                        document.getElementById("tkDn"), document.getElementById("tkPos"));

  // ---------- tabs ----------
  function setTab(tab) {
    currentTab = tab;
    tabStorage.classList.toggle("active", tab === "storage");
    tabCraft.classList.toggle("active", tab === "craft");
    if (lastState) { render(lastState); }
  }
  on(tabStorage, function () { setTab("storage"); });
  on(tabCraft, function () { setTab("craft"); });

  // ---------- the search query: one text, two controls ----------
  // `query` is what this page shows in BOTH the <input> and the keypad readout. The server's `filter` is
  // authoritative and echoes back on the next sweep — but an echo that arrives while a local edit is
  // still in flight would yank the half-typed word back, so a pending edit outranks it until the server
  // agrees or PEND_MS passes (the latter matters because a filter the server rejects would otherwise
  // pin this page to a value it will never confirm).
  var query = "";
  var pendQuery = null;
  var pendAtMs = 0;
  var searchTimer = null;

  function paintQuery() {
    txt(kpQuery, query || "type to filter the network…");
    cls(kpQuery, query ? "kp-q" : "kp-q empty");
  }

  function setQuery(next, fromInput) {
    next = String(next == null ? "" : next).slice(0, MAX_QUERY);
    if (next === query && !fromInput) { return; }
    query = next;
    if (!fromInput) { searchInput.value = query; }
    paintQuery();
    pendQuery = query;
    pendAtMs = Date.now();
    if (searchTimer) { clearTimeout(searchTimer); }
    searchTimer = setTimeout(function () {
      searchTimer = null;
      mc.send({ action: "search", filter: query });      // a control action: the server re-sweeps at once
    }, SEARCH_DEBOUNCE_MS);
    if (currentTab === "craft" && lastState) { render(lastState); }   // client-side filter, no round-trip
  }

  function syncQuery(serverFilter) {
    var srv = serverFilter || "";
    if (pendQuery != null) {
      if (srv === pendQuery.slice(0, MAX_QUERY) || (Date.now() - pendAtMs) > PEND_MS) { pendQuery = null; }
      else { return; }
    }
    if (document.activeElement === searchInput) { return; }   // never fight a real keyboard mid-word
    if (query !== srv) {
      query = srv;
      searchInput.value = srv;
    }
    paintQuery();
  }

  searchInput.addEventListener("input", function () { setQuery(searchInput.value, true); });

  // ---------- the keypad ----------
  // 37 keys: 0-9, A-Z and the underscore (registry ids are full of them, and no wall screen can produce
  // one). Labels are upper case and the character inserted is lower case — the same convention as a
  // physical keyboard, and registry ids are lower case. Matching is case-insensitive at both ends
  // anyway (the adapter lower-cases both sides; the Craftable tab filters lower-cased here).
  var KEYS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_";
  for (var ki = 0; ki < KEYS.length; ki++) {
    var kch = KEYS.charAt(ki);
    var kb = el("button", "kp-key", kch);
    kb.type = "button";
    kb.setAttribute("data-k", kch.toLowerCase());
    kpGrid.appendChild(kb);
  }
  // Delegated: one listener for 37 keys, and the keys are built once and never rebuilt.
  kpGrid.addEventListener("click", function (e) {
    var k = e.target && e.target.getAttribute ? e.target.getAttribute("data-k") : null;
    if (k) { setQuery(query + k, false); }
  });

  var keypadOpen = false;
  function setKeypad(open) {
    keypadOpen = !!open;
    keypad.classList.toggle("hidden", !keypadOpen);
    keysBtn.classList.toggle("on", keypadOpen);
    txt(keysBtn, keypadOpen ? "⌨ Close" : "⌨ Search");
    if (keypadOpen) { paintQuery(); }
    syncAllPagers();   // the overlay does not resize the lists, but a fresh open should re-mark them
  }
  on(keysBtn, function () { setKeypad(!keypadOpen); });
  on(document.getElementById("kpDone"), function () { setKeypad(false); });
  on(document.getElementById("kpBack"), function () { setQuery(query.slice(0, -1), false); });
  on(document.getElementById("kpClear"), function () { setQuery("", false); });

  function syncAllPagers() { syncStorage(); syncCraft(); syncTasks(); }

  // ---------- network chips ----------
  on(netChips, function (e) {
    var t = e.target;
    while (t && t !== netChips && !(t.getAttribute && t.getAttribute("data-id"))) { t = t.parentNode; }
    var id = (t && t.getAttribute) ? t.getAttribute("data-id") : null;
    if (id) { mc.send({ action: "selectNetwork", id: id }); }
  });

  // Signature rebuild: the roster changes when a controller is added, renamed or drops off — which is
  // rare — so the buttons are built once per change and only their state class is painted per frame.
  function renderNetChips(networks, selected) {
    var list = networks || [];
    netChips.classList.toggle("hidden", list.length === 0);
    var sig = list.map(function (n) { return n.id + "~" + (n.label || "") + "~" + (n.online ? "1" : "0"); }).join("|");
    if (netChips.__sig !== sig) {
      netChips.__sig = sig;
      netChips.innerHTML = "";
      netChips.__els = {};
      for (var i = 0; i < list.length; i++) {
        var n = list[i];
        var b = el("button", "netchip");
        b.type = "button";
        b.setAttribute("data-id", n.id);
        b.appendChild(el("span", "nd"));
        // An offline controller keeps its chip and says so, rather than vanishing — and it stays
        // selectable, because "which of my networks went dark?" is a question the terminal should answer.
        b.appendChild(el("span", "nl", (n.label || n.id) + (n.online ? "" : " · offline")));
        netChips.appendChild(b);
        netChips.__els[n.id] = b;
      }
    }
    for (var j = 0; j < list.length; j++) {
      var chipEl = netChips.__els[list[j].id];
      if (!chipEl) { continue; }
      cls(chipEl, "netchip" + (list[j].online ? "" : " dead") + (list[j].id === selected ? " sel" : ""));
    }
  }

  // ---------- craft quantity + actions ----------
  function qtyFor(id) { return qty[id] || 1; }
  function bumpQty(id, delta) {
    if (!id) { return; }
    qty[id] = clamp(qtyFor(id) + delta, 1, 9999);
    if (lastState) { render(lastState); }
  }

  on(cancelAllBtn, function () { mc.send({ action: "cancelAll" }); });

  // ---------- renderers ----------
  function renderEnergy(energy) {
    if (!energy || energy.stored == null || energy.capacity == null || energy.capacity <= 0) {
      txt(energyVal, (energy && energy.stored != null) ? fmtNum(energy.stored) : "—");
      energyFill.style.width = "0%";
      return;
    }
    var frac = Math.max(0, Math.min(1, energy.stored / energy.capacity));
    txt(energyVal, fmtNum(energy.stored) + " / " + fmtNum(energy.capacity) + " (" + pct(frac) + ")");
    energyFill.style.width = (frac * 100) + "%";
    energyFill.style.background = frac < 0.12
      ? "linear-gradient(90deg,#7a2a22," + CRIT + ")"
      : "linear-gradient(90deg,#1e6b5e," + TEAL + ")";
  }

  // Five fixed tiles: built once, patched thereafter (they are the cheapest thing on the page, but a
  // rebuild every second is still a rebuild every second).
  var STAT_LABELS = ["controller", "item types", "fluid types", "active tasks", "patterns"];
  function renderStats(status) {
    if (!statRow.__pool) {
      statRow.__pool = [];
      for (var i = 0; i < STAT_LABELS.length; i++) {
        var t = el("div", "tile");
        var b = el("b", null, "—");
        t.appendChild(b);
        t.appendChild(el("span", null, STAT_LABELS[i]));
        statRow.appendChild(t);
        statRow.__pool.push({ tile: t, val: b });
      }
    }
    var s = status || {};
    var vals = [
      status ? (s.connected ? "Online" : "Unformed") : "—",
      s.itemTypes == null ? "—" : String(s.itemTypes),
      s.fluidTypes == null ? "—" : String(s.fluidTypes),
      s.craftingTasks == null ? "—" : String(s.craftingTasks),
      s.patterns == null ? "—" : String(s.patterns)
    ];
    for (var j = 0; j < vals.length; j++) {
      txt(statRow.__pool[j].val, vals[j]);
    }
    cls(statRow.__pool[0].tile, (status && !s.connected) ? "tile crit" : "tile");
  }

  /* The three lists below are REUSED POOLS, not innerHTML rebuilds. The pool is rebuilt only when the
     row COUNT changes and the cells are patched in place; scrollTop survives a rebuild, and is reset
     only when the list becomes a *different* list (another network, or a new search — keeping the old
     offset there would land you in the middle of nowhere). The per-row buttons are wired once, at
     build time, and read their id off the pooled cell, so a rebuild can never leave a stale closure
     pointing at the item that used to be in that slot. */
  function poolView(box, key) {
    if (box.__view !== key) { box.scrollTop = 0; box.__view = key; }
  }

  function renderStorageList(items, truncated, view) {
    var box = storageList, list = items || [], i;
    poolView(box, view);
    if (box.__n !== list.length) {
      var keep = box.scrollTop;
      box.__n = list.length;
      box.innerHTML = "";
      box.__pool = [];
      for (i = 0; i < list.length; i++) {
        var li = el("li", "row");
        var ch = el("span", "chip"), nm = el("span", "nm"), ct = el("span", "ct");
        li.appendChild(ch); li.appendChild(nm); li.appendChild(ct);
        box.appendChild(li);
        box.__pool.push({ chip: ch, nm: nm, ct: ct });
      }
      if (!list.length) { box.appendChild(el("li", "empty-row", "No matching items in the network.")); }
      box.scrollTop = keep;
    }
    for (i = 0; i < list.length; i++) {
      var it = list[i], cell = box.__pool[i];
      if (!cell) { break; }
      paintChip(cell.chip, it.id, it.name);
      txt(cell.nm, it.name);
      txt(cell.ct, "×" + fmtNum(it.count));
    }
    if (currentTab === "storage") {
      txt(searchCount, list.length + (truncated ? "+" : "") + " shown");
    }
    syncStorage();
  }

  function renderCraftList(patterns, filterText, view) {
    var box = craftList, i;
    var needle = String(filterText || "").toLowerCase();
    var list = [];
    for (i = 0; i < (patterns || []).length; i++) {
      var p = patterns[i];
      if (needle && p.name.toLowerCase().indexOf(needle) < 0 && p.id.toLowerCase().indexOf(needle) < 0) { continue; }
      list.push(p);
    }
    poolView(box, view);
    if (box.__n !== list.length) {
      var keep = box.scrollTop;
      box.__n = list.length;
      box.innerHTML = "";
      box.__pool = [];
      for (i = 0; i < list.length; i++) {
        box.appendChild(craftRow(box.__pool));
      }
      if (!list.length) {
        box.appendChild(el("li", "empty-row",
          (patterns && patterns.length) ? "No matching patterns." : "No craftable patterns known."));
      }
      box.scrollTop = keep;
    }
    for (i = 0; i < list.length; i++) {
      var pat = list[i], cell = box.__pool[i];
      if (!cell) { break; }
      cell.id = pat.id;
      paintChip(cell.chip, pat.id, pat.name);
      tnode(cell.nameNode, pat.name + " ");
      cell.badge.classList.toggle("hidden", !pat.crafting);
      txt(cell.qv, String(qtyFor(pat.id)));
    }
    if (currentTab === "craft") { txt(searchCount, list.length + " shown"); }
    syncCraft();
  }

  function craftRow(pool) {
    var li = el("li", "row craftrow");
    var cell = { id: null };
    cell.chip = el("span", "chip");
    cell.nm = el("span", "nm");
    cell.nameNode = document.createTextNode("");
    cell.badge = el("span", "craftingBadge hidden", "crafting…");
    cell.nm.appendChild(cell.nameNode);
    cell.nm.appendChild(cell.badge);

    var stepper = el("div", "stepper");
    var minus = el("button", "stepbtn", "−"); minus.type = "button";
    cell.qv = el("span", "qtyval", "1");
    var plus = el("button", "stepbtn", "+"); plus.type = "button";
    stepper.appendChild(minus); stepper.appendChild(cell.qv); stepper.appendChild(plus);

    var craftBtn = el("button", "craftbtn", "Craft"); craftBtn.type = "button";

    // Wired once, against the CELL — the pooled row is reused for whatever pattern lands in this slot.
    on(minus, function () { bumpQty(cell.id, -1); });
    on(plus, function () { bumpQty(cell.id, 1); });
    on(craftBtn, function () {
      if (cell.id) { mc.send({ action: "craft", id: cell.id, count: qtyFor(cell.id) }); }
    });

    li.appendChild(cell.chip); li.appendChild(cell.nm); li.appendChild(stepper); li.appendChild(craftBtn);
    pool.push(cell);
    return li;
  }

  function renderTasks(tasks) {
    var box = taskList, list = tasks || [], i;
    noTasks.classList.toggle("hidden", list.length > 0);
    if (box.__n !== list.length) {
      var keep = box.scrollTop;
      box.__n = list.length;
      box.innerHTML = "";
      box.__pool = [];
      for (i = 0; i < list.length; i++) { box.appendChild(taskRow(box.__pool)); }
      box.scrollTop = keep;
    }
    for (i = 0; i < list.length; i++) {
      var t = list[i], cell = box.__pool[i];
      if (!cell) { break; }
      cell.id = t.id;
      paintChip(cell.chip, t.resource, t.name);
      txt(cell.nm, t.name);
      txt(cell.qty, t.quantity == null ? "" : ("×" + fmtNum(t.quantity)));
      cell.fill.style.width = (t.percent == null ? 0 : clamp(t.percent, 0, 100)) + "%";
      txt(cell.state, (t.state || "?") + (t.percent != null ? " · " + Math.round(t.percent) + "%" : ""));
    }
    syncTasks();
  }

  function taskRow(pool) {
    var li = el("li", "task");
    var cell = { id: null };
    cell.chip = el("span", "chip");

    var body = el("div", "task-body");
    var head = el("div", "task-head");
    cell.nm = el("span", "nm");
    cell.qty = el("span", "ct");
    head.appendChild(cell.nm); head.appendChild(cell.qty);
    var bar = el("div", "task-bar");
    cell.fill = el("div", "task-fill");
    bar.appendChild(cell.fill);
    var stateRow = el("div", "task-state");
    cell.state = el("span");
    stateRow.appendChild(cell.state);
    body.appendChild(head); body.appendChild(bar); body.appendChild(stateRow);

    var cancelBtn = el("button", "cancelbtn", "✕"); cancelBtn.type = "button";
    on(cancelBtn, function () {
      if (cell.id) { mc.send({ action: "cancelTask", taskId: cell.id }); }
    });

    li.appendChild(cell.chip); li.appendChild(body); li.appendChild(cancelBtn);
    pool.push(cell);
    return li;
  }

  function renderStatus(last) {
    if (!last || !last.text) {
      statusLine.classList.add("hidden");
      return;
    }
    statusLine.classList.remove("hidden");
    cls(statusLine, "statusLine " + (last.ok === false ? "bad" : "good"));
    txt(statusLine, last.text);
  }

  // ---------- top-level render ----------
  function render(state) {
    if (!state || !state.ok) {
      emptyEl.classList.remove("hidden");
      contentEl.classList.add("hidden");
      netChips.classList.add("hidden");
      if (keypadOpen) { setKeypad(false); }
      txt(emptyMsgEl, (state && state.reason) ? state.reason : "Searching for a Refined Storage network…");
      cls(linkDot, "dot");
      txt(subEl, "No network");
      return;
    }
    emptyEl.classList.add("hidden");
    contentEl.classList.remove("hidden");
    cls(linkDot, "dot on");

    renderNetChips(state.networks, state.selected);

    var sel = null;
    for (var i = 0; i < (state.networks || []).length; i++) {
      if (state.networks[i].id === state.selected) { sel = state.networks[i]; }
    }
    var subParts = [];
    if (sel) { subParts.push(sel.label); }
    if (state.status && state.status.dimension) { subParts.push(dimLabel(state.status.dimension)); }
    if (state.status && state.status.pos) { subParts.push(posLabel(state.status.pos)); }
    if (mc.display) { subParts.push(mc.display); }
    txt(subEl, subParts.length ? subParts.join(" · ") : "Storage network");

    var offline = !state.status;
    offlineNote.classList.toggle("hidden", !offline);
    storageList.classList.toggle("hidden", offline || currentTab !== "storage");
    storagePager.classList.toggle("hidden", offline || currentTab !== "storage");
    craftList.classList.toggle("hidden", offline || currentTab !== "craft");
    craftPager.classList.toggle("hidden", offline || currentTab !== "craft");
    searchRow.classList.toggle("hidden", offline);
    if (offline && keypadOpen) { setKeypad(false); }   // nothing to search: don't leave the pad floating

    syncQuery(state.filter);

    renderEnergy(state.energy);
    renderStats(state.status);
    if (!offline) {
      // The view key: a different network or a different query is a different list, so the pool resets
      // its scroll rather than stranding the operator at an offset that no longer means anything.
      var view = String(state.selected) + "|" + query;
      renderStorageList(state.items, state.itemsTruncated, view);
      renderCraftList(state.patterns, query, view);
    }
    renderTasks(state.tasks);
    renderStatus(state.last);
  }

  mc.onState = function (state) {
    lastState = state;
    try { render(state); }
    catch (err) {                                  // one bad field must never kill the render loop
      statusLine.classList.remove("hidden");
      cls(statusLine, "statusLine bad");
      txt(statusLine, "render error: " + err);
    }
  };

  // A resize changes what fits without changing content, so the position marks have to be re-measured.
  var resizeTimer = null;
  window.addEventListener("resize", function () {
    if (resizeTimer) { clearTimeout(resizeTimer); }
    resizeTimer = setTimeout(function () { resizeTimer = null; syncAllPagers(); }, 150);
  });

  // ---------- live refresh ----------
  // A VIEW heartbeat, nothing more: the server sweeps the network on its own clock and answers a bare
  // poll from its cached snapshot with zero device calls, so viewers are free.
  paintQuery();
  mc.send({ action: "poll" });
  setInterval(function () { mc.send({ action: "poll" }); }, POLL_MS);
})();
