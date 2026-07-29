# geo-prospector — the prospector's survey room

A SilicaOS **web dashboard** (Path B) for the Silica **Geo Scanner**. The scanner fires one **pulse**,
sweeps a **cube of ground beneath itself**, and hands over the whole survey; this app is the reading room for
it — plots, a walkable vein list, a **recommended shaft depth**, and a log of what changed since your last
pulse.

It is a **prospecting instrument, not automation**: it never pulses on its own. Every pulse is your click
(or the block's own GUI button / redstone edge).

## What it scans — a cube, and it is all BELOW you

This is the one thing to get right before you place the block:

- The scanned volume is a **cube**, not a bubble. Its **edge is `2 × radius + 1`** blocks — the *same* on all
  three axes.
- The cube hangs **entirely below the scanner**: its **top face is the layer at the scanner's own Y minus 1**.
- So **there is no upward reach at all.** A scanner in a cave surveys the floor beneath it and *nothing*
  overhead — put it on the ceiling of the area you want read, not in the middle of it.
- The **footprint is a square**, not a circle: the corners are surveyed too, and the PLAN plot draws that
  square honestly rather than a range ring.
- **`radius` is only the horizontal half-extent.** How deep the cube goes is its **edge** — a cube's depth is
  its width — which is why the app shows `edge`/`depth` next to the radius everywhere it has room.

At the jar's default base radius of 16 and the fixed range-chip ladder (`+0 / +8 / +16 / +48`):

| Range chip | Radius (half-extent) | Cube edge = depth below | A scanner at y 64 reads down to |
|---|---|---|---|
| none | 16 | 33 | y 31 |
| T1 | 24 | 49 | y 15 |
| T2 | 32 | 65 | y −1 |
| T3 | 64 | 129 | y −65 |

**Bedrock is a T3 privilege** — that is the point of the top tier. The deepest block read is always
`scannerY − edge`, and the whole ladder shifts with `geoScannerBaseRadius`; the server's
`geoScannerMaxRange` then clamps the total (the sheet says so on-screen when it bites).

## What it shows

- **PULSE + live sweep progress** — the sweep is deliberately slow (the bigger the radius, the longer it
  takes — and a cube grows as the *cube* of it), and you watch it climb: the sweep front is drawn as a rising
  line in the SECTION plot, because the scanner reads the cube **bottom-up, one Y layer at a time**.
- **PLAN (XZ)** — the survey from above, scanner-centred: the **square footprint** and its thirds, cardinal
  ticks, one dot per vein sized by how many blocks it holds and coloured by its block. The focused vein is
  ringed and a dashed line is drawn to it.
- **SECTION (Y)** — a mine section: horizontal distance from the scanner runs left→right, world Y runs down
  the page, and the scanned cube draws as a **rectangle** with **the scanner sitting on its top rule** —
  everything the survey knows is under that line. Every vein sits at its true depth, the Y axis is labelled
  with the scanner's own level and the bottom of the cube, and the recommended shaft band is ruled across it.
- **Shaft advisor** — an **ore-per-Y histogram** and, from it, the Y to dig at (see *How the shaft
  recommendation works* below). This is the number the plots cannot tell you by eye.
- **Vein table** — sorted by **NEAREST** or **RAREST**, each row showing quantity, distance, bearing +
  16-point cardinal, depth and a **FOUND** column (see below). **Click a row to FOCUS that vein**: the
  block's hologram highlights it and a vanilla **compass in the scanner's compass slot** starts pointing at
  it, so you can walk to it with no map and no coordinates. The **WALK TO** panel bottom-right is that
  bearing, big.
- **Tally** — every block type the survey found, with counts and a share bar. It is also the **ONLY picker**
  (below): tap a row to narrow the sheet to that one block.
- **ONLY** — a **view filter**: show just one block type. See *ONLY, SEARCH and the scan filter* below; it is
  the difference between a survey and an answer.
- **SEARCH** — the **free-text** view filter, in the vein card under NEAREST / RAREST. Type `diamond`,
  `deepslate`, `xychorium`, or a bare namespace like `mekanism:`, and the vein table and both plots narrow to
  matching blocks **as you type** — no Enter, no pulse. It **composes with ONLY** rather than replacing it.
  **Typing needs a keyboard**, which only the SilicaOS desktop window, a pad and a pocket computer have; on an
  in-world wall screen the box shows the live query and the **✕** clears it, but you cannot type into it.
- **Site log** — built from the scanner's own `diff`: veins that **vanished** between two pulses (mined out
  — by you, a quarry, or someone else) and ore **newly exposed**. Pulse, mine, pulse again.
- **Filter presets** — the scanner's filter takes block ids *and* `#tag` strings, so it is a general block
  finder: **ORES** (`#c:ores`, every modded ore in the pack), **SPAWNER**, **BUDDING** (budding amethyst),
  **DEBRIS** (ancient debris), **CHESTS**. One click each. Edit or extend the list in `entrypoint.js`.
- **Radius steppers** — −4 / +4 / MAX, clamped to what the installed range chip and the server allow. Each
  ±4 of radius is **±8 blocks of cube edge, and therefore ±8 blocks of depth**; the readout beside the
  stepper shows both (`32 blk · 65³`). If the server clamps below what your chip would give, the sheet says
  so instead of ignoring the chip.
- **Detector overlay** — if an **Entity Detector** is also on the network, `MOBS` overlays its entities on
  the PLAN plot (hostile = red ✕, player = cyan diamond, other = teal ring): *what is living in the cave I
  am about to breach*. With no detector present the button just reads `MOBS: NO DETECTOR`.

## What RAREST means (and what the FOUND column is)

**Rarity is how many blocks of that ore the whole scan found. Fewest found = rarest.** Nothing else goes
into it — not the size of an individual lump, and *not distance*: there is already a NEAREST sort for that.

The **FOUND** column is that number, as `×3`, with a bar drawn from the same fact so the bulk ore reads as a
stub. It sits next to **Qty**, which is a different question: `Qty` is how many blocks *this vein* holds,
`FOUND` is how many the *survey* holds of that ore. A nine-block diamond vein in a scan that turned up nine
diamond reads `Qty 9 · FOUND ×9`.

So a scan that finds **300 copper, 2 stella arcana, 3 diamond and 1 allthemodium** orders RAREST as:

1. every allthemodium vein (nearest first)
2. every stella arcana vein (nearest first)
3. every diamond vein (nearest first)
4. every copper vein (nearest first)

Rarity is therefore a property of the **ore**, not of the vein — every diamond vein in one survey shares one
score — and distance only orders veins *within* an ore. It is also **self-relative**: the same diamond
ranks differently depending on what else the pulse turned up, and re-pulsing with a different filter
rescales everything. Rank within one survey; never compare two.

*(This is the E3P9-D22 definition. It used to be "how small is this vein as a share of the scan", which
meant a single stray block of coal out-ranked a nine-block diamond vein, every one-block find scored
identically, and the tie fell through to distance — so the top of RAREST was the nearest junk in the
survey.)*

## ONLY, SEARCH and the scan filter — three different things, and the sheet keeps them apart

A tier-3 cube survey in a real world turns up **well over a thousand veins**, and almost all of it is coal
and copper. The vein table pages 32 rows at a time — a big survey runs to a hundred and twenty pages — so
*"where is the diamond"* is unanswerable by paging. The sheet has **two view filters** for it, and they
**compose** (a vein has to pass both):

| | What it is | How you drive it |
|---|---|---|
| **ONLY** | one **exact** block type | **one tap** on a Tally row |
| **SEARCH** | a **free-text substring** | **typed**, in the vein card |

Use ONLY when the ore is in front of you in the Tally. Use SEARCH when it is not — a modded pack sweeping
`#c:ores` easily turns up thirty-plus distinct ores, so the Tally itself needs paging, and typing four letters
beats hunting for the row. Or use both: SEARCH `platinum` to find which mod's platinum you are looking at,
then ONLY the one you want.

### ONLY — the one-tap exact filter

**How to use it — two ways in, one way out:**

- **Tap a row in the Tally list** (bottom of the sheet) to filter to that block. Tap the **same row again**
  to clear. The active row turns violet; that is the picker's own toggle. (The Tally's header says
  `TAP = ONLY` because a wall screen has no hover to discover a button with.)
- The **ONLY chip** then appears in the vein card's top row, beside NEAREST / RAREST, reading e.g.
  `ONLY DEEPSLATE DIAMOND ✕`. **Tap the chip to clear.** It is hidden whenever no filter is held, so if you
  see it, something is being hidden from you — deliberately.

### SEARCH — the free-text filter

Type into the **Search** box under NEAREST / RAREST. It filters **as you type** — there is no Enter to press,
and deliberately so (see *Notes*). The **✕** beside the box clears it, and appears only while a query is held.

What a query is matched against, **case-insensitively**, is *both*:

- the **raw block id** — so `mekanism:` (or `alltheores:`) works, and is the **only** way to tell two mods'
  identically-named `platinum_ore` apart, because the table's displayed names are truncated *and* have the mod
  prefix stripped;
- the **displayed name**, spaces and all — so `deepslate diamond` and `diamond ore` both work even though the
  id spells them with underscores.

So `diamond`, `deepslate`, `allthemodium`, `xychorium` and `mekanism:` are all useful queries. It is a plain
**substring** test, never a pattern: `.*` matches a block literally called `.*`, i.e. nothing.

**It composes with ONLY, it does not replace it.** Both stay visible (the ONLY chip, the lit Search box) and
both clear independently. ONLY `deepslate_diamond_ore` + SEARCH `coal` shows **nothing** — that is the AND
working, and the vein card says which filters emptied it.

Whitespace-only is no filter at all. A query matching nothing says **NO VEIN MATCHES "…"** in the vein card
rather than showing an unexplained empty table. Unlike ONLY, a query is **never auto-cleared by a new pulse**:
a block filter the new survey cannot satisfy would leave you staring at an empty table (so ONLY is dropped,
loudly), whereas free text is your own words and deleting them silently would be the more surprising failure.

**What the two view filters narrow:**

| | ONLY / SEARCH apply? |
|---|---|
| Vein table (rows, paging, rank, sort) | **yes** |
| PLAN (XZ) and SECTION (Y) plots | **yes** — this is most of the value; *where* is a map question |
| Ore-per-Y histogram + shaft advisor | no — `byY` is an aggregate tally per layer, not per block |
| Tally list | no — the Tally **is** the ONLY picker; narrowing it would remove the way to pick |
| Headline counts (survey blocks, total veins, the header rule) | no — they always report the whole survey |

Because both are applied **on the server, before** the plots are capped at 2,000 dots, filtering spends that
whole budget on the ore you asked for instead of on the nearest 2,000 lumps of coal. It also means every viewer
of a shared wall screen sees the **same** narrowed survey — like the sort and the page, neither is a per-viewer
setting. (Two people typing different queries at once is therefore last-write-wins, and both boxes settle on
the same text.)

### Neither one is the scanner's scan filter

Keep these straight:

| | **Scan filter** (SCN card: *"Looking for"* + the presets) | **ONLY** / **SEARCH** (Tally row · chip · Search box) |
|---|---|---|
| Decides | what the sweep **looks for** | what the sheet **shows you** of a survey you already have |
| Costs | a device call **and a new pulse** to take effect | nothing — no device call at all |
| Lives on | the block (survives restarts, affects its own GUI + hologram) | this app's session |
| Set from | the preset buttons in `entrypoint.js` | ONLY: any block the survey found · SEARCH: anything you type |

So: **scan filter = ORES**, pulse once, then use **ONLY**/**SEARCH** to walk through diamond, then debris, then
emerald — all off the *same* pulse, instantly, with no re-sweep. Re-pulsing keeps both filters (that is usually
why you re-pulse); **ONLY** is **dropped automatically** if the new survey holds none of that block, with a
line in the site log and on the status bar saying so — you never get left staring at an empty table.

## Requirements

1. A **Geo Scanner** (3×3: the centre block plus its 8 pylons) placed and powered.
2. A **SilicaOS computer** — a computer with the **SilicaOS ROM + GPU + Web Display** components (the
   "smart" computer that boots the desktop), plus the **Web Display** mod and **MCEF** installed (needed to
   render any web UI).
3. The scanner must be **on that computer's network**:
   - give the computer a **NIC**;
   - place the scanner **face-adjacent** to the computer, or run a **Wire** between them (a Switch /
     Router→Receiver hop works too). **A pylon face counts** — the ring proxies both energy and network
     through to the controller, so you can plug into whichever face you can reach.
4. Capability doors, all default-open (`config/silica-server.toml`): **`network`** (the transport),
   **`geo`** (reading terrain — welded shut, the verbs throw and this app tells you so; the block's own
   hologram, GUI and compass keep working), and **`detector`** only if you want the mob overlay.

## How to run it

1. Open the **SilicaOS desktop** (right-click the smart computer).
2. Open **Folders**, find **`geo-prospector`**, and **Run** it (or use the **Runner** app and start
   `geo-prospector`).
3. To see the sheet, either:
   - **stream it to a physical monitor** — screwdriver-name a Silica **Screen** (or Pad), then in the
     **Runner** point the process's monitor dropdown at that screen; or
   - use the **Runner → View** button to open a floating window streaming the app.
4. Press **PULSE**. The sweep takes a few seconds — much longer at radius 32/64, because the volume grows as
   the *cube* of the edge (33³ = 36k blocks at radius 16 against 129³ = 2.1M at radius 64). The plots fill
   when it lands. If the sheet says *"No Geo Scanner on the network"*, re-check the wiring + NIC above.

## How the shaft recommendation works

Not "where is the most ore" — **where does a tunnel pay best per block dug**, which is a different answer.

1. Ore per Y layer is divided by **the number of blocks the sweep actually read in that layer** — which, for
   a cube, is the same `edge × edge` square in every layer. So the histogram is an **undistorted** count: the
   bars are the rock. (This is a real gain over the sphere the scanner used to sweep, whose middle slice was
   ~πr² blocks wide against a handful at its poles, so raw counts *always* peaked at the scanner's own level
   whatever the rock was doing and only became readable once that bulge was divided out.)
2. Standing at feet level *y* in a 1×2 branch tunnel you **dig 2 blocks per metre** and you **expose 8**:
   the floor (`y-1`), your two body layers and their side walls (`y`, `y+1`), and the ceiling (`y+2`).
   The score for *y* is that exposure weighted by each layer's density; **YIELD** is it expressed as ore
   exposed per 100 blocks dug. Ties break towards the **shallowest** band — same yield, less digging down
   (the whole volume is below the machine now, so "shallowest" *is* "nearest the scanner").
3. A tunnel whose exposure band would run off the **top or bottom of the cube** is not recommended at all —
   there is no data up there, and guessing is how a shaft advisor starts lying. (That is what
   `MIN_SLICE_CELLS` now guards. Under the old sphere it also threw out the thin polar slices, where one
   lucky diamond in a 20-block sliver could win; a cube has no thin slices — every layer inside it is at
   least 33² = 1,089 blocks.)

`SHAFT_BAND`, `DUG_PER_M` and `MIN_SLICE_CELLS` are at the top of `entrypoint.js` — change them if you mine
differently (a 1×3 tunnel, a 2-wide highway) and the advice follows your model.

**When the advice is PROVISIONAL:** the sheet labels it so, and says why, if either the survey was
**partial** (unloaded chunks were skipped — never loaded, by design) or the raw hit list was **truncated**
at the server's `geoScannerMaxResults` cap. A truncated hit list is biased low, because the sweep runs
bottom-up — so narrow the filter or drop the radius before trusting a depth.

## Where it lives

- On this instance: `silica/scripts/geo-prospector/` (this folder).
- It also ships **inside the Silica mod jar** as a seed app, so a fresh world gets it automatically.
- Files: `entrypoint.js` (the server-side script — it holds all the state and does all the capability
  access) and `ui/index.html` + `ui/client.js` + `ui/style.css` (the page). Edit them here to customise;
  changes take effect the next time you Run the app.

## Notes

- **Server-authoritative in both state and cadence.** The script keeps its own **1 s clock** (300 ms while
  a sweep is in flight) using `os.pullEvent("web_message", seconds)`, so a pulse completes, its survey is
  read and its `diff` lands in the site log **whether or not anybody is watching**. A viewer's poll is
  answered from cache and issues **zero** device calls, so the number of viewers cannot change the load on
  the server at all: one `status` per clock tick, and four heavier verbs (`survey`/`veins`/`scan`/`diff`)
  **once per pulse**.
- **The page holds no authority.** It only *requests*; every request is re-validated here against a live
  device, and a **scan** filter can only ever be one of the presets in `entrypoint.js` — the wire never
  carries a raw block id or tag to the scanner. An **ONLY** request does carry a block id, but it never
  reaches the device at all: it is checked against the survey already in hand and refused if that survey
  holds no such vein, so the worst a bad message can do is nothing. A **SEARCH** request is the one piece of
  genuinely free text on the wire, so it gets the two guards free text needs: it is **length-capped** (32
  characters — it rides the state snapshot back to every viewer) and **never interpreted** — a plain substring
  test against ids the survey already holds, never a pattern, and never anything the scanner is told.
- **Every list pages with ▲/▼ buttons**, never a scrollbar: a wall screen is tap-only and MCEF forwards no
  mouse wheel, so a scroll-only list would be unreachable in-world. Same reason the radius uses steppers
  instead of a slider.
- **The Search box is the one thing on the sheet that needs a keyboard**, and MCEF only receives typed
  characters from the surfaces that forward them — the **SilicaOS desktop window**, a **pad** and a **pocket
  computer**. An in-world wall screen forwards clicks and nothing else, so there the box displays the live
  query and the **✕** clears it, and everything else on the sheet stays reachable by tapping (the Tally is
  still a complete ONLY picker on its own). Two consequences by design: **no Enter is required** — filtering
  happens as you type, because Enter is a special case through MCEF (Minecraft fires no `charTyped` for it) and
  a search that depended on it simply would not work; and the outbound message is **debounced ~250 ms**, so a
  keystroke is not a server round-trip. A send that is never acknowledged is retried a couple of times and then
  abandoned, at which point the box shows what actually landed rather than what you hoped had.
- **Vein colours are hashed from the block id**, so a modded ore gets a stable colour of its own with no
  hardcoded ore table. They are *not* the block's real texture colour — the in-world hologram uses each
  block's vanilla `MapColor`, which a web page cannot see, so this one does not pretend to.
- **Approximate positions in the site log:** a vein's stable id quantises its centre to 4 blocks, so a vein
  that has been mined out (and is therefore no longer in any survey) is reported as `~x,y,z (+/-4)`.
- **The plots need one find to align.** World coordinates are recovered from a vein's centre, so a survey
  that matched nothing plots nothing — and the mob overlay, which converts the detector's absolute
  positions into scanner-relative ones, waits for the same thing.
