# rftp-grid — RFTools Power grid monitor

A SilicaOS **web dashboard** (Path B) that shows live telemetry from your **RFTools Power** blocks —
power-cell / dimensional-cell network totals and generator output — read over the Silica network.
It is **read-only** (a monitor, not a controller).

## What it shows

- **Networks** — one card per power network (deduped, so a 30-block power-cell wall is one card):
  - **PowerCell networks:** total stored / capacity + fill bar, cell count, and **live in/out FE/t**
    (derived by differencing the network's cumulative counters — it settles after a second or two).
  - **Dimensional Cell networks:** total stored / capacity, block counts (simple / advanced),
    cross-dimension **cost factor**, and **live in/out FE/t** (real per-tick values).
- **Generators** — one card each for **Endergenic** (rf/t, charge phase, yield / lost power, pearls),
  **Coal** (rf/t, working, remaining burn) and **Blazing** (rf/t, working, lit slots).

## Requirements

1. **RFTools Power** installed, plus the **Silica RFTools Power integration** jar
   (`silica-rftoolspower-…jar`) in your `mods/` folder. Without the integration jar the blocks are
   invisible to Silica.
2. A **SilicaOS computer** — a computer with the **SilicaOS ROM + GPU + Web Display** components
   (the "smart" computer that boots the desktop), and the **Web Display** mod + **MCEF** installed
   (needed to render any web UI).
3. Each RFTools Power block you want to read must have a Silica **Port** mounted on it, and that Port
   must be **wired into your computer's network**:
   - Give the computer a **NIC** so it can network.
   - Run a **cable (Wire)** from the block's Port into the computer (or a Switch/Router the computer
     can reach). Adjacent placement also works.
   - The **`network`** capability door must be open (it is by default; check
     `config/silica-server.toml` if nothing shows up).
   *(A single Port on any one cell of a network is enough — the app reads the whole-network total from
   it. You don't need a Port on every cell.)*

## How to run it

1. Open the **SilicaOS desktop** (right-click the smart computer).
2. Open **Folders**, find **`rftp-grid`**, and **Run** it (or use the **Runner** app and start
   `rftp-grid`).
3. To see the dashboard, either:
   - **Stream it to a physical monitor** — screwdriver-name a Silica **Screen** (or Pad), then in the
     **Runner** point the process's monitor dropdown at that screen; or
   - Use the **Runner → View** button to open a floating window streaming the app.
4. The dashboard auto-discovers every reachable `rftools_*` device and updates about once a second.
   If it says *"No RFTools Power blocks on the network,"* re-check the Port + cable + NIC wiring above.

## Where it lives

- On this instance: `silica/scripts/rftp-grid/` (this folder).
- It also ships **inside the Silica mod jar** as a seed app, so a fresh world gets it automatically.
- Files: `entrypoint.js` (the server-side script that discovers devices and polls them) and
  `ui/index.html` + `ui/client.js` + `ui/style.css` (the page). Edit them here to customize; changes
  take effect the next time you Run the app.

## Notes

- **Read-only by design** — RFTools Power's Silica integration exposes telemetry only, so this app
  never starts/stops or reconfigures anything.
- It **sweeps gently** (one status read per device per second, `SWEEP_MS` at the top of `entrypoint.js`)
  on purpose; don't crank the interval down — peripheral reads run on the server tick thread and
  hammering them can lag the server. The sweep runs on the *server's* clock, not on page polls, so a
  second person opening the board costs nothing extra — and the measured FE/t stays the same number for
  everyone, which it did not when the sample interval came from the polls.
- **Both card columns are paged** with ▲/▼ buttons and a "first visible / total" mark. A wall screen
  forwards only mouse press and release — no wheel, no drag — so without them everything past the first
  screenful of cards would be unreachable there.
