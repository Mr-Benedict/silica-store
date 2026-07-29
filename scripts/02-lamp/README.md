# 02-lamp — a redstone pulser

Drives one face on and off forever, on a period you set: a software clock with no repeater loop to build
and no observer trick, where the timing is one number you edit. Good for a lamp, a dispenser, a piston
door, or a farm on a duty cycle.

With a GPU it also draws a lamp indicator that lights with the face. Without one the redstone still works
and it says so once.

## What it needs

1. Nothing beyond a working computer — the `redstone` door needs no part and is open by default.
2. Put the computer next to whatever you want to pulse, and set `SIDE` to face it.

## Settings

| constant | default | what it does |
|---|---|---|
| `SIDE` | `"north"` | which face to drive: `north` `south` `east` `west` `up` `down` |
| `ON_SEC` | `1` | seconds the face stays powered |
| `OFF_SEC` | `1` | seconds it stays off |
| `LEVEL` | `15` | redstone level while on, 0–15 (a comparator can read the difference) |
| `CYCLES` | `0` | how many on/off pairs to run; `0` = forever |
| `LOG_EVERY` | `0` | print a line every N cycles; `0` = stay quiet after the banner |

## Notes

Sleeps round to whole game ticks, minimum one, so anything under 0.05 s becomes a single tick — twenty
on/off pairs a second is as fast as this can go.

`os.sleep` parks the script off the compute budget, so the loop is idle between edges rather than
spinning; a `while (true)` with no sleep or `pullEvent` in it would be killed by the per-tick budget
within a tick. And when `CYCLES` is set, the face is left **cold** at the end rather than however it
happened to finish.
