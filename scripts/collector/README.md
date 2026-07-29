# collector — the buffer monitor

A small Path-B (web UI) readout for a Silica **Collector**, reached over the Silica network: what is in
its 27-slot buffer, right now, on a screen or a pad — without walking over and opening the block's GUI.

Core-only, no integration jar. Display only: it never retunes the block.

## What it needs

1. A **smart computer** — SilicaOS ROM + GPU + web-display — with a **NIC**.
2. A **Collector** wired to it: adjacent, or through a Switch / Router → Receiver.
3. With more than one Collector on the network, screwdriver-label the one you want `collector`;
   otherwise the app takes the first it finds.

Run it from the Runner and stream it to a named monitor, or open it on a pad or pocket computer.
Remember the Silica invariant: **unloaded = offline**, and an offline block shows as a reason card
rather than a stale list.

## What it shows

The buffer, one row per filled slot: a generated item chip (CEF cannot reach the game's texture atlas,
so the chip is a deterministic hue + the item's initials — an honest stand-in, not a sprite), the item
name, and the stack count. The header carries `used / 27`, the block's filter mode and its range.

The list pages with the ▲/▼ buttons. That is deliberate: a wall screen forwards only mouse press and
release — no wheel, no drag, no keys — so a list left to `overflow` scrolling is content nobody can
reach.

## What to read in the code

This is the **read-only half** of the peripheral pattern; `ejector` next door is the half that acts.

- `entrypoint.js` → `findCollector()` — discovery by `kind`, with a screwdriver label winning. Re-run
  every sweep, so replacing the block or reloading its chunk fixes itself.
- `entrypoint.js` → `snapshot()` — the whole point: `dev.call(...)` is **inside a try/catch**. `online`
  was true a moment ago, which is not a promise it still is; an unguarded call throws and takes the
  entire app down. This returns `{ok: false, reason}` and the page renders it as a card.
- `entrypoint.js` → the run loop — `os.pullEvent("web_message", waitSeconds())`, the **timed** form. The
  device is read once per `SWEEP_MS` on the server's own clock; a viewer poll is answered from the
  cached snapshot with **zero** device calls, so ten people watching cost exactly what one costs.
- `ui/client.js` → `pager()` and `renderList()` — page buttons instead of scrollbars, and a reused row
  pool instead of `innerHTML = ""`, which would throw the reader back to the top once a second.

## Capability doors

**network** (needs a NIC) + **web** (needs web-display). The collector adds no door of its own — item
movement lives under `network` (E3-D4).
