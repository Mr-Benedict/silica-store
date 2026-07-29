# ejector — the buffer monitor that can push a button

A small Path-B (web UI) readout for a Silica **Ejector**, reached over the Silica network — its 27-slot
buffer, its output filter and facing, and its liquid tank — plus two controls the *server* performs on
the page's request.

Core-only, no integration jar. Sibling of `collector`: same shape, one step further.

## What it needs

1. A **smart computer** — SilicaOS ROM + GPU + web-display — with a **NIC**.
2. An **Ejector** wired to it: adjacent, or through a Switch / Router → Receiver.
3. With more than one Ejector on the network, screwdriver-label the one you want `ejector`; otherwise
   the app takes the first it finds.

Run it from the Runner and stream it to a named monitor, or open it on a pad or pocket computer.
Remember the Silica invariant: **unloaded = offline**, and an offline block shows as a reason card
rather than a stale list.

## What it shows and does

- **The buffer**, one row per filled slot: a generated item chip (CEF cannot reach the game's texture
  atlas, so the chip is a deterministic hue + the item's initials), the item name, the stack count.
- **The tank** — fluid name and fill bar. This is the only place in the seed suite that calls `tank()`.
  The tile always shows: `tank()` answers whether or not a Liquid Chip is installed, because filling
  from an external pump is not chip-gated — only placing a source block is (E3P3-D8) — so an
  ejector with no chip simply reads `0 / cap`.
- **The filter** — the block's whitelist/blacklist entries, as chips, plus which mode they mean.
- **Force eject** requests one eject cycle now, bypassing the interval timer and the redstone-disable
  gate. World logic still applies: a blocked face or a full target still refuses — and now *says so*.
- **Mode** flips whitelist ⇄ blacklist. The *entries* are not editable here — set those from the
  block's own config GUI.
- **The status card** at the foot of the sheet, the `detector` app's `st-lamp`/`st-txt` pattern: what the
  last button press did, or why it did nothing. `eject()` answers `{ejected, reason, item, action,
  contents}`, so the card can name the actual blocker — a full container, a blocked face, an empty
  buffer, a filter that excludes everything — instead of leaving the reason in the terminal log, which is
  a different screen from the panel that was tapped. It also covers the block going offline mid-action
  and a verb throwing, and it stays on screen while the offline card holds the sheet.

Both lists page with the ▲/▼ buttons. That is deliberate: a wall screen forwards only mouse press and
release — no wheel, no drag, no keys — so a list left to `overflow` scrolling is content nobody can
reach.

## What to read in the code

`collector` is the read-only half of this pattern; this is the half where a page **asks** and the
server decides.

- `entrypoint.js` → `handle(msg)` — the whole lesson. The page holds no authority: it sends
  `{action:"eject"}` or `{action:"config", mode}` and nothing more. The server re-resolves the device,
  checks it is real and online, checks the mode is one of exactly two strings, and only then calls the
  verb — inside a try/catch, because a refused verb is a status line, not the end of the app. Every one
  of those exits ends in `record()`, which is what puts the answer back on the sheet.
- `entrypoint.js` → `snapshot()` — all three reads are guarded together. `online` was true a moment
  ago, which is not a promise it still is; an unguarded call throws and takes the entire app down.
  This returns `{ok: false, reason}` and the page renders it as a card.
- `entrypoint.js` → the run loop — `os.pullEvent("web_message", waitSeconds())`, the **timed** form.
  The device is swept once per `SWEEP_MS` on the server's own clock; a viewer poll is answered from the
  cached snapshot with **zero** device calls; a button press is handled immediately and re-arms the
  clock, so it never waits for the next tick and never sweeps twice.
- `ui/client.js` → `pager()`, `renderList()`, `renderFilter()` — page buttons instead of scrollbars, a
  reused row pool for the buffer (every push would otherwise reset the scroll), and a signature
  rebuild for the filter chips, which change only when somebody edits the block.

## Capability doors

**network** (needs a NIC) + **ejector** (default-open) + **web** (needs web-display).
