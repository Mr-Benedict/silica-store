# 01-welcome — the hardware and network self-test

Start here. It reports which of this computer's **capability doors** are open, which part each closed one
wants and what installing it unlocks, what is reachable on the network, and which of the other seven
starter scripts you can run right now. With a GPU it draws the same report as a card on the screen, then
parks so the report stays up.

Read-only. It drives no redstone, writes no files, and changes nothing.

## What it needs

Nothing. This is the one script that runs on a bare **motherboard + CPU + RAM** — every door it reports on
is probed, so a missing part costs you a line of the report rather than the script.

## Settings

| constant | default | what it does |
|---|---|---|
| `DEVICE_CAP` | `12` | list at most this many devices, then summarise the rest |

## Notes

The `probe()` helper at the top is the pattern the whole starter suite uses. A door you lack is not a
missing global — it is a stub that **throws on every access**, with a message naming the part it wants. So
the honest way to ask "do I have a GPU?" is to try it and catch, which is why every script here loses a
feature instead of dying when a part is absent.

It ends on an unfiltered `os.pullEvent()`, which blocks until something — anything — happens and costs no
CPU meanwhile. That is how a finished script stays on screen without spinning.
