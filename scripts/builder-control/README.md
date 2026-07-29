# builder-control — RFTools Builder excavation control room

A Path-B (web UI) control room for **RFTools Builders** — quarries, void miners, pumps and shape
builders — reached over the Silica network through a mounted **Port**. Sibling sheet to
`reactor-control`: same drafting language, same server-authoritative model.

Needs the optional **`silica-rftoolsbuilder`** integration jar (and RFTools Builder itself).

## What it shows

Per selected Builder:

- **Excavation progress** — percent complete, layers cut / total, layers left, and the current bench Y.
- **A measured ETA.** The adapter exposes no rate field, so the server times how long each Y-layer
  actually takes (wall clock, EMA-smoothed) and reports `layersLeft x secPerLayer`.
- **Two survey plots** — a PLAN (XZ) view with a 16-block chunk grid, the swept area tinted, the
  Builder's own position, and the scan cursor as a crosshair; and a SECTION (Y) view drawn as a mine
  survey — cut layers voided above the working face, untouched rock hatched below, the cutting face a
  labelled bright rule.
- **Power** — buffer percent, measured net FE/t (charging vs. draining, derived by differencing the
  buffer over wall clock), and a runway to empty.
- **The whole work region** — min/max, W x H x D, block volume, scan cursor, offset, dimension.
- **Shape card, redstone mode, all six flags, and `lastError`.**

Across the fleet: units running, mean progress, the slowest unit's ETA, combined FE/t, and a strip
recorder tracing fleet progress and net power over time.

## Controls

- **START / STOP / RESTART** on the selected unit. `start` sets redstone mode to *ignored* (runs
  whenever powered); `stop` sets *on-required* and clears the power input; `restart` rescans from the
  top. A script and a physical redstone setup on the same Builder can fight — last writer wins.
- **RS** cycles the redstone mode explicitly (ignored -> on-required -> off-required) for setups that
  want to cooperate with wiring instead.
- **Flags** — a six-cell toggle grid: silent, support, entity, loop, wait, hilight.
- **STOP ALL / START ALL** — the master trip, sweeping every unit on the board.
- **Selector chips** at the top of the UNIT card switch between Builders (shown only when two or more
  are on the board).

There is **no automatic control** — this app never starts or stops a Builder on its own. Stalls,
errors and low buffers raise alarms; acting on them is yours.

## Alarms

Low buffer (critical under `LOW_BUF_PCT`, warning under 25%), a stalled unit (scan cursor frozen for
`STALL_SEC` while enabled), the Builder's own `lastError`, no shape card while enabled, an offline
pinned unit, and the cross-check that matters most on a long dig: **the buffer empties before the job
finishes** (power runway shorter than the ETA).

Alarms and the event log both wrap and page with the up/down buttons — wall screens are tap-only and
MCEF does not forward a scroll wheel, so the buttons are the only scrolling that works everywhere.

## Hardware / setup

1. A **smart computer** — SilicaOS ROM + GPU + web-display — with a **NIC**.
2. A Silica **Port** mounted on each RFTools Builder, wired to that computer (adjacent, or through a
   Switch / Router -> Receiver).
3. Optionally screwdriver-label each Port; the label becomes the unit's name on the board.

Remember the hard Silica invariant: **unloaded = offline.** A Builder in an unloaded chunk drops off
the network. Turn on the `chunkLoading` config if you want a remote quarry to stay visible.

## Running it

Open the Runner, launch `builder-control`, and stream it to a named monitor — or view it on a pad or
pocket computer. Both halves reload only on a fresh start, so restart the process after editing.

## Tunable config (top of `entrypoint.js`)

- `BUILDERS` — pin specific Builders by screwdriver label or device id. Left **empty** it
  auto-discovers every `rftools_builder` on the network. When you *do* list names, each one always
  renders a card — as *offline* when unreachable — so a chunk-unloaded quarry never silently
  vanishes. A pinned name must match the label or id exactly.
- `STALL_SEC` (90) — how long the scan cursor may sit still before a unit reads as stalled.
- `LOW_BUF_PCT` (5) — the critical buffer threshold.
- `SWEEP_MS` (1000) — the server's own clock: exactly one Builder sweep per second, whether four people
  are watching the board or nobody is. Bare polls are answered from the cached snapshot with **zero**
  device calls. A `device.call` runs synchronously on the server tick thread, so this is what keeps a
  fast poll (or a fourth viewer) from stalling the server — and it is what makes the measured rates
  below independent of viewer count.
- `NOCLOCK_SWEEP_EVERY` (2) — defensive fallback if `Date.now()` were ever unavailable: sweep every 2nd
  message instead of on the clock.
- `RATE_FLOOR_MS` / `RATE_EMA` / `RATE_DEADBAND` — sampling floor and smoothing shared by both derived
  rates (seconds-per-layer and FE/t).
- `ALARM_CAP` (12) / `LOG_CAP` (14).

## What is measured vs. derived

Everything on the sheet comes from `getStatus` except three things the adapter cannot report, which
this script derives on the server from wall-clock differencing:

- **seconds per layer** (and from it the ETA) — by watching `currentLevel` fall,
- **net FE/t** (and from it the power runway) — by differencing `energy.stored`,
- **stall time** — by watching the scan cursor stand still.

All three need two samples before they read anything, so they show `measuring...` briefly after start.

## Notes

- The adapter's own `progress` is layer-based and clamps to `[0,1]`, which would make a Builder that
  has never swept read as 100% done. This script range-checks `currentLevel` against the work region
  and publishes "no reading" instead.
- The within-layer fraction blended into the progress bar is an X-major raster **estimate**, for a
  smooth bar only — it never feeds the rate or the ETA.
- All capability access is server-side. The page holds no authority: it only requests actions, and
  every request is re-validated against a real, online `rftools_builder` before anything happens.
