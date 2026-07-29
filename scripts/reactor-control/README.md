# reactor-control — Mekanism fission control room with RS fuel logistics

A multi-file Silica **Path B** app (real HTML/CSS/JS rendered by web-display). It is a bigger sibling of
`mek-plant`: the same P&ID drafting-sheet visual language, but built around **one question an operator
actually asks** — *how long can I keep running, and what stops me first?*

```
reactor-control/
  entrypoint.js      server-side: all capability access, all authority
  README.md          this file
  ui/index.html      the page
  ui/client.js       rendering + input
  ui/style.css       styling
```

## What it does

- **Reactors** — every Mekanism fission reactor on the Silica network: temperature, damage, actual burn
  rate vs. set point, boil efficiency, environmental loss, and all four tanks (fuel, coolant, heated
  coolant, waste) with percentages.
- **Turbines** — every Mekanism industrial turbine: production vs. max, steam flow, blade/coil/condenser/
  vent/disperser counts, dump mode, and the FE buffer.
- **Runway** — the headline number. How many seconds of burn are left in the reactor tanks, how many more
  the Refined Storage network can supply, and how long until the **waste tank fills and stalls the
  reactor** (a full waste tank stops a reactor just as dead as an empty fuel tank).
- **Grid flow** — measured FE/t going *into* the turbine buffers (`net`) and *out* to your power grid
  (`draw`), with time-to-empty / time-to-full, plus a strip recorder of temperature and production.
- **Fuel logistics** — reads the **fissile fuel your Refined Storage network is actually holding**, in mB.
  Not an estimate from precursors: one filtered `listChemicals` call, summed for the exact chemical id.
- **Safety interlock** — a server-side auto-scram with four trips (see below), armable/disarmable from
  the page, plus an alarm board and a rolling event log.

## Controls

| Control | Effect |
|---|---|
| Select reactor / turbine | Points the detail panel + controls at that device |
| Activate / Scram | On the selected reactor |
| **SCRAM ALL** | Scrams *every* online, formed, active reactor on the network |
| Burn ± / burn presets | Adjusts or sets the reactor's burn rate (server clamps to `0..maxBurnRate`) |
| Dump mode | Cycles the turbine `IDLE → DUMPING_EXCESS → DUMPING → IDLE` |
| Safety ARM / DISARM | Enables/disables the auto-scram interlock at runtime |

Every one of these is a *request*. The page holds no authority: the server re-resolves the target live,
confirms it is a real online device of the right kind, re-reads the authoritative current value, clamps,
and only then calls Mekanism. A refused call (e.g. "too hot to activate") is caught and shown as a status
line, never crashes the app.

## Hardware / setup

1. A **smart computer**: Computer Case assembled with motherboard + CPU + RAM + **GPU** + HDD, a
   **SilicaOS ROM** hot-plugged, the **web-display** jar installed (plus MCEF), and a **NIC** installed
   (the `network` capability door).
2. A **Silica Port** mounted on each **reactor** — on the Fission Reactor Logic Adapter, Casing, or Port.
3. A **Silica Port** mounted on each **turbine** — on the Turbine Valve, Casing, or Vent.
4. A **Silica Port** mounted on (or beside) your **Refined Storage Controller**.
5. **Wire** each Port to the computer — directly adjacent, or through a Switch / Router → Receiver. The
   cable *is* the permission gate; nothing else needs enabling.
6. Optional but recommended: screwdriver-**label** each Port so the board shows "Reactor A" / "Main
   Turbine" instead of raw device ids.

Only what is wired shows up. A device in an unloaded chunk reads as **offline** and is skipped (never
called) — that is a hard Silica invariant, not a bug.

**Mod jars required:** the Silica **Mekanism** integration jar (reactor + turbine adapters) and the Silica
**Refined Storage** integration jar. The RS jar must be **new enough to expose the `listChemicals` verb** —
that is how the fissile-fuel reserve is read. On an older jar (or a network with no chemical storage) the
RS panel shows the reason instead of a reserve, the reserve reads **0**, and everything else — reactors,
turbines, grid, interlock, in-reactor fuel runway — keeps working normally.

## Running it

From the SilicaOS desktop:

1. **Folders** → the `reactor-control` folder appears with `entrypoint.js` inside it.
2. **Runner** → launch `reactor-control`.
3. Pick a destination:
   - **A named monitor** — screwdriver-label a Silica Screen multiblock, then choose it from the Runner's
     monitor dropdown. The board renders on the wall and takes touch (right-click with an empty hand).
   - **The Runner's "view" window** — a resizable floating window on the desktop.
   - **A Pad or Pocket computer** bound to this computer.

The server rebuilds and publishes its authoritative snapshot once a second on **its own clock** — with a
hundred viewers, one, or none (see *Sweep cadence* below). Every viewer therefore sees the same numbers,
and the board is already up to date the moment you open it.

## Tunable config (top of `entrypoint.js`)

```js
var FUEL_CHEMICAL = "mekanism:fissile_fuel";   // read live from RS
```

**`FUEL_CHEMICAL`** — the registry id of the chemical your reactors burn. The server sends its path
(`fissile_fuel`) to RS as a case-insensitive substring filter, so the *network* does the filtering, then
sums only the rows whose id matches this **exactly**. Point it somewhere else if your pack's reactors burn
something else. One call per RS refresh; never an unfiltered listing.

**Safety limits:**

```js
var SAFETY_ENABLED = true;
var SAFETY = { coolantMinPct: 50, damageMaxPct: 10, wasteMaxPct: 90, turbineEnergyMaxPct: 99 };
```

Any one of these breaching **scrams every active reactor** on the network. `SAFETY_ENABLED` is only the
boot default — the page's ARM/DISARM button changes it at runtime.

> **Deliberately NOT a trip: an empty fuel tank.** Mekanism just idles a reactor with nothing to burn.
> It is not a hazard, it damages nothing, and scramming would only force you to walk over and
> re-activate once fuel arrives. That case raises a `warn` **alarm** instead.

**Sweep cadence:**

```js
var SWEEP_MS = 1000;          // one authoritative device sweep per second, viewer or no viewer
var RS_REBUILD_EVERY = 5;     // Refined Storage read: at most every 5th Mekanism sweep
```

> **The interlock runs on the server's clock, not on yours.** The loop waits with
> `os.pullEvent("web_message", seconds)`, which returns `null` on timeout, so it keeps its own deadline.
> This is the whole point of the design: a `web_message` only exists while some player's browser is
> running this page, so the older `os.pullEvent("web_message")` parked **forever** in an empty world and
> took the auto-scram interlock down with it. That is not a hypothetical — a reactor melted down while
> its operator was in the Nether. The interlock's *state* was server-authoritative; its *cadence* was
> borrowed from the client.

A peripheral `device.call` runs on the server tick thread, so over-calling stalls the whole server (also a
real, previously-shipped incident). `SWEEP_MS` is the throttle, and it is a **fixed** rate: the sweep is
the only thing that calls devices, viewer polls are answered from cache and cost nothing, so ten people
watching costs exactly what nobody watching costs. Raise it if you have many devices or a busy server —
that also lengthens the worst-case interlock latency, which is one sweep. A control action always forces
an immediate fresh rebuild regardless, so pressing a button still feels instant.

Other knobs: `RATE_FLOOR_MS` / `RATE_CEIL_MS` / `RATE_EMA` / `RATE_DEADBAND` (turbine rate smoothing),
`ALARM_CAP`, `LOG_CAP` (display caps), `NOCLOCK_SWEEP_EVERY` (a defensive fallback that never fires in
practice — see `HAS_CLOCK`).

## What is measured vs. derived

Be clear about which numbers are arithmetic and which are inferred from a trend:

**Exact — deterministic tick math, no guessing.**
Burn rate is mB per *tick* and Minecraft runs 20 ticks per second, so
`fuelSeconds = tankMb / burnRate / 20` and `wasteSeconds = wasteHeadroom / burnRate / 20` are simply
arithmetic on values the reactor itself reports. They assume the burn rate holds — change it and the
runway changes with it.

**Exact — a real reading, not an estimate.**
The **RS reserve** is the actual amount of `FUEL_CHEMICAL` in your storage network, in mB, read straight
out of it. So the "fuel with RS reserve" runway is exact tick math too: `(tank + reserve) / burnRate / 20`.
Two caveats that are about *logistics*, not accuracy: the app cannot see whether your fuel line is
actually delivering (an unpowered pipe or a full input tank still shows the reserve you own), and it reads
only the **first online RS network** it finds on the Silica network.

**Measured — settles over a couple of seconds, noisy right after a change.**
The turbine **charge/draw rate** — `net`, `draw`, time-to-empty, time-to-full, and the plant-bus versions
of the same — is derived by differencing the FE buffer against real wall-clock time (`Date.now()`),
converting to FE per tick, and smoothing with an EMA. Consequences worth knowing:

- The very first frame after launch (or after a turbine comes back online) shows `—`: there is no
  previous sample to difference against yet.
- After a big load change — a quarry starting, an induction matrix filling — the number takes a few
  seconds to walk to its new value. That is the smoothing doing its job, not a stale reading.
- Values under ±0.5 FE/t are clamped to zero so a perfectly balanced grid reads a steady `0` instead of
  flickering.
- `draw` is `production − net`, i.e. *inferred* from the buffer trend, not read from a meter. It is the
  right number for "is my grid keeping up", not for accounting to the last FE.
- **A sample spanning more than `RATE_CEIL_MS` (5× the sweep period) is thrown away**, and the rate falls
  back to `—` for one cycle rather than publishing a number derived across the gap. Differencing assumes
  regular samples; under the old viewer-driven loop the first sample after an absence spanned the *entire*
  absence, so returning after an hour away showed an hour-wide average dressed up as a live FE/t — a wrong
  number at exactly the moment you were checking whether anything had gone wrong. The server clock makes
  that mostly moot, but a lag spike or a long sweep can still stretch a window, and a blank readout is a
  better answer than a plausible-looking false one.
