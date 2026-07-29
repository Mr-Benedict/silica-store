# rs-terminal — Refined Storage Terminal

A SilicaOS **web dashboard** (Path B) that acts as a storage-terminal for a **Refined Storage** network,
reached over the Silica network. Browse and search the whole network's items, request autocrafts, and
watch or cancel live crafting tasks — all from one page.

## What it shows

- **Storage tab** — every item in the network (`listItems`), sorted by count, with a live search box
  (server-filtered — typing narrows the actual network read, not just what's on screen).
- **Craftable tab** — every pattern the network can autocraft (`getPatterns`), each with a quantity
  stepper and a **Craft** button; an item already being crafted is flagged "crafting…".
- **Active tasks** — a live panel of running/queued autocraft jobs (`getTasks`): resource, quantity,
  progress bar, state, and a per-task **cancel** button, plus a **Cancel all**.
- **Network energy** — a fill bar for the network's own RS energy pool (read off `getStatus`, which
  already carries it; this is RS's internal energy, not Forge FE).
- A small stats row (`getStatus`): controller connected/unformed, item types, fluid types, active task
  count, pattern count.
- **Network chips** in the header — one per reachable RS network, tap to switch. A controller that has
  gone offline keeps its chip, marked dead, instead of disappearing.

## Driving it on a wall screen

A Silica **Screen** forwards a mouse press and a mouse release to the page and nothing else: no
keyboard, no scroll wheel, no drag. Everything on this terminal is therefore a tap target.

- **▲ / ▼ pagers** under the item list and the task list, with a "first visible / total" mark that dims
  at each end. Without them, everything past the fold would be unreachable on a wall.
- **The ⌨ Search button** opens an on-page keypad — 0-9, A-Z and `_` (registry ids are full of them),
  with ⌫, **Clear** and **Done**. The real text field is still there and is the nicer control on a
  **pad** or the Runner's floating window, both of which *do* forward keystrokes; the field and the
  keypad show the same query and stay in sync in both directions.

## Requirements

1. **Refined Storage** installed, plus the **Silica Refined Storage integration** jar
   (`silica-refinedstorage-…jar`) in your `mods/` folder. Without the integration jar the network is
   invisible to Silica.
2. A **SilicaOS computer** — a computer with the **SilicaOS ROM + GPU + Web Display** components (the
   "smart" computer that boots the desktop), and the **Web Display** mod + **MCEF** installed.
3. A Silica **Port** mounted on (or beside) your RS **Controller**, wired into your computer's network:
   - Give the computer a **NIC** so it can network.
   - Run a **cable (Wire)** from the Port into the computer (or a Switch/Router it can reach). Adjacent
     placement also works.
   - The **`network`** capability door must be open (it is by default).

## How to run it

1. Open the **SilicaOS desktop** (right-click the smart computer).
2. Open **Folders**, find **`rs-terminal`**, and **Run** it (or use the **Runner** app and start
   `rs-terminal`).
3. To see the terminal, either:
   - **Stream it to a physical monitor** — screwdriver-name a Silica **Screen** (or Pad), then in the
     **Runner** point the process's monitor dropdown at that screen; or
   - Use the **Runner → View** button to open a floating window streaming the app.
4. If it says *"No Refined Storage network found,"* re-check the Port + cable + NIC wiring above.

## Where it lives

- On this instance: `silica/scripts/rs-terminal/` (this folder).
- It also ships **inside the Silica mod jar** as a seed app, so a fresh world gets it automatically.
- Files: `entrypoint.js` (server-side: discovers the network, polls it, validates every craft/cancel
  request) and `ui/index.html` + `ui/client.js` + `ui/style.css` (the page). Edit them here to customize;
  changes take effect the next time you Run the app.

## Notes

- **Item sprites:** CEF can't render Minecraft item textures, so every item/pattern/task gets an honest
  generated chip — a colour hashed from its registry id, with its initials on top (same convention as the
  Collector/Detector/rftp-grid seed apps).
- **The refresh runs on the server's own clock, not yours** — `entrypoint.js` re-reads the network once
  a second no matter how many people are watching, and answers a viewer's heartbeat from the snapshot it
  already built, spending no device calls at all. That matters because a peripheral read runs on the
  server **tick thread**: this app used to rebuild a snapshot for every message it received, so ten
  players looking at ten screens cost ten times the reads (the lesson that motivated the design — see
  `docs/phases/epic4-phase-1.md`). Search keystrokes are still debounced before a real read
  (`listItems` is the heavy call on a big network), and switching network / searching / crafting /
  cancelling always sweeps immediately, so intent never waits for the tick.
- **Ids only, not NBT-precise** — items are matched by registry id (`minecraft:diamond`-style); two
  stacks that differ only by data components (enchants, custom names, …) collapse to one row. This
  matches the adapter's own v1 ceiling (`docs/phases/epic4-phase-4.md`, E4-D27).
- This app never touches network item/fluid **extract/insert** I/O — it's a browse + autocraft terminal
  only. (The adapter itself does expose I/O verbs, for a script that wants to move items in/out of a
  chest; that's a job for a different script, not this dashboard.)
