# detector — PERIMETER, the entity-detector watch board

A Path-B (web UI) perimeter watch board for Silica **Entity Detectors**, reached over the Silica
network. Sibling sheet to `builder-control` / `geo-prospector` / `reactor-control`: same drafting
language, same server-authoritative model.

Core-only — no integration jar. It needs `web-display` for the UI, and a NIC on the computer.

Unlike the other monitor sheets, this one **acts**: an armed alert drives a redstone face (and,
optionally, a network broadcast) from the trip condition, evaluated on the **server's own clock**. It
keeps working with nobody watching and nobody in the dimension.

## What it shows

Per selected Detector:

- **A detector-centred radar** (XZ, top-down) — every contact plotted from its own `dx`/`dz` offset,
  three range rings with the unit's **configured range as the outer ring**, and — while the alert is
  live — a dashed **alert ring** at the trip distance. Blips are coloured hostile / friendly / player.
  The detector scans a **box**, so a corner contact is legitimately farther than the range: those
  blips are clamped to the rim rather than drawn outside the dish.
- **Counts by class** — detected, hostile, friendly, players — and the two nearest readouts (nearest
  hostile, nearest anything).
- **The contact list**, nearest-first: name, dX, dZ, distance.
- **The unit's own live config** — its four filter categories and its scan range, both editable here.
- **OUT** — the redstone level the block is emitting. **Derived, not measured** (see below).

Across the board: total contacts, total hostiles, how many Detectors are online, and how many blocks
are currently emitting redstone.

The **alert card** shows the trip state (clear / tripped / holding), the ring, the face and level the
line is driving, the hold window, and how many contacts are inside the ring right now.

## Controls

Every control is a **tap** — no drag, no scroll wheel, no hover-only affordance. MCEF forwards
neither a wheel event nor a reliable drag, and a wall screen is tap-only.

- **Selector chips** at the top of the WATCH card switch between Detectors (shown only when two or
  more are on the board). **Selection is per-viewer and client-side** — the server deliberately holds
  no selection, so two people can watch different gates on the same board at the same time.
- **Filter** — four toggles (mob / player / friendly / enemy) retuning the selected Detector.
  Emptying the filter is allowed and makes the block **blind**; the board raises an alarm saying so.
- **Range** — `−` / `+` steppers, plus a tappable track for a big jump. Every value is reachable from
  the steppers alone.
- **Trip ring** — `−` / `+` steppers for the alert distance. The middle cell cycles the **step size**
  (±1 / ±2 / ±4 blocks), because stepping 1→24 by ones is 23 taps on a wall screen.
- **WATCH** cycles what counts as a contact (hostile / player / any), **FACE** cycles which face of
  the computer carries the alert line, **BCAST** toggles the network broadcast.
- **ARM / DISARM** — the master switch. One tap, no confirmation.
- **CLEAR LOG** empties the event log.

Alarms and the event log both wrap and page with the ▲/▼ buttons, as does the contact list. The
buttons are the only scrolling that works on every surface.

**The board never retunes a Detector on its own.** The alert is the one thing it acts on, and only
once you arm it.

## Alarms

- No Detector on the network at all.
- A pinned Detector that is offline (chunk unloaded / block removed) or not found on the network.
- A scan read that threw.
- An **empty filter** — the block matches nothing and will never report a contact.
- A hostile inside the trip ring, and players in range while the trip mode watches players.
- The cross-check that matters most here: **the alert is armed against something the watched
  Detector's own filter can never report.** The trip mode and the filter live on different blocks, so
  an alert can sit armed for weeks against a filter that cannot feed it.
- The alert's redstone face refusing the write (`redstone.setOutput` threw) — that degrades to an
  alarm rather than killing the board.

## Hardware / setup

1. A **smart computer** — SilicaOS ROM + GPU + web-display — with a **NIC**.
2. Each **Entity Detector** wired to that computer: adjacent, or through a Switch / Router →
   Receiver.
3. Optionally screwdriver-label each Detector; the label becomes its name on the board.
4. If you arm the alert, wire whatever should react to `ALERT_SIDE` of **the computer** (not of the
   Detector — the Detector's own output is its unfiltered "something is in range" signal).

Remember the hard Silica invariant: **unloaded = offline.** A Detector in an unloaded chunk drops off
the network and its card goes offline. Turn on the `chunkLoading` config if you want a remote gate
camera to stay live.

## Running it

Open the Runner, launch `detector`, and stream it to a named monitor — or view it on a pad or pocket
computer. Both halves reload only on a fresh start, so restart the process after editing.

## Tunable config (top of `entrypoint.js`)

- `DETECTORS` — pin specific Detectors by screwdriver label or device id. Left **empty** it
  auto-discovers every `detector` on the network. When you *do* list names, each one always renders a
  card — as *offline* when unreachable — so a chunk-unloaded gate camera never silently vanishes off
  the board. A pinned name must match the label or id exactly.
- `SWEEP_MS` (1000) — one authoritative device sweep per second, viewer or no viewer. A bare poll from
  a viewer is answered from the cached snapshot with **zero** device calls, so the number of people
  looking cannot move the device-call rate. The Detector block scans on its own clock
  (`detectorScanInterval`, 10 ticks by default) and `scan()` hands back that cache, so sweeping faster
  than the block scans buys nothing but tick-thread load.
- `NOCLOCK_SWEEP_EVERY` (2) — the fallback cadence if `Date.now()` is ever unavailable.
- `ALERT_ARMED` (false) / `BROADCAST_ARMED` (false) — the starting state of the two alert outputs.
  Both off by default: an app that starts hot would surprise whatever is already wired to the
  computer.
- `ALERT_SIDE` ("down") — which face of **this computer** carries the alert line.
- `ALERT_TRIP` ("hostile") — what counts as a contact: `hostile` | `player` | `any`.
- `ALERT_DIST` (8) — the ring, in blocks, measured from each Detector.
- `ALERT_HOLD_SEC` (5) — how long the line stays hot after the last contact leaves the ring. Without
  it the output chatters on every sweep as a mob steps across the boundary.
- `BROADCAST_MIN_SEC` (10) — while a trip is held, re-broadcast at most this often. The rising and
  clearing edges are always sent.
- `ALARM_CAP` (8) / `LOG_CAP` (14) / `UNIT_ENTITY_CAP` (48) / `FLEET_ENTITY_CAP` (120) — display caps.
  Counts and the trip are always computed from the **full** scan; only the rows you can read are
  trimmed, and the number dropped is published so the sheet can say "+17 more".

Everything on the snapshot rides the wire on every push, which is why the row caps exist: the app
state is bounded by the `[display] appStateMaxChars` knob (the arithmetic lives in
`silica.net.WireBudget`).

## What is measured vs. derived

Almost everything on the sheet is read straight off the device — the filtered scan (`scan`) and the
block's own filter + range (`config`), one call each per unit per sweep. Two things are not, and both
are labelled as such wherever they appear:

- **OUT, the redstone level.** No verb reports the block's own output, so the board derives it from
  the same rule the block uses: **15 while the filtered scan is non-empty, else 0**. It is a faithful
  mirror of the block's logic, not a reading of the block's state.
- **Arrivals and departures.** Entity records carry **no stable id** — two Zombies are
  indistinguishable between sweeps — so the diff is a **multiset diff by entity name**: "+2 Zombie,
  −1 Creeper". A Zombie that despawns while another walks in reads as **no change**, and a contact
  that has stood still for ten minutes is indistinguishable from one that just arrived.

For the same reason there is **no dwell time and no closing rate** anywhere on this sheet. Both need
per-entity identity across sweeps, this device cannot provide it, and a derived reading that looks
measured is worse than no reading at all. They were cut deliberately, not forgotten.

One more honest caveat: a record's `dist` is the **3-D** distance, while the radar is the **XZ**
projection. A mob directly above the Detector plots at the centre with a non-zero distance — the
distance column in the contact list is what disambiguates it.

## Notes

- All capability access is server-side. The page holds no authority: it only *requests* actions, and
  every request is re-validated against a real, **online** `detector` — re-resolved live on each
  request — before anything happens.
- The run loop uses the **timed** `os.pullEvent("web_message", seconds)` form on purpose. A
  `web_message` exists only while some player's browser is running the page, so the untimed form
  parks forever in an empty world and the alert would only ever fire while somebody happened to be
  looking at it. Server-authoritative *state* is not the same as server-authoritative *cadence*.
- Capability doors used: **network** (needs a NIC) + **detector** + **web** — and **redstone** only
  once you arm the alert, because the script never touches a face before then.
