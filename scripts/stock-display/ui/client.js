/* STOCK ROOM — the page half of the Stock Display, and a sibling of the Perimeter Watch / Prospector's
   Survey boards: the page decides NOTHING. It only *requests* (mc.send) and renders what came back
   (mc.onState); every field may be null, so every read goes through a guard.
     • mc.onState(state)  <- the server pushed a fresh snapshot (from web.setState)
     • mc.send(msg)       -> a VIEW heartbeat, or {action:"filter", tag}. Neither costs a device call:
                             the server runs its own clock and re-derives a filter from its cached read.
                             {action:"inspect"|"reread"|"close"} drive the per-slot inspector, and
                             `inspect`/`reread` are the ONLY messages on this page that can cost the
                             server a faculty call — one each, on a tap, never on the 1 s heartbeat.
   The selected tag AND the open slot card both live on the SERVER, so two people watching one wall screen
   see the same board rather than fighting over it.

   Rendering is INCREMENTAL — the sheet is static HTML and an update only patches text, class and width on
   cached refs. The two dynamic lists rebuild only when their shape changes: the chips when the TAG SET
   changes, the rows when the row COUNT changes. A blanket rebuild on every push would cancel the click a
   viewer is in the middle of making and throw the reader back to the top of a paged list.

   MCEF input: plain clicks only. A wall screen forwards mouse press and release and nothing else — no
   wheel, no drag, no keys — which is why the filter is chips rather than a text box and the list is paged
   with the ▲/▼ buttons. */

(function () {
  "use strict";
  const mc = window.mc || { send: function () {}, onState: null, player: "", display: "" };
  const POLL_MS = 1000;    // view heartbeat only — the server's own clock drives the device reads
  const STALE_MS = 5000;   // no push for this long -> the link lamp goes red
  const D = "—";           // the "no reading" placeholder

  function $(id) { return document.getElementById(id); }
  function el(tag, c, t) { const x = document.createElement(tag); if (c) x.className = c; if (t != null) x.textContent = t; return x; }
  function txt(n, s) { if (n && n.textContent !== s) n.textContent = s; }
  function cls(n, s) { if (n && n.className !== s) n.className = s; }
  function dis(n, b) { if (n) n.disabled = !!b; }
  function on(n, fn) { if (n) n.addEventListener("click", fn); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function num(v) { return (typeof v === "number" && isFinite(v)) ? v : null; }

  // 1204 -> "1,204". Thousands separators are most of what makes a stock board readable at a distance.
  function group(n) { n = num(n); return n == null ? D : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  // "minecraft:logs" -> "logs" — the namespace is noise on a chip that is three characters wide.
  function shortTag(t) { const s = String(t || ""); const i = s.indexOf(":"); return i < 0 ? s : s.slice(i + 1); }

  const R = {};
  ("offsheet offReason op hdrSlots hdrItems link linkTxt " +
   "nStock invName fState fStateTxt pctBig pipFull freeTxt fill gval " +
   "tUsed tFree tKinds tItems tWatch tRead tFilter tTags noteLine " +
   "nContents cName cState cStateTxt cPh chips list lUp lDn lPos " +
   "paneList paneDet dBack dWhere dPrev dPos dNext dAgain " +
   "dState dStateH dStateR dSw dName dId dTrunc dCount dMax dDur dFields " +
   "comps cUp cDn cPos dNote " +
   "stLamp stTxt tbFilter tbRows clock").split(" ").forEach(function (k) { R[k] = $(k); });

  let filter = "";      // mirrors the server's value; the click is optimistic, the push is authoritative
  let wantSlot = null;  // "this viewer asked to look at a slot" — holds the pane open across the one tick
                        // between the tap and the server's answer, and across a sweep push that races it
  let wantAt = 0;       // ...and only for that long: see render(), where it gives up
  let lastDetail = null;

  // The card is not a live reading. Each state says why there is no record, in words rather than a dash.
  const STATE_HEAD = {
    empty: "SLOT EMPTY", refused: "SLOT REFUSED", gone: "NO SIGNAL", noslot: "NO SLOT TO READ"
  };

  // Item "icon": CEF can't reach the game texture atlas (no real item sprites — a documented Path-B
  // limit), so each row gets an honest generated swatch instead — a drafting tile whose HUE is a
  // deterministic hash of the item id (same item ⇒ same colour every time) with the item's 1–2 letter
  // initials on it. No hardcoded item table, so a modded item gets a stable colour of its own.
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

  /* Paging for the item list. Neither a wall screen (tap-only) nor MCEF (no wheel event forwarded) can
     scroll it — so: two explicit page buttons, dimmed at each end, plus a "first visible / total" mark.
     Returns the sync fn the renderer calls after every update; it never touches scrollTop itself. */
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
  const syncComps = pager(R.comps, R.cUp, R.cDn, R.cPos);   // the same control, on the flattened record

  /* Chips are rebuilt only when the TAG SET changes — a rebuild on every push would cancel the click the
     player is in the middle of making. Clicking the active chip clears the filter. */
  function renderChips(tags, active) {
    const box = R.chips; if (!box) return;
    const key = tags.map(function (t) { return t.tag; }).join("|");
    if (box.__key !== key) {
      box.__key = key; box.innerHTML = ""; box.__pool = [];
      const all = el("button", "chip", "All");
      all.type = "button";
      on(all, function () { pick(""); });
      box.appendChild(all);
      box.__pool.push({ node: all, tag: "" });
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i];
        const b = el("button", "chip", shortTag(t.tag) + " (" + t.stacks + ")");
        b.type = "button";
        b.title = t.tag;
        on(b, (function (tag) { return function () { pick(tag); }; })(t.tag));
        box.appendChild(b);
        box.__pool.push({ node: b, tag: t.tag });
      }
    }
    for (let i = 0; i < box.__pool.length; i++) {
      const c = box.__pool[i];
      cls(c.node, c.tag === active ? "chip on" : "chip");
    }
  }

  function pick(tag) {
    filter = (tag === filter) ? "" : tag;   // clicking the active chip clears it
    mc.send({ action: "filter", tag: filter });
  }

  /* The stores card: how full it is, and how much of that reading the slot cap let us take. Past 90 %
     the whole card changes key — the bar, the pip, the free-slot tile and the card's own corner ticks
     all go amber together, so "nearly full" reads from across a room without anybody parsing a number. */
  function renderStores(s) {
    const slots = num(s.slots) || 0, used = num(s.used) || 0;
    const pct = slots ? Math.round((used / slots) * 100) : 0;
    const hot = pct >= 90;

    cls(R.nStock, hot ? "node stk hot" : "node stk");
    txt(R.invName, s.name || "Stock");
    cls(R.fState, "n-state " + (hot ? "warn" : "run"));
    txt(R.fStateTxt, slots ? (pct + "% full") : "no slots");

    txt(R.pctBig, slots ? String(pct) : D);
    cls(R.pipFull, hot ? "pip on" : "pip");
    txt(R.freeTxt, group(s.free) + " slots free");

    if (R.fill) { R.fill.style.width = pct + "%"; cls(R.fill, hot ? "fill hot" : "fill"); }
    txt(R.gval, used + " / " + slots + " slots");

    txt(R.tUsed, group(used));
    txt(R.tFree, group(s.free));
    cls(R.tFree, hot ? "t-v warm" : "t-v up");
    txt(R.tKinds, group(s.distinct));
    txt(R.tItems, group(s.items));

    txt(R.tWatch, s.name || D);
    // Say when the walk was cut short right where the slot numbers are read, not only in the footnote.
    const scanned = num(s.scanned);
    txt(R.tRead, (scanned == null ? D : group(scanned)) + " of " + group(slots));
    cls(R.tRead, s.partial ? "v warm" : "v");
    txt(R.tFilter, filter ? shortTag(filter) : "all");
    cls(R.tFilter, filter ? "v list" : "v");
    txt(R.tTags, String((s.tags || []).length));
  }

  /* The rows are a REUSED POOL. A blanket `innerHTML = ""` on every push destroys the reader's scroll
     position, which on a paged list means the ▲/▼ buttons can never get you anywhere. So the pool is
     rebuilt only when the row COUNT changes, and the cells are patched in place. The pager is re-synced
     on EVERY frame, not just a rebuild — a resize changes what fits without changing content. */
  function renderList(items) {
    const box = R.list; if (!box) return;
    let i;
    box.__items = items;                      // what the pooled click handlers read — see inspect()
    if (box.__n !== items.length) {
      const keep = box.scrollTop;
      box.__n = items.length; box.innerHTML = ""; box.__pool = [];
      for (i = 0; i < items.length; i++) {
        const li = el("li", "irow"), bar = el("i"), nm = el("span", "nm"), sw = el("span", "sw-tile"),
              lbl = el("span", "nm-t"), ct = el("span", "c");
        nm.appendChild(sw); nm.appendChild(lbl);
        li.appendChild(bar); li.appendChild(nm); li.appendChild(ct);
        // A row is a button. The handler is bound to the POOL SLOT, not to the item, because the pool
        // outlives the data in it — it reads whatever row is at this index when the tap happens.
        on(li, (function (idx) { return function () { inspect(box.__items[idx]); }; })(i));
        box.appendChild(li);
        box.__pool.push({ bar: bar, sw: sw, nm: lbl, ct: ct, hue: null, w: null });
      }
      box.scrollTop = keep;
    }
    // The server sends the rows already sorted by count, so the head of the list IS the scale the share
    // bars are drawn against. Floored at 2 %, so the smallest holding is still a visible mark.
    const top = items.length ? (num(items[0].count) || 1) : 1;
    for (i = 0; i < items.length; i++) {
      const it = items[i], cell = box.__pool[i]; if (!cell) break;
      const hue = hashHue(it.id);
      if (cell.hue !== hue) {                      // the hue only changes when a row's ITEM changes
        cell.hue = hue;
        // one write: the tile takes its border, its initials and its wash from currentColor
        cell.sw.style.color = "hsl(" + hue + ",68%,64%)";
        cell.sw.style.background = "hsla(" + hue + ",60%,50%,.14)";
      }
      const w = clamp((num(it.count) || 0) / top * 100, 2, 100).toFixed(1) + "%";
      if (cell.w !== w) { cell.w = w; cell.bar.style.width = w; }
      txt(cell.sw, initials(it.name));
      txt(cell.nm, it.name);
      txt(cell.ct, group(it.count));
    }
    syncList();
  }

  /* An empty list always says WHICH kind of empty it is: an inventory with nothing in it, a tag nothing
     carries, and a list() the slot cap refused are three different situations, and reading "empty" for
     the last one would be a lie the fill bar right beside it contradicts. */
  function renderContents(s, rows) {
    cls(R.nContents, "node cts");
    txt(R.cName, "Contents");
    cls(R.cState, "n-state " + (rows.length ? "list" : "idle"));
    txt(R.cStateTxt, rows.length ? (rows.length + (filter ? " shown" : " kinds")) : "none");
    cls(R.cPh, rows.length ? "ph" : "ph on");
    if (!rows.length && R.cPh) {
      R.cPh.firstChild.textContent =
        s.listNote ? "ITEM ROWS UNAVAILABLE"
        : (filter ? ("NOTHING HERE CARRIES “" + shortTag(filter).toUpperCase() + "”")
                  : "EMPTY — NOTHING STORED HERE YET");
    }
    renderChips(s.tags || [], filter);
    renderList(rows);
  }

  /* ---- the per-slot inspector -----------------------------------------------------------------------
     Every button below asks the SERVER for something; none of them decides anything. `inspect` and
     `reread` are the only two messages this page sends that can cost a faculty call, one each, and only
     because a person pressed something — the 1 s heartbeat still costs nothing, which is the property the
     whole app is built around. */

  function inspect(it) {
    if (!it) return;
    // A row with no slot (list() refused past itemsMaxSlots) is still sent: the server answers with a
    // reason card and spends no call, which teaches the player more than an unresponsive row does.
    wantSlot = (num(it.slot) == null) ? -1 : it.slot;
    wantAt = Date.now();
    mc.send({ action: "inspect", id: it.id, slot: it.slot });
  }

  // Step between the slots holding this item — the only way to tell two enchanted books apart, since they
  // share an id and are therefore one row. One faculty call per press, exactly like the first tap.
  function step(dir) {
    const d = lastDetail; if (!d) return;
    const slots = d.slots || [], j = (d.at == null ? -1 : d.at) + dir;
    if (j < 0 || j >= slots.length) return;
    wantSlot = slots[j];
    wantAt = Date.now();
    mc.send({ action: "inspect", id: d.rowId, slot: slots[j] });
  }

  on(R.dBack, function () { wantSlot = null; mc.send({ action: "close" }); });
  on(R.dPrev, function () { step(-1); });
  on(R.dNext, function () { step(1); });
  on(R.dAgain, function () {
    if (lastDetail && lastDetail.slot >= 0) { mc.send({ action: "reread" }); }
  });

  /* The record, flattened: tag rows and dot-path component rows under their own section marks, in one
     paged list. One list rather than a tag strip plus a component strip, because a wrapping strip of tags
     takes an unpredictable number of rows out of a fixed sheet — and the rows it takes are the component
     rows, which are the ones worth reading. Rebuilt only when the record changes shape; patched otherwise,
     so a push mid-page does not throw the reader back to the top. */
  function renderFields(d) {
    const box = R.comps; if (!box) return;
    const tags = d.tags || [], fields = d.fields || [];
    const rows = [{ s: "Tags · " + tags.length }];
    if (!tags.length) { rows.push({ k: "—", v: "this stack carries no tags" }); }
    for (let i = 0; i < tags.length; i++) { rows.push({ k: tags[i], v: "" }); }
    rows.push({ s: "Components · " + fields.length + (d.truncated ? " · truncated" : "") });
    if (!fields.length) {
      rows.push({ k: "—", v: d.truncated
        ? "the map was cut short before a single value came through"
        : "nothing beyond this item's own defaults" });
    }
    for (let i = 0; i < fields.length; i++) { rows.push({ k: fields[i].k, v: fields[i].v }); }

    const key = d.slot + "|" + d.id + "|" + rows.length + "|" + (d.truncated ? 1 : 0);
    if (box.__key !== key) {
      box.__key = key; box.__n = rows.length; box.innerHTML = ""; box.__pool = []; box.scrollTop = 0;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].s != null) {
          const sect = el("li", "crow sect");
          box.appendChild(sect); box.__pool.push({ sect: sect });
        } else {
          const li = el("li", "crow"), k = el("span", "k"), v = el("span", "v");
          li.appendChild(k); li.appendChild(v);
          box.appendChild(li); box.__pool.push({ k: k, v: v });
        }
      }
    }
    for (let i = 0; i < rows.length; i++) {
      const cell = box.__pool[i]; if (!cell) break;
      if (rows[i].s != null) { txt(cell.sect, rows[i].s); }
      else if (cell.k) { txt(cell.k, rows[i].k); txt(cell.v, rows[i].v); }
    }
    syncComps();
  }

  /* One slot. `d` is null for the tick between the tap and the answer, and carries a non-"ok" state for
     each of the ways there can be no record — an empty slot (detail() returns null), a slot the handler
     does not have (detail() throws), a device that left, and a row that never had a slot behind it. All
     four are a reason card over the record, never a blank sheet and never a dead app.

     `truncated` is a CARD STATE, not a field: the badge blinks, the whole contents card goes amber the way
     the stores card does past 90 %, and the status foot names the two knobs. That flag is the visible end
     of the itemComponentMaxDepth / itemComponentMaxNodes chain, so lowering a knob and re-opening a card
     has to be legible at a glance from across the room. */
  function renderDetail(d) {
    lastDetail = d;
    const ok = !!(d && d.state === "ok");
    const trunc = ok && !!d.truncated;

    cls(R.nContents, trunc ? "node cts hot" : "node cts");
    txt(R.cName, "Slot Detail");
    cls(R.cState, "n-state " + (trunc ? "warn" : (ok ? "list" : "idle")));
    txt(R.cStateTxt, trunc ? "truncated" : (ok ? ("slot " + d.slot) : "no record"));

    const slots = (d && d.slots) || [], at = d ? (num(d.at) == null ? -1 : d.at) : -1;
    txt(R.dWhere, (d && num(d.slot) != null && d.slot >= 0) ? ("SLOT " + d.slot) : "SLOT —");
    txt(R.dPos, slots.length ? ((at >= 0 ? at + 1 : "—") + "/" + slots.length) : "0/0");
    dis(R.dPrev, at <= 0);
    dis(R.dNext, at < 0 || at >= slots.length - 1);
    dis(R.dAgain, !d || !(d.slot >= 0));

    cls(R.dState, ok ? "dstate" : "dstate on");
    if (!ok) {
      txt(R.dStateH, (d && STATE_HEAD[d.state]) || "READING");
      txt(R.dStateR, (d && d.reason) || "Asking the server for this slot…");
      txt(R.dNote, ""); cls(R.dNote, "noteline");
      return;                       // nothing under the overlay is worth patching
    }

    const hue = hashHue(d.id);
    if (R.dSw) {
      R.dSw.style.color = "hsl(" + hue + ",68%,64%)";
      R.dSw.style.background = "hsla(" + hue + ",60%,50%,.14)";
      txt(R.dSw, initials(d.name));
    }
    txt(R.dName, d.name || D);
    txt(R.dId, d.id || D);
    cls(R.dTrunc, trunc ? "trunc on" : "trunc");

    const maxDmg = num(d.maxDamage) || 0;
    txt(R.dCount, group(d.count));
    txt(R.dMax, group(d.maxCount));
    txt(R.dDur, maxDmg ? (group(maxDmg - (num(d.damage) || 0)) + "/" + group(maxDmg)) : D);
    cls(R.dDur, (maxDmg && (num(d.damage) || 0) > maxDmg * 0.75) ? "t-v warm" : "t-v");
    txt(R.dFields, group((d.tags || []).length + (d.fields || []).length));

    renderFields(d);

    // The caveats, in the order they matter: what the caps cut, what the wire cut, and — because a slot is
    // read once on a tap and the board keeps sweeping around it — a slot that no longer holds the item
    // whose row was tapped.
    let note = "";
    if (trunc) {
      note = "The component map was cut short by itemComponentMaxDepth / itemComponentMaxNodes — the"
        + " values below are partial. Raise either knob in the server config to see the rest.";
    }
    if (d.capped) { note = (note ? note + " " : "") + "Only the first " + (d.fields || []).length + " component rows were published."; }
    if (d.rowId && d.id && d.rowId !== d.id) {
      note = (note ? note + " " : "") + "This slot now holds " + (d.name || d.id) + ", not the item whose row you tapped.";
    }
    txt(R.dNote, note);
    cls(R.dNote, note ? "noteline on" : "noteline");
  }

  /* The status line and the footnote say the same thing at two lengths: the bar carries the state in a
     handful of words, the footnote under the fill bar carries the numbers and wraps so it can be read
     in full. Both exist because the board stays up when a read is refused — and a board that stays up
     without saying so is worse than one that dies. */
  function renderStatus(s) {
    const slots = num(s.slots) || 0;
    let note = "";
    if (s.partial) { note = "Only the first " + group(s.scanned) + " of " + group(slots) + " slots were read (itemsMaxSlots)."; }
    if (s.listNote) { note = (note ? note + " " : "") + "Item rows unavailable: " + s.listNote; }
    txt(R.noteLine, note);
    cls(R.noteLine, note ? "noteline on" : "noteline");

    // An open slot card owns the status line. Short lines on purpose: this cell ellipses, and the card's
    // own note — which wraps, and carries the two knob names — is the one that has to be read in full.
    const d = s.detail;
    if (d && d.state === "ok" && d.truncated) {
      cls(R.stLamp, "st-lamp warn"); cls(R.stTxt, "st-txt warn");
      txt(R.stTxt, "Component map truncated — the caps cut it short.");
      return;
    }
    if (d && d.state !== "ok") {
      cls(R.stLamp, "st-lamp err"); cls(R.stTxt, "st-txt err");
      txt(R.stTxt, "No record for that slot — the card says why.");
      return;
    }
    if (d) {
      cls(R.stLamp, "st-lamp ok"); cls(R.stTxt, "st-txt");
      txt(R.stTxt, "Slot " + d.slot + " read once, on your tap — a snapshot.");
      return;
    }

    if (s.listNote) {
      // list() refused, summary() did not — so the fill bar and the totals stand, and any rows on the
      // board came out of summary().totals with their names derived from ids rather than looked up.
      cls(R.stLamp, "st-lamp err"); cls(R.stTxt, "st-txt err");
      txt(R.stTxt, "Rows refused past the cap — totals stand, names from ids.");
    } else if (s.partial) {
      cls(R.stLamp, "st-lamp warn"); cls(R.stTxt, "st-txt warn");
      txt(R.stTxt, "Partial read — the slot cap cut the walk short.");
    } else {
      cls(R.stLamp, "st-lamp ok"); cls(R.stTxt, "st-txt");
      txt(R.stTxt, "Reading " + group(slots) + " slots on the server's clock.");
    }
  }

  // --- authoritative state in ---
  let lastState = null, lastRecv = 0;
  function setLink(live) { cls(R.link, live ? "link" : "link down"); txt(R.linkTxt, live ? "LINK LIVE" : "NO SIGNAL"); }

  function render(state) {
    const ok = !!(state && state.ok);
    cls(R.offsheet, ok ? "offsheet" : "offsheet on");
    if (!ok) {
      txt(R.offReason, (state && state.reason) ? state.reason : "Searching for an inventory…");
      setLink(false);
      return;
    }
    filter = state.filter || "";
    const rows = state.rows || [];

    // The open card lives on the SERVER, like the filter, so both viewers of a wall screen see the same
    // one. `wantSlot` only holds the pane open for the tick between this viewer's tap and the answer —
    // and across a sweep push that lands in between. It gives up after that, so the OTHER viewer tapping
    // BACK closes this one's pane too rather than stranding it on a "reading" overlay for good.
    const d = state.detail || null;
    if (d) { wantSlot = d.slot; wantAt = Date.now(); }
    else if (wantSlot != null && Date.now() - wantAt > 2500) { wantSlot = null; }
    const open = !!d || wantSlot != null;
    cls(R.paneList, open ? "pane" : "pane on");
    cls(R.paneDet, open ? "pane on" : "pane");

    renderStores(state);
    if (open) { renderDetail(d); } else { lastDetail = null; renderContents(state, rows); }
    renderStatus(state);

    txt(R.op, (mc.player || D) + (mc.display ? " · " + String(mc.display).replace(/^Screen:\s*/, "") : ""));
    txt(R.hdrSlots, (num(state.used) == null ? D : state.used) + "/" + (num(state.slots) == null ? D : state.slots));
    txt(R.hdrItems, group(state.items));
    txt(R.tbFilter, filter ? shortTag(filter).toUpperCase() : "ALL");
    txt(R.tbRows, String(rows.length));
    setLink(true);
  }

  mc.onState = function (state) {
    lastRecv = Date.now(); lastState = state;
    try { render(state); } catch (err) {          // one bad field must never kill the loop
      if (R.stTxt) { R.stTxt.className = "st-txt err"; R.stTxt.textContent = "render error: " + err; }
    }
  };

  // --- the two page-local timers: a clock, and the stale-link watchdog ---
  function two(n) { return (n < 10 ? "0" : "") + n; }
  setInterval(function () {
    const d = new Date();
    txt(R.clock, two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds()));
    if (lastRecv && (Date.now() - lastRecv) > STALE_MS) { setLink(false); }
  }, 1000);

  // A resize changes what fits without changing content, so re-render the last snapshot rather than
  // waiting for the next push to fix the pager.
  let rt = null;
  window.addEventListener("resize", function () {
    if (rt) clearTimeout(rt);
    rt = setTimeout(function () { rt = null; if (lastState) mc.onState(lastState); }, 150);
  });

  // --- view heartbeat: tell the server somebody is looking. It answers from cache, so this cannot
  //     move the device-call rate; the inventory read happens on the server's clock either way. ---
  mc.send({ action: "poll" });
  setInterval(function () { mc.send({ action: "poll" }); }, POLL_MS);
})();
