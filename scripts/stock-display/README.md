# stock-display — what is in there, by name

A Path-B (web UI) board for **any inventory on the Silica network** — a chest behind a Port, a
Collector's buffer, another mod's storage block. It shows how full it is, what is in it **by name**,
a tag filter built from the tags the contents actually carry, and — on a tap — **one slot in full**,
data components and all.

Core-only, no integration jar. Read-only: it never moves an item.

## What it needs

1. A **smart computer** — SilicaOS ROM + GPU + web-display — with a **NIC**.
2. Something with an inventory on the network: a Port wired onto a chest, or a Collector wired to the
   computer. Anything whose `faculties` include `items`.
3. Screwdriver-label the one you want `stock`; otherwise the app takes the first it finds.

Run it from the Runner and stream it to a named monitor, or open it on a pad or pocket computer.
Remember the Silica invariant: **unloaded = offline**, and an offline block shows as a reason card
rather than a stale list.

## What it shows

A **drafting sheet** — the same near-black paper and warm ivory ink as the Perimeter Watch, Prospector's
Survey and Reactor Control boards, in two cards: **STORES** (how full it is) and **CONTENTS** (what is in
it, or one slot in full). Teal is capacity in hand, amber is the warning, cyan is the tag filter and the
rows it narrows. It is fixed and non-scrolling, and every dimension is in `rem` off one viewport-derived
root, so it reads at a 512×384 wall screen and scales as a unit up to a full-window pocket render.

- A **fill bar**, `42 / 54 slots`, straight off `items.summary()`. It turns amber past 90 % — and so does
  the rest of the stores card, down to its corner ticks, so "nearly full" reads from across a room.
- **Totals by item**, summed across every slot — twenty stacks of cobblestone are one row reading
  `1,204`, not twenty rows you add up in your head.
- **Names, not ids.** `Oak Log`, not `minecraft:oak_log`. (That name is resolved in the *server's*
  language, not the viewer's — the Manual's `device` page says why, and what to do if you need
  per-client text.)
- **Tag chips.** Click `logs` and the board shows only what is tagged as a log. The chips are derived
  from what is in the inventory, so they follow whatever mods are installed.

The list pages with the ▲/▼ buttons and the filter is chips rather than a text box. Both are the same
reason: a wall screen forwards only mouse press and release — no wheel, no drag, no keys — so anything
that needs scrolling or typing is content nobody can reach.

### The slot inspector

**Tap a row** and the contents card turns into that slot in full: the whole `items.detail(slot)` record —
name, id, count, max stack, durability, tags — plus the stack's **data components**, which is the part no
other read gives you. It is what tells two enchanted books apart: they share an id, so they share a row,
and only their components differ.

- **Components are flattened to dot paths** — `minecraft:stored_enchantments.levels.minecraft:sharpness`
  → `5` — and paged with the same ▲/▼ control as the item list. The map is an arbitrarily nested object
  and this surface has no tree to expand and no wheel to scroll, so the nesting is turned into rows on the
  server rather than into a widget nobody can operate.
- **`truncated` is a card state, not a field.** When a component cap fires, a badge blinks, the whole card
  changes key to amber the way the stores card does past 90 %, and the note names the two knobs. That flag
  is the visible end of the `itemComponentMaxDepth` / `itemComponentMaxNodes` chain — lower either one in
  the server config, re-open a card on a heavily-componented stack, and the difference reads across a room.
- **◀ ▶ steps between the slots holding that item** (each press is one fresh read), **↻ reads the slot
  again**, and **BACK** returns to the list.
- The two edges of `detail()` are cards, never a dead app: an **empty slot** answers `null` and reads
  *SLOT EMPTY*; a slot the handler **does not have** throws and reads *SLOT REFUSED* with the thrown
  message. A row that came from `summary()` totals with no slot behind it says that too.

The card is a **snapshot of the moment you tapped**, while the board around it keeps sweeping. That is
deliberate — see below.

## What to read in the code

This app exists to show the widened `items` faculty being pleasant to build against.

- `entrypoint.js` → `read()` — **two reads, two `try` blocks, and that is the point.**
  `items.summary()` is bounded by distinct item ids and never refuses on size; `items.list()` throws on
  an inventory bigger than the `itemsMaxSlots` knob, because a partial list would let a sorter move the
  wrong items. Keeping them apart means a 4096-slot storage block still gets a fill bar and totals, and
  the board says why the rows are missing instead of dying.
- `entrypoint.js` → `tagChips()` and `itemRows()` — **there is not one item id in this file.** The
  filter is built from `s.tags`, so a modded log the app has never heard of appears under `logs` on its
  own. A version written against ids would need about sixty of them for vanilla wood alone.
- `entrypoint.js` → the split between `read()` and `view()` — the device is read on the server's clock,
  once per `SWEEP_MS`; a viewer poll **or a filter click** re-derives the published view from that same
  cached reading, with **zero** faculty calls. Ten people clicking chips cost exactly what one does.
- `entrypoint.js` → `openDetail()` / `fetchDetail()` — **click → fetch → cache, and nothing else may
  fetch.** A tap on a row sends `{action:"inspect"}`; the server resolves the slot from the *cached*
  reading, spends **one** `detail(slot)` call, and holds the answer in `detail` until the card is closed
  or the slot changes. The sweep never calls it, a viewer poll never calls it, and re-tapping the open row
  costs nothing — `publish()` just re-sends the card it already has. Only the ◀ ▶ stepper and the explicit
  ↻ button spend another one, one per press. That is why the card is a snapshot: a card that refreshed
  itself would be a `detail()` call per tick per open card, which is exactly the per-viewer server work the
  `read()`/`view()` split exists to prevent.

  And it is why the faculty made components a **per-slot call rather than a flag on `list()`**
  (E3P10-D4). A flag is one call for everything, which sounds cheaper until the inventory is fifty-four
  slots of written books — a per-item cap with no bound on the aggregate, the shape that has produced four
  separate defects in this repo. Per-slot costs one game-thread round trip each, and *makes you spend it
  on purpose*: this app spends exactly as many as the player asked for, and that is legible in one
  function.
- `entrypoint.js` → the run loop — `os.pullEvent("web_message", waitSeconds())`, the **timed** form.
  The untimed one advances only when somebody is looking.
- `ui/client.js` → `renderChips()`, `renderList()` and `renderFields()` — all three rebuild only when
  their *shape* changes (the tag set, the row count, the record) and patch in place otherwise, so a push
  mid-click does not cancel the click and does not throw the reader back to the top of a paged list.
- `ui/style.css` → the header comment, and the `html{font-size:clamp(...)}` line **after** the `font:`
  shorthand. On the root element a `1rem` font-size resolves against 16px, so a clamp written before the
  shorthand is silently overridden and the sheet stops scaling — that is bug **B10**, which shipped once.

## Capability doors

**network** (needs a NIC) + **web** (needs web-display). The `items` faculty adds no door of its own:
it reads a handler the script could already reach, in more detail.
