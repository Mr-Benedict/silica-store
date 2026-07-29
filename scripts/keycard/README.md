# keycard — Access Control room

A SilicaOS **web dashboard** (Path B) for the Silica **Keycard Reader** + **Secure Door** system: it finds
every reader on the network, groups them by the door they drive, drives those doors, administers the card
roster — and keeps a **live access log** of every card swipe, granted *and* denied.

## What it shows and does

- **Door board** — one panel per door: a padlock that actually unlocks, the state word
  (`LOCKED` / `UNLOCKED` / `PAIRING` / `UNPAIRED`), whether the leaf is open, and a **LOCK / UNLOCK** pair
  (the `lock` / `unlock` verbs). If more than one door is reachable, a chip row at the top switches between
  them.
- **Auto-lock + auto-open** — `config`: the auto-lock delay as tappable presets (`never · 5s · 10s · 30s ·
  1m · 5m`, the same ladder the sneak+screwdriver gesture cycles) plus `−`/`+` steppers, and an
  **auto-open-on-unlock** toggle.
- **Readers on this door** — every reader in the group, each with its own state lamp, so you can see the
  two-readers-on-one-door build (one each side of the door) as one door.
- **Card roster** — every card enrolled *on the door* with its tier (**owner** / normal), owner/normal/total
  counts, and a per-card **REVOKE** button (`revoke`). The last owner card's button is disabled — revoking it
  would orphan the door, and the server refuses it anyway.
- **Access log** — the headline. Every `card_swipe` event: timestamp, **GRANT**/**DENY**, the card (or
  `blank card`), its tier, and which reader it happened at. Denied swipes and swipes at an **unbound** reader
  are logged too — that is the whole point of the event. Session counters for granted / denied / total, and a
  **CLEAR** button.
- **SITE LOCKDOWN** — one button, no confirm: locks every door this computer can drive.
- **Honest degradation** — if the **`security`** capability door is welded shut, or there is no NIC, or no
  reader is reachable, the page shows a full-sheet explanation instead of a dead board. A reader that
  **refuses this computer** (see below) is listed as `REFUSED` with the reason, not silently dropped.

## Requirements

1. A **SilicaOS computer** — a computer with the **SilicaOS ROM + GPU + HDD + Web Display** parts (the
   "smart" computer that boots the desktop), plus the **Web Display** mod and **MCEF** installed.
2. A **NIC** in that computer (the `network` capability), and at least one **Keycard Reader** in its network
   reach. A reader has **no wire socket** — it is wireless-only, so it must sit inside a **Router**'s radius
   (or be face-adjacent to the computer).
3. Each reader **bound to a Secure Door** — right-click the door with the reader item before placing it.
   An unbound reader still shows up (as `UNPAIRED`), and swipes at it still log, but there is nothing to
   drive.
4. **The reader must accept this computer.** A reader answers only (a) the computer it is explicitly bound
   to — right-click the computer while holding the reader **item** — or (b) a computer owned by the same
   player who placed the reader. Anything else is `REFUSED`. This is deliberate (E3P7-D12): otherwise a
   neighbour's script inside a shared router radius could unlock your door.
5. The **`security`** capability door must be open (it is by default). Welded shut, the verbs throw — but
   the physical card → reader → door path keeps working, and swipes are still logged.

## How to run it

1. Open the **SilicaOS desktop** (right-click the smart computer).
2. Open **Folders**, find **`keycard`**, and **Run** it (or use the **Runner** app and start `keycard`).
3. To see it, either **stream it to a physical monitor** (screwdriver-name a Silica **Screen** or **Pad**,
   then point the process's monitor dropdown at it in the Runner), or use the Runner's **View** button.
4. Walk up to a reader and swipe a card — accepted, then rejected. Both land in the access log within a
   tick, without the page polling for them.

## Where it lives

- On this instance: `silica/scripts/keycard/` (this folder).
- It also ships **inside the Silica mod jar** as a seed app, so a fresh world gets it automatically.
- Files: `entrypoint.js` (server-side: discovery, the verbs, the event loop, validation of every request)
  and `ui/index.html` + `ui/style.css` + `ui/client.js` (the page). Edit them here to customize; changes
  take effect the next time you Run the app.

## Notes

- **`card_swipe` is an event, not a poll.** The script's one event loop calls `os.pullEvent(null, seconds)`
  — no filter, so it takes whatever comes next — and branches on `ev.type`: `card_swipe` for the log,
  `web_message` for the page's requests. There is one event queue per script, so a second loop would just
  steal from the first.
- **The reader sweep runs on the server's own clock** (`SWEEP_MS`, one second). Reading a door's status is
  a `device.call`, which runs on the server tick thread — so bare page polls are answered from a cached
  snapshot with *zero* device calls, and four people watching the board cost exactly the same as one. A
  swipe or an operator action still lands immediately, with a fresh read behind it.
- **The log is a bounded ring** (60 entries, oldest dropped). Nothing unbounded may accumulate in a synced
  document.
- **Enrolment swipes are silent, by design.** Swiping a card at an *armed* reader enrols it and fires
  nothing — neither `accepted: true` ("the door opened", it didn't) nor `false` (which would trip every
  reject alarm on a legitimate new key) would be honest (E3P7-D10). So new keys appear in the **roster**,
  never in the log.
- **There is no `pair` verb, on purpose.** Minting a key stays a physical, owner-present act; a script that
  could authorize new cards would defeat the entire block. This app can only ever *reduce* access.
- **Doors are grouped authoritatively.** `status` reports the bound door's own `pos` + `dimension`
  (E3P7-D10), so several readers on one door (E3P7-D18) are always shown as one door — whatever their
  roster looks like, including an empty one.
- **Everything the page asks for is re-validated server-side**: the target must be a reader that is on the
  network right now, `autoLockSeconds` is clamped to `0..3600`, and a card must actually be on that door's
  roster before `revoke` is called.
- **Tap-only UI.** MCEF forwards no mouse wheel and wall screens are tap-only, so the roster and log page
  with explicit ▲/▼ buttons and the auto-lock uses steppers/presets rather than a slider (native drag
  doesn't survive the MC→CEF forwarding either).
